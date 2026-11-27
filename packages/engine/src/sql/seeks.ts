import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type CreateView,
	type Delete,
	type Expr,
	type FromItem,
	type FromSource,
	type NameKey,
	nameKey,
	type OperandBody,
	type OperandSelect,
	type PlStatement,
	type SelectCore,
	type SqlStatement,
	selectNames,
	type WindowSpec,
	type Update,
	type With
} from "#compiler/sql/ast.ts"
import { printedOnce } from "#compiler/sql/print-once.ts"
import {
	identityHooks,
	inertVisitor,
	transformStatement,
	visitLevelExpr,
	visitSelect
} from "#compiler/sql/transform.ts"

/**
 * What a statement seeks, read off the statement as printed and before any installation exists: its seek program, the
 * levels of its queries and data-modifying statements as data (`seekProgram`), which the missed-index check runs at the
 * installation's indexes once they are planned (`runSeeks`; physical/access/seeks.ts judgeSeeks, README "Keys and
 * indexes"). An installation's statements, a login's served reads and its compiled writes are each read so, by one walk,
 * and judged by one run: a write is compiled before the installation it is served beside plans its indexes, and its
 * served form keeps no AST, so it keeps its program, which names tables and columns alone.
 *
 * What a statement binds is read level by level, as PostgreSQL resolves its names, every simple sub-query pulled up as
 * PostgreSQL pulls it up (sql/print-once.ts printedOnce):
 * - a column of a stored table read at a level is bound where an equality of its WHERE, or of a join's ON, holds it at
 *   a value that level fixes: a parameter, a literal, a column of an enclosing level or of an item a LATERAL item stands
 *   after, a sub-link that reads no column of the level's items (each a parameter of the level's plan), or a column of
 *   an item of the level that reads one row, a table whose bound columns hold a unique index's, a probe of a key; and
 *   every column equal to a bound one is bound;
 * - a sub-query of a FROM that PostgreSQL does not pull up takes the equalities over its output columns into each core
 *   it reads, where PostgreSQL pushes them (allpaths.c subquery_push_qual): a core with no LIMIT or OFFSET, at a
 *   column it delivers as itself, a grouped core at a column it groups by, and a core that calls a window function at a
 *   column every window partitions by;
 * - a probe and a met row (sql/ast.ts FromSource `probe`, `met`) bind the columns they seek by, and their filters'
 *   equalities.
 * Which item reads one row through a unique index is the installation's to say, and which relation is a view, so the
 * program holds each level's equalities and the classes of columns they make equal, and the run closes them over the
 * items the installation's unique indexes make single, each view read as the derived table PostgreSQL expands it into
 * (SeekReading, SeekView): the walk reads no table, and the run reads no statement. A role reads every relation through
 * its view (physical/ddl/names.ts roleReadNames), a plain one PostgreSQL pulls up into the reader's statement and a
 * security barrier one it pushes the reader's leakproof quals into, so every read and write a login serves is judged
 * at the tables its views read.
 *
 * An equality between two items of one level that neither fixes is a join PostgreSQL orders by its estimates, whose
 * probe side's index the extraction asks for on its own (a join partner's context), and binds nothing here; nor does a
 * statement that reads what it reads whole, once (`wholeReads`, `keyedReads`): a stored derived relation's fill, and a
 * data step's re-check, its refills and its checks over every row (sql/ast.ts PlStatement `wholeReads`).
 */

/** A seek a probe or a met row makes where it stands: its table and the columns it seeks by. */
export interface DirectSeek {
	readonly table: NameKey
	readonly bound: ReadonlyArray<string>
}

/**
 * An item of a level as a seek reads it, by its place among the level's: a relation the installation names, a stored
 * table or a view, which the run tells apart (SeekReading); a driven read of one row or of a group; a derived table,
 * with its query's program, which the level's equalities over its outputs reach; or rows no index serves.
 */
export type SeekItem =
	| { readonly kind: "stored"; readonly table: NameKey }
	| { readonly kind: "driven"; readonly oneRow: boolean }
	| { readonly kind: "derived"; readonly query: SeekQuery }
	| { readonly kind: "other" }

/**
 * What an equality's other side reads of its level: the items it reads, by their places, none for a parameter, a
 * literal, an outer column or a sub-link that reads none of them, fixed where each of them reads one row, and the items
 * of enclosing levels whose columns it reads, by their aliases, the rows a probe of it joins; or a query correlated with
 * them, whose correlation PostgreSQL may plan as a join, which fixes it nowhere.
 */
export type EqualTo =
	| {
			readonly kind: "items"
			readonly items: ReadonlyArray<number>
			readonly outer: ReadonlyArray<string>
	  }
	| { readonly kind: "query" }

/** An equality of a level: a column of its item at `item`, of the class `cls`, equal to what `to` reads. */
export interface SeekEquality {
	readonly item: number
	readonly column: string
	readonly cls: number
	readonly to: EqualTo
}

/**
 * A range of a level: a column of its item at `item` held above or below, or between, what `to` reads, a comparison of
 * its WHERE or of a join's ON; a seek that binds the item's other columns by equality reads it as the next column of its
 * index, one descent and a scan of that column's range (`levelRun`).
 */
export interface SeekRange {
	readonly item: number
	readonly column: string
	readonly to: EqualTo
}

/** A column of a level's item: the item's place, the column's name, and its class among the level's columns. */
export interface LevelColumn {
	readonly item: number
	readonly column: string
	readonly cls: number
}

/**
 * One level of a statement: its items, the equalities over them, each column in the class of the columns the level's
 * equalities make equal to it, and the seeks its probes and met rows make where they stand.
 */
export interface SeekLevel {
	readonly items: ReadonlyArray<SeekItem>
	readonly equalities: ReadonlyArray<SeekEquality>
	readonly ranges: ReadonlyArray<SeekRange>
	readonly direct: ReadonlyArray<DirectSeek>
}

/**
 * A core of a query read as a derived table: its level, and each output of the query a reader's equality reaches its
 * rows at, by the output's name, with the level's column it delivers as itself (none past a LIMIT or an OFFSET, in a
 * grouped core only its grouping columns, and in a core that calls a window function only the columns every window
 * partitions by).
 */
export interface SeekCore {
	readonly level: SeekLevel
	readonly accepts: ReadonlyArray<{ readonly name: string } & LevelColumn>
}

/** A query read as a derived table: each of its cores, a set operation's arms' every one. */
export type SeekQuery = ReadonlyArray<SeekCore>

/**
 * What a set of statements seeks (see the header): every level of theirs read at no reader's binding, each query's
 * read as a derived table inside the level that reads it.
 */
export type SeekProgram = ReadonlyArray<SeekLevel>

/** A column a level's item delivers, by the item's alias and the column's name there. */
const refKey = (alias: string, column: string): string => `${alias}\u0000${column}`

/** An equality of a level's conditions: a column of one of its items, equal to an expression. */
interface Equality {
	readonly alias: string
	readonly column: string
	readonly to: Expr
}

/** The conjuncts of a condition, each AND's arguments in turn. */
const conjuncts = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined ? [] : e.kind === "and" ? e.args.flatMap(conjuncts) : [e]

/** A column reference an equality's side is, through a collation, which keeps the column's order. */
const columnOf = (e: Expr): { readonly table: string; readonly column: string } | undefined => {
	if (e.kind === "collate") {
		return columnOf(e.expr)
	}
	return e.kind === "column" && e.table !== undefined
		? { table: e.table, column: e.column }
		: undefined
}

/**
 * The equalities of `conditions` over the items `aliases` names, each side a column of one of them where it is one: an
 * equality, a membership in a list, and a comparison with any element of an array. An equality qualified by its
 * operator's schema is one too: the one grizzle prints is pgvector's `=`, `OPERATOR("vector_ext".=)`
 * (lower/conservative/vector, and write/probe.ts amongHeld over a vector key), the equality of its type's default
 * B-tree class (vector_ops, pgvector 0.8.7), which a key over the vector serves, so a read of a key's vector at a value
 * binds it as any key's column is bound.
 */
const equalitiesOf = (
	conditions: ReadonlyArray<Expr>,
	aliases: ReadonlySet<string>
): ReadonlyArray<Equality> =>
	conditions.flatMap((c): ReadonlyArray<Equality> => {
		const side = (column: Expr, to: Expr): ReadonlyArray<Equality> => {
			const ref = columnOf(column)
			return ref !== undefined && aliases.has(ref.table)
				? [{ alias: ref.table, column: ref.column, to }]
				: []
		}
		if (c.kind === "binary") {
			return c.op === "=" ? [...side(c.left, c.right), ...side(c.right, c.left)] : []
		}
		if (c.kind === "inList") {
			return c.not ? [] : side(c.expr, { kind: "row", items: c.list })
		}
		return c.kind === "equalsAny" ? side(c.expr, c.array) : []
	})

/** The comparisons PostgreSQL reads as a B-tree's range of one column, `<`, `<=`, `>` and `>=` (and BETWEEN's two). */
const rangeOperators: ReadonlySet<string> = new Set(["<", "<=", ">", ">="])

/**
 * The ranges of `conditions` over the items `aliases` names (SeekRange), each side of a comparison a column of one of
 * them where it is one, held against the other: an ordering comparison, and a BETWEEN's column against its two bounds.
 */
const rangesOf = (
	conditions: ReadonlyArray<Expr>,
	aliases: ReadonlySet<string>
): ReadonlyArray<Equality> =>
	conditions.flatMap((c): ReadonlyArray<Equality> => {
		const side = (column: Expr, to: Expr): ReadonlyArray<Equality> => {
			const ref = columnOf(column)
			return ref !== undefined && aliases.has(ref.table)
				? [{ alias: ref.table, column: ref.column, to }]
				: []
		}
		if (c.kind === "binary") {
			return rangeOperators.has(c.op) && c.schema === undefined
				? [...side(c.left, c.right), ...side(c.right, c.left)]
				: []
		}
		return c.kind === "between" && !c.not
			? side(c.expr, { kind: "row", items: [c.low, c.high] })
			: []
	})

/** Whether a query reads a column of an item `aliases` names, at any depth: a sub-link correlated with them. */
const correlated = (query: OperandSelect, aliases: ReadonlySet<string>): boolean => {
	let found = false
	visitSelect(query, {
		...inertVisitor,
		expr: (x) => {
			if (x.kind === "column" && x.table !== undefined && aliases.has(x.table)) {
				found = true
			}
		}
	})
	return found
}

/**
 * The items of a level whose columns an expression reads, none for one it reads none of; a sub-link correlated with
 * them, whose correlation PostgreSQL may plan as a join, reads every item. A sub-link that reads no column of the
 * level's items is a value the level fixes, as an outer column is: PostgreSQL runs it once, before the level's scan, as
 * an InitPlan whose result is a parameter of the level's plan (one correlated with an enclosing level alone runs as a
 * SubPlan at each of that level's rows, a parameter here alike), so an equality with it, `k = ANY (ARRAY(SELECT ...))`
 * among them, is an index condition, as a write's restriction to the keys of the rows it holds is (write/probe.ts
 * amongHeld).
 */
const itemsRead = (e: Expr, aliases: ReadonlySet<string>): ReadonlySet<string> | "every" => {
	const read = new Set<string>()
	const correlations: Array<Expr> = []
	visitLevelExpr(e, (x) => {
		if (x.kind === "column") {
			if (x.table !== undefined && aliases.has(x.table)) {
				read.add(x.table)
			}
			return
		}
		if (
			(x.kind === "exists" ||
				x.kind === "subquery" ||
				x.kind === "array" ||
				x.kind === "inQuery") &&
			correlated(x.query, aliases)
		) {
			correlations.push(x)
		}
	})
	return correlations.length > 0 ? "every" : read
}

/** The items of enclosing levels whose columns an expression reads at its own level, by their aliases: none of `aliases`. */
const outerRead = (e: Expr, aliases: ReadonlySet<string>): ReadonlyArray<string> => {
	const read = new Set<string>()
	visitLevelExpr(e, (x) => {
		if (x.kind === "column" && x.table !== undefined && !aliases.has(x.table)) {
			read.add(x.table)
		}
	})
	return [...read]
}

/** Whether an expression reads none of the items `aliases` names, nor any query that could. */
const readsNone = (e: Expr, aliases: ReadonlySet<string>): boolean => {
	const read = itemsRead(e, aliases)
	return read !== "every" && read.size === 0
}

/** The windows an expression's window function calls read its level's rows by: each call's OVER. */
const windowsOf = (e: Expr): ReadonlyArray<WindowSpec> => {
	const found: Array<WindowSpec> = []
	visitLevelExpr(e, (x) => {
		if (x.kind === "call" && x.over !== undefined) {
			found.push(x.over)
		}
	})
	return found
}

/** The sources of a FROM list, each join chain's in its order, with the conditions of its joins. */
const sourcesOf = (
	from: ReadonlyArray<FromItem>
): { readonly sources: ReadonlyArray<FromSource>; readonly on: ReadonlyArray<Expr> } => {
	const sources: Array<FromSource> = []
	const on: Array<Expr> = []
	for (const item of from) {
		if (item.kind !== "joins") {
			sources.push(item)
			continue
		}
		sources.push(item.first)
		for (const step of item.steps) {
			sources.push(step.source)
			if (step.kind !== "cross") {
				on.push(step.on)
			}
		}
	}
	return { sources, on }
}

/** A core as the query it is alone. */
const queryOf = (body: OperandBody): OperandSelect => ({
	kind: "select",
	with: undefined,
	body,
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/** Every UPDATE and DELETE a statement runs: itself, its WITH's, and those a PL/pgSQL body runs. */
const dmlOf = (statement: SqlStatement): ReadonlyArray<Update | Delete> => {
	const out: Array<Update | Delete> = []
	const withs = (w: With | undefined): void => {
		for (const c of w?.ctes ?? []) {
			if (c.query.kind === "update" || c.query.kind === "delete") {
				out.push(c.query)
			}
			if (c.query.kind !== "select") {
				withs(c.query.with)
			}
		}
	}
	/** The statements a PL/pgSQL body runs: each data-modifying one, and those of every branch and loop body. */
	const pl = (body: ReadonlyArray<PlStatement>): void => {
		for (const p of body) {
			if (p.kind === "modify") {
				dml(p.statement)
			} else if (p.kind === "if") {
				for (const b of p.branches) {
					pl(b.body)
				}
				pl(p.else)
			} else if (p.kind === "case") {
				for (const w of p.whens) {
					pl(w.body)
				}
			} else if (p.kind === "forQuery" || p.kind === "whenFound" || p.kind === "wholeReads") {
				pl(p.body)
			}
		}
	}
	const dml = (s: SqlStatement): void => {
		if (s.kind === "update" || s.kind === "delete") {
			out.push(s)
		}
		if (
			s.kind === "update" ||
			s.kind === "delete" ||
			s.kind === "insert" ||
			s.kind === "merge" ||
			s.kind === "select"
		) {
			withs(s.with)
		}
		if (s.kind === "createFunction" && s.language === "plpgsql") {
			pl(s.body.body)
		}
	}
	dml(statement)
	return out
}

/**
 * The statements whose query no call and no write runs at a binding: a stored derived relation's table, created WITH NO
 * DATA, its fill, every row of its definition once in the migration that creates it, and a role relation's view, which
 * a reader reads through its definition at the reader's own binding. Each reads what it reads whole.
 */
const wholeReads: ReadonlySet<SqlStatement["kind"]> = new Set([
	"createStoredTable",
	"fillStored",
	"createView"
])

/**
 * What of `statement` reads keyed, each seek bounded by the keys a write touches: none of a statement that reads what it
 * reads whole (`wholeReads`); a PL/pgSQL function without the whole reads its body states (PlStatement `wholeReads`),
 * none where it states nothing else; any other statement whole. A whole read stands at its function's body's top, as
 * the re-check states its own (physical/ddl/recheck.ts); one nested under a statement of the body is walked as keyed
 * reads are, judged where it need not be, never spared where it must be.
 */
const keyedReads = (statement: SqlStatement): SqlStatement | undefined => {
	if (wholeReads.has(statement.kind)) {
		return undefined
	}
	if (statement.kind !== "createFunction" || statement.language !== "plpgsql") {
		return statement
	}
	const [first, ...rest] = statement.body.body.filter((p) => p.kind !== "wholeReads")
	return first === undefined
		? undefined
		: { ...statement, body: { ...statement.body, body: [first, ...rest] } }
}

/** The WITH of a data-modifying statement, whose CTEs no query of it carries. */
const dmlWith = (statement: SqlStatement): With | undefined =>
	statement.kind === "insert" ||
	statement.kind === "update" ||
	statement.kind === "delete" ||
	statement.kind === "merge"
		? statement.with
		: undefined

/**
 * The CTEs of the WITHs `withs` PostgreSQL inlines into each query that reads them, by name, their queries: each query
 * CTE marked NOT MATERIALIZED of a WITH that is not RECURSIVE (subselect.c SS_process_ctes, inline_cte), which a
 * reader's quals reach as a derived table's do. One left unmarked PostgreSQL inlines by its volatility and its readers'
 * count, which no statement states, so it is read where it stands, once, at no reader's binding, as a MATERIALIZED one
 * is.
 */
const inlinedCtes = (withs: ReadonlyArray<With | undefined>): ReadonlyMap<string, OperandSelect> =>
	new Map(
		withs.flatMap((w) =>
			w === undefined || w.recursive
				? []
				: w.ctes.flatMap((c) =>
						c.materialized === "NOT MATERIALIZED" && c.query.kind === "select"
							? [[c.name, c.query] as const]
							: []
					)
		)
	)

/** A level's item as the walk reads it: its alias, what the program holds of it (SeekItem), and the seeks it makes
 * where it stands, a probe's and a met row's. */
interface Walked {
	readonly alias: string
	readonly item: SeekItem
	readonly direct: ReadonlyArray<DirectSeek>
}

/** Whether a level seeks anything: a stored table it reads, a derived table whose query seeks, or a direct seek. */
const seeking = (level: SeekLevel): boolean =>
	level.direct.length > 0 ||
	level.items.some(
		(i) =>
			i.kind === "stored" || (i.kind === "derived" && i.query.some((core) => seeking(core.level)))
	)

/** The walk of a set of statements into their program (see the header), each query walked once. */
class SeekWalk {
	/** The queries walked, each as a derived table its reader pushes its equalities into, or as one of its own. */
	readonly #walked = new Set<OperandSelect>()
	/** The CTEs of the statement being walked that PostgreSQL inlines into their readers (`inlinedCtes`), by name. */
	#inlined: ReadonlyMap<string, OperandSelect> = new Map()

	/**
	 * Every query and data-modifying statement of `statement`, each level once: a query read as a derived table inside
	 * the level that reads it, every other one, a sub-link's, a CTE's and a function's, at no reader's binding.
	 */
	statement(statement: SqlStatement): ReadonlyArray<SeekLevel> {
		const keyed = keyedReads(statement)
		if (keyed === undefined) {
			return []
		}
		const queries = this.enter(keyed)
		return [...this.rest(queries), ...dmlOf(keyed).map((d) => this.dml(d))].filter(seeking)
	}

	/** Every query of `statement`, its CTEs', sub-links' and functions' among them, the CTEs it inlines read off them. */
	enter(statement: SqlStatement): ReadonlyArray<OperandSelect> {
		const queries: Array<OperandSelect> = []
		transformStatement(statement, {
			...identityHooks,
			select: (s, original) => {
				queries.push(original)
				return s
			}
		})
		this.#inlined = inlinedCtes([dmlWith(statement), ...queries.map((q) => q.with)])
		return queries
	}

	/** Each of `queries` not walked yet, each core's level at no reader's binding: a statement's sub-links', its CTEs'
	 * and its functions' queries, each derived table inside the level that reads it, and each CTE it inlines inside each
	 * level that reads it alone. */
	rest(queries: ReadonlyArray<OperandSelect>): ReadonlyArray<SeekLevel> {
		const inlined = new Set(this.#inlined.values())
		const levels: Array<SeekLevel> = []
		for (const q of queries.toReversed()) {
			if (!this.#walked.has(q) && !inlined.has(q)) {
				for (const core of this.query(q)) {
					levels.push(core.level)
				}
			}
		}
		return levels.filter(seeking)
	}

	/** A query, whose outputs a LIMIT or an OFFSET keeps every reader's equality out of. */
	query(q: OperandSelect): SeekQuery {
		this.#walked.add(q)
		const cores = this.body(q.body)
		return q.limit !== undefined || q.offset !== undefined
			? cores.map((core) => ({ level: core.level, accepts: [] }))
			: cores
	}

	/** A query body: a core, each arm of a set operation at the outputs its position holds, or a query. */
	body(body: OperandBody): SeekQuery {
		switch (body.kind) {
			case "core":
				return [this.core(body)]
			case "setOp": {
				const names = selectNames(queryOf(body))
				return body.arms.flatMap((arm) => {
					const query = arm.kind === "select" ? arm : queryOf(arm)
					const own = selectNames(query)
					return this.query(query).map((core): SeekCore => ({
						level: core.level,
						accepts: core.accepts.flatMap((a) =>
							own.flatMap((name, at) => {
								const n = names[at]
								return name === a.name && n !== undefined ? [{ ...a, name: n }] : []
							})
						)
					}))
				})
			}
			case "select":
				return this.query(body)
		}
	}

	/**
	 * A core: its FROM's items read at its WHERE and its joins' conditions, and each output a reader's equality reaches
	 * its rows at, a column of an item it delivers as itself: a grouped core's grouping column, and in a core that calls
	 * a window function a column every window partitions by, a qual of which keeps each partition whole (allpaths.c
	 * check_output_expressions, targetIsInAllPartitionLists): an attachment's take ranked by row_number() per partition
	 * of its input, read at the partition its parent row binds, is read at that partition's rows alone.
	 */
	core(core: SelectCore): SeekCore {
		const { sources, on } = sourcesOf(core.from)
		const grouping = core.groupBy.flatMap((g) => {
			const c = columnOf(g)
			return c === undefined ? [] : [refKey(c.table, c.column)]
		})
		const windows = core.targets.flatMap((t) => windowsOf(t.expr))
		const partitioned = (key: string): boolean =>
			windows.every((w) =>
				w.partitionBy.some((e) => {
					const c = columnOf(e)
					return c !== undefined && refKey(c.table, c.column) === key
				})
			)
		return this.level(
			sources.map((s) => this.itemOf(s)),
			[...conjuncts(core.where), ...on.flatMap(conjuncts)],
			core.targets.flatMap((t) => {
				const name = t.alias ?? (t.expr.kind === "column" ? t.expr.column : undefined)
				const c = columnOf(t.expr)
				return name !== undefined &&
					c !== undefined &&
					(core.groupBy.length === 0 || grouping.includes(refKey(c.table, c.column))) &&
					partitioned(refKey(c.table, c.column))
					? [{ name, alias: c.table, column: c.column }]
					: []
			})
		)
	}

	/** An UPDATE's or a DELETE's target read beside its FROM's or USING's items at its WHERE. */
	dml(d: Update | Delete): SeekLevel {
		const { sources, on } = sourcesOf(d.kind === "update" ? d.from : d.using)
		const target: Walked = {
			alias: d.alias,
			item:
				typeof d.table === "string"
					? { kind: "other" }
					: { kind: "stored", table: nameKey(d.table) },
			direct: []
		}
		return this.level(
			[target, ...sources.map((s) => this.itemOf(s))],
			[...conjuncts(d.where), ...on.flatMap(conjuncts)],
			[]
		).level
	}

	/** A FROM source as a level's item; a probe's and a met row's seeks where they stand. */
	itemOf(s: FromSource): Walked {
		switch (s.kind) {
			case "table":
				return {
					alias: s.alias,
					item:
						typeof s.table === "string"
							? { kind: "other" }
							: { kind: "stored", table: nameKey(s.table) },
					direct: []
				}
			case "probe": {
				const inner = new Set([s.inner])
				const bound = new Set([
					...s.by.columns.map((c) => c.column),
					...equalitiesOf(s.filter.flatMap(conjuncts), inner).flatMap((e) =>
						readsNone(e.to, inner) ? [e.column] : []
					)
				])
				return {
					alias: s.alias,
					item: { kind: "driven", oneRow: s.by.kind !== "group" },
					direct: [{ table: nameKey(s.table), bound: [...bound] }]
				}
			}
			case "met":
				return {
					alias: s.alias,
					item: { kind: "driven", oneRow: true },
					direct: [{ table: nameKey(s.table), bound: s.key.map((k) => k.column) }]
				}
			case "derived":
				return {
					alias: s.alias,
					item: { kind: "derived", query: this.query(s.query) },
					direct: []
				}
			case "cte": {
				const inlined = this.#inlined.get(s.name)
				return {
					alias: s.alias ?? s.name,
					item:
						inlined === undefined
							? { kind: "other" }
							: { kind: "derived", query: this.query(inlined) },
					direct: []
				}
			}
			case "metRows":
			case "transition":
			case "enclosing":
			case "function":
			case "arrays":
			case "values":
			case "context":
				return { alias: s.alias, item: { kind: "other" }, direct: [] }
		}
	}

	/**
	 * A level of `walked` read at `conditions`, its reader's equalities reaching it at `outputs`: each equality over its
	 * items with the class of columns the level's equalities make its column equal to, and each output a reader reaches
	 * at a column of one of its items.
	 */
	level(
		walked: ReadonlyArray<Walked>,
		conditions: ReadonlyArray<Expr>,
		outputs: ReadonlyArray<{
			readonly name: string
			readonly alias: string
			readonly column: string
		}>
	): SeekCore {
		const places = new Map<string, number>()
		walked.forEach((w, at) => {
			if (!places.has(w.alias)) {
				places.set(w.alias, at)
			}
		})
		const aliases = new Set(places.keys())
		const equalities = equalitiesOf(conditions, aliases)
		const ranges = rangesOf(conditions, aliases)
		const parent = new Map<string, string>()
		const find = (k: string): string => {
			const p = parent.get(k)
			if (p === undefined || p === k) {
				return k
			}
			const root = find(p)
			parent.set(k, root)
			return root
		}
		for (const e of equalities) {
			const other = columnOf(e.to)
			if (other !== undefined && aliases.has(other.table)) {
				parent.set(find(refKey(e.alias, e.column)), find(refKey(other.table, other.column)))
			}
		}
		const classes = new Map<string, number>()
		const clsOf = (alias: string, column: string): number =>
			classes.getOrInsertComputed(find(refKey(alias, column)), () => classes.size)
		/** The place of an item the level's equalities and outputs name, each one of its aliases. */
		const placeOf = (alias: string): number =>
			defined(places.get(alias), `the item ${alias} of the level its equality names`)
		/** What the other side of an equality or a range reads of the level (EqualTo). */
		const toOf = (to: Expr): EqualTo => {
			const read = itemsRead(to, aliases)
			return read === "every"
				? { kind: "query" }
				: { kind: "items", items: [...read].map(placeOf), outer: outerRead(to, aliases) }
		}
		return {
			level: {
				items: walked.map((w) => w.item),
				equalities: equalities.map((e): SeekEquality => ({
					item: placeOf(e.alias),
					column: e.column,
					cls: clsOf(e.alias, e.column),
					to: toOf(e.to)
				})),
				ranges: ranges.map((r): SeekRange => ({
					item: placeOf(r.alias),
					column: r.column,
					to: toOf(r.to)
				})),
				direct: walked.flatMap((w) => w.direct)
			},
			accepts: outputs.flatMap((o) =>
				places.has(o.alias)
					? [
							{
								name: o.name,
								item: placeOf(o.alias),
								column: o.column,
								cls: clsOf(o.alias, o.column)
							}
						]
					: []
			)
		}
	}
}

/**
 * The program of `statements` (see the header), each as it is printed (sql/print-once.ts printedOnce, made once for the
 * print to read too), each query walked once among them all.
 */
export const seekProgram = (statements: Iterable<SqlStatement>): SeekProgram => {
	const walk = new SeekWalk()
	const out: Array<SeekLevel> = []
	for (const s of statements) {
		for (const level of walk.statement(printedOnce(s))) {
			out.push(level)
		}
	}
	return out
}

/**
 * A view of the installation as its reader reads it, which PostgreSQL expands into the reader's statement: its query,
 * its outputs by the view's own column names, read as a derived table at the reader's binding; the levels of its
 * sub-links and CTEs, read at no binding of its reader's; and whether it stands behind a security barrier.
 */
export interface SeekView {
	readonly query: SeekQuery
	readonly own: SeekProgram
	readonly barrier: boolean
}

/**
 * What a run reads of the installation: the view a relation's name names, none for a stored table; whether a stored
 * table read at the columns `bound` reads one row, some unique index of it holding only columns of `bound`; and whether
 * PostgreSQL's equality on a column of a stored table is leaky, no qual of it pushed past a security barrier
 * (allpaths.c qual_is_pushdown_safe, contain_leaked_vars): numeric's (numeric_eq is not leakproof, where int4eq, texteq,
 * uuid_eq, biteq and the rest a B-tree compares are).
 */
export interface SeekReading {
	readonly view: (table: NameKey) => SeekView | undefined
	readonly unique: (table: NameKey, bound: ReadonlySet<string>) => boolean
	readonly leaky: (table: NameKey, column: string) => boolean
}

/**
 * A seek a program makes of a stored table: the table, the columns it binds, never none, and for each the items of the
 * enclosing levels whose columns the value it is bound at reads, by their aliases, the rows a probe joins (none for a
 * parameter, a literal, a column of its own level or a column its reader pushes into it).
 */
export interface Seek {
	readonly table: NameKey
	readonly bound: ReadonlySet<string>
	readonly against: ReadonlyMap<string, ReadonlySet<string>>
	/**
	 * The column the seek reads a range of past its bound ones, where it reads one: a range of the level over a column of
	 * the table it binds no equality of, held at a value the level fixes (SeekRange), the least such column by name where
	 * it holds several, which its one index holds next, after the bound columns.
	 */
	readonly range: string | undefined
}

/** What meets each seek a program makes (Seek). */
export type SeekMet = (seek: Seek) => void

/** The program of a view (SeekView), from its CREATE VIEW as printed: its query's cores with each output by the
 * view's column at its position, and the levels of its query's sub-links and CTEs. */
export const seekView = (view: CreateView): SeekView => {
	const printed = printedOnce(view)
	if (printed.kind !== "createView") {
		defect("a CREATE VIEW prints as itself")
	}
	const walk = new SeekWalk()
	const queries = walk.enter(printed)
	const own = selectNames(printed.query)
	const query = walk.query(printed.query).map((core): SeekCore => ({
		level: core.level,
		accepts: core.accepts.flatMap((a) =>
			own.flatMap((name, at) => {
				const column = printed.columns[at]
				return name === a.name && column !== undefined ? [{ ...a, name: column }] : []
			})
		)
	}))
	return { query, own: walk.rest(queries), barrier: printed.barrier }
}

/** Whether a reader's equality on the output `name` of `query` is leaky (SeekReading `leaky`), at any core that
 * delivers it: a stored table's column, or a derived table's or a view's output, read through. */
const queryLeaks = (query: SeekQuery, name: string, reading: SeekReading): boolean =>
	query.some((core) =>
		core.accepts.some((a) => {
			const item = core.level.items[a.item]
			return a.name === name && item !== undefined && itemLeaks(item, a.column, reading)
		})
	)

/** Whether a reader's equality on the column `column` of a level's item `item` is leaky (`queryLeaks`). */
const itemLeaks = (item: SeekItem, column: string, reading: SeekReading): boolean => {
	switch (item.kind) {
		case "stored": {
			const view = reading.view(item.table)
			return view === undefined
				? reading.leaky(item.table, column)
				: queryLeaks(view.query, column, reading)
		}
		case "derived":
			return queryLeaks(item.query, column, reading)
		case "driven":
		case "other":
			return false
	}
}

/** The outputs of `view` a reader fixing `names` pushes into it: every one, but past a security barrier the leaky. */
const pushedInto = (
	view: SeekView,
	names: ReadonlySet<string>,
	reading: SeekReading
): ReadonlySet<string> =>
	view.barrier ? new Set([...names].filter((n) => !queryLeaks(view.query, n, reading))) : names

/**
 * A level's closure at the columns `pushed` its reader fixes (the header): the classes each equality fixes and the items
 * that read one row, a driven one of a row, a stored table `reading` reads one row of at its bound columns, or a view
 * that reads one row there, closed over each other; and each item's bound columns.
 */
const closure = (
	level: SeekLevel,
	pushed: ReadonlyArray<LevelColumn>,
	reading: SeekReading
): {
	readonly single: ReadonlySet<number>
	readonly fixed: ReadonlySet<number>
	readonly boundOf: (item: number) => ReadonlySet<string>
} => {
	const single = new Set(
		level.items.flatMap((i, at) => (i.kind === "driven" && i.oneRow ? [at] : []))
	)
	const fixed = new Set(pushed.map((p) => p.cls))
	const boundOf = (item: number): ReadonlySet<string> =>
		new Set([
			...level.equalities.flatMap((e) => (e.item === item && fixed.has(e.cls) ? [e.column] : [])),
			...pushed.flatMap((p) => (p.item === item ? [p.column] : []))
		])
	/** Whether the stored item `table` at `at` reads one row at its bound columns. */
	const oneRow = (table: NameKey, at: number): boolean => {
		const view = reading.view(table)
		return view === undefined
			? reading.unique(table, boundOf(at))
			: viewOneRow(view, pushedInto(view, boundOf(at), reading), reading)
	}
	for (let changed = true; changed;) {
		changed = false
		for (const e of level.equalities) {
			if (
				!fixed.has(e.cls) &&
				(single.has(e.item) || (e.to.kind === "items" && e.to.items.every((i) => single.has(i))))
			) {
				fixed.add(e.cls)
				changed = true
			}
		}
		level.items.forEach((i, at) => {
			if (i.kind === "stored" && !single.has(at) && oneRow(i.table, at)) {
				single.add(at)
				changed = true
			}
		})
	}
	return { single, fixed, boundOf }
}

/** Whether a view read at its outputs `names` reads one row: a query of one core every item of which reads one row
 * there. */
const viewOneRow = (view: SeekView, names: ReadonlySet<string>, reading: SeekReading): boolean => {
	const [core, ...others] = view.query
	if (core === undefined || others.length > 0 || core.level.items.length === 0) {
		return false
	}
	const { single } = closure(
		core.level,
		core.accepts.filter((a) => names.has(a.name)),
		reading
	)
	return core.level.items.every((_, at) => single.has(at))
}

/**
 * The outputs a reader fixes of a derived table or a view it reads, each with the items of enclosing levels the value it
 * fixes it at reads (Seek `against`).
 */
type Pushed = ReadonlyMap<string, ReadonlySet<string>>

/** Each seek of a query read as a derived table whose outputs `pushed` its reader fixes, each core at those it
 * accepts. */
const queryRun = (query: SeekQuery, pushed: Pushed, reading: SeekReading, met: SeekMet): void => {
	for (const core of query) {
		levelRun(
			core.level,
			core.accepts.flatMap((a) => {
				const against = pushed.get(a.name)
				return against === undefined ? [] : [{ column: a, against }]
			}),
			reading,
			met
		)
	}
}

/**
 * Each seek of a level whose columns `pushed` its reader fixes (the header): its direct seeks; then, its closure taken,
 * each stored table's bound columns, each view read as the derived table it expands into at the outputs the level fixes,
 * a barrier's leakproof ones alone, and each derived table read at its outputs fixed; each column with the enclosing
 * items its value reads, its reader's for a column its reader fixes.
 */
const levelRun = (
	level: SeekLevel,
	pushed: ReadonlyArray<{ readonly column: LevelColumn; readonly against: ReadonlySet<string> }>,
	reading: SeekReading,
	met: SeekMet
): void => {
	for (const d of level.direct) {
		if (d.bound.length > 0) {
			met({
				table: d.table,
				bound: new Set(d.bound),
				against: new Map(d.bound.map((c) => [c, new Set<string>()] as const)),
				range: undefined
			})
		}
	}
	const { single, fixed, boundOf } = closure(
		level,
		pushed.map((p) => p.column),
		reading
	)
	/** Each bound column of the item at `at` with the enclosing items its values read, at its equalities and its push. */
	const againstOf = (at: number): Pushed => {
		const out = new Map<string, Set<string>>(
			[...boundOf(at)].map((c) => [c, new Set<string>()] as const)
		)
		for (const e of level.equalities) {
			const own = out.get(e.column)
			if (e.item === at && own !== undefined && fixed.has(e.cls) && e.to.kind === "items") {
				for (const alias of e.to.outer) {
					own.add(alias)
				}
			}
		}
		for (const p of pushed) {
			const own = out.get(p.column.column)
			if (p.column.item === at && own !== undefined) {
				for (const alias of p.against) {
					own.add(alias)
				}
			}
		}
		return out
	}
	for (const [at, i] of level.items.entries()) {
		switch (i.kind) {
			case "stored": {
				const view = reading.view(i.table)
				const against = againstOf(at)
				if (view !== undefined) {
					runSeeks(view.own, reading, met)
					const passed = pushedInto(view, new Set(against.keys()), reading)
					queryRun(view.query, new Map([...against].filter(([c]) => passed.has(c))), reading, met)
				} else if (against.size > 0) {
					const [range] = level.ranges
						.flatMap((r) =>
							r.item === at &&
							!against.has(r.column) &&
							r.to.kind === "items" &&
							r.to.items.every((x) => x !== at && single.has(x))
								? [r.column]
								: []
						)
						.toSorted(compareStrings)
					met({ table: i.table, bound: new Set(against.keys()), against, range })
				}
				continue
			}
			case "derived":
				queryRun(i.query, againstOf(at), reading, met)
				continue
			case "driven":
			case "other":
				continue
		}
	}
}

/** Every seek `program` makes (see the header), the installation read as `reading` says, each met by `met`. */
export const runSeeks = (program: SeekProgram, reading: SeekReading, met: SeekMet): void => {
	for (const level of program) {
		levelRun(level, [], reading, met)
	}
}
