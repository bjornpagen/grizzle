/**
 * The physical binding: the one pass that turns a statement as the lowering and the builders state it, its reads
 * logical (FromSource `table`, the WHERE and ON its levels state), into the statement PostgreSQL is sent, every read of a
 * stored relation stating how it is reached, and the plan (sql/plan.ts ReadPlan) the same pass proved, whose advice
 * (sql/advice.ts) holds PostgreSQL to it. Logical reads, then the logical rewrites (sql/print-once.ts printedOnce, the
 * CTEs PostgreSQL inlines printed in place and the sub-queries it pulls up flattened, and sql/print.ts foldedCore, the
 * pass-through projections folded), then this pass, then codegen: the bound statement (`BoundStatement`) is the only
 * form anything prints or plans from, and no analysis reads a binding back off printed SQL.
 *
 * Level by level, as PostgreSQL plans them, each read of a stored table becomes:
 * - a seek (FromSource `read`, LevelAccess `seek`): bound by equalities to values its level fixes, a parameter, a
 *   literal, a PL variable, a column of an enclosing level, and past them by the one range of the least column it
 *   orders against such a value (`<`, `<=`, `>=`, `>`), its request's key after the fixed ones; each moved out of the
 *   level's WHERE or ON into the read, and printed back as one of its level's conjuncts, where PostgreSQL makes it an
 *   index condition of its scan;
 * - a probe (FromSource `probe`): bound by an equality to a column of an earlier item of its level, a keyed read of a
 *   second relation, printed `LATERAL (SELECT … WHERE <bindings> LIMIT 1 | OFFSET 0)`, which PostgreSQL never
 *   flattens, so every bound column is an index condition, never a join filter (CARRY-THE-PLAN finding 5);
 * - a whole read (`read`, `whole`): no binding, or one of columns of few values alone, a roster's share of the rows;
 * - a write's target bound by another item of its statement: read at the tuple id a probe of it at that binding found
 *   (`tid`), sound where its relation is insert-only or every writer of it runs SERIALIZABLE, which the certifier's
 *   law of tid targets holds (analysis/isolation/certify.ts).
 * Every other item of a level (a derived table, a CTE's scan, a function's, arrays' or VALUES rows) is planned apart
 * under its alias: a derived table PostgreSQL would pull up is fenced (OFFSET 0), each conjunct of its reader that reads
 * it beside values its place fixes, and that its query takes, pushed into it first, which binds its reads where it
 * fixes their columns. Every sublink and every set operation's arm reads its relations through one item of its own, its
 * whole query a derived table fenced the same way, so no target names a level PostgreSQL names itself (`exists_N`,
 * `expr_N`, `array_N`, `any_N`, `setop_N`). Every alias is minted again from the advice scope (sql/naming.ts
 * AdviceScope). A statement that reads what it reads whole, once (a stored relation's fill, a data step's re-check),
 * joins its reads by hash, each read whole or at the values it fixes, never by a probe per row.
 *
 * The pass is total and exact: it changes no result, and every binding it moves into a read node is an equality that
 * was in a WHERE or an ON. A read it cannot classify is an internal compiler error.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import { defaultOpclass } from "#compiler/ir/law.ts"
import type { AccessIndexRequest, AccessUse } from "#compiler/ir/products.ts"
import {
	builtinFunctions,
	bodyPositionNames,
	type CreateFunction,
	type Cte,
	type CteBody,
	type Delete,
	type DrivenColumn,
	type Expr,
	type FromItem,
	type FromSource,
	type Insert,
	isSetQuery,
	isValuesTarget,
	type JoinStep,
	type Merge,
	type NameKey,
	nameKey,
	type OperandBody,
	type OperandSelect,
	overRowsOf,
	type PlBlock,
	type PlStatement,
	type ObjectName,
	type ProbeBy,
	type ProbeColumn,
	returnsSet,
	type SeekBinding,
	type Select,
	type SelectCore,
	type SetOperand,
	type SqlStatement,
	selectColumns,
	type TypeRef,
	type Update,
	type With
} from "#compiler/sql/ast.ts"
import {
	builtinType,
	col,
	conjunction,
	derived,
	eq,
	keyedRead,
	lit,
	operandSelect,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { type Alias, type AdviceScope, namedQuery } from "#compiler/sql/naming.ts"
import type {
	JoinedItem,
	JoinMethod,
	PlanItem,
	PlanLevel,
	PlanName,
	ReadPlan
} from "#compiler/sql/plan.ts"
import { printedOnce } from "#compiler/sql/print-once.ts"
import { foldedCore, printPlannedQuery, printStatement } from "#compiler/sql/print.ts"
import { simpleQuery } from "#compiler/sql/pull-up.ts"
import { identityHooks, Transform, visitLevelExpr } from "#compiler/sql/transform.ts"

/** What a B-tree holds of a column: many values, or few (a roster's codes, a boolean), whose share of the rows no index
 * bounds, a filter beside a binding. A column of no byte bound, a span, a vector or a search document holds none: the
 * catalog states no BindColumn of it, and an equality on it is a filter beside the read's binding. */
export type Holds = "many" | "few"

/** A column of a stored table a B-tree holds, by its installed name: the field it is, a request's key, and its holds. */
export interface BindColumn {
	readonly field: string
	readonly holds: Holds
}

/**
 * A stored table as the binding reads it: its relation, as the installation plans its indexes; each installed column a
 * B-tree holds; and every unique key, each its installed columns, a read binding one whole reaching one row.
 */
export interface BindTable {
	readonly relation: string
	readonly columns: ReadonlyMap<string, BindColumn>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * What the binding reads of an installation, by the keys of the names a statement reads (sql/ast.ts nameKey): each
 * stored table, and whether a name is a role's view, which PostgreSQL expands into the statement under the reference's
 * alias. A relation of neither, a session's table of a judge or one of the catalog's, is read as it is written, at
 * no binding, and its plan states no scan of it, PostgreSQL's choice, since no index of the installation's serves it
 * and only the session or the catalog knows the indexes it holds.
 */
export interface ReadCatalog {
	readonly table: (key: NameKey) => BindTable | undefined
	readonly view: (key: NameKey) => boolean
	/**
	 * The columns of the table a trigger function fires on, by the key of the function's name, each its type: what its
	 * NEW and OLD fields are as PL/pgSQL hands a query reading them to the planner (`plannedOf`). None for a function
	 * no trigger fires.
	 */
	readonly fired: (fn: NameKey) => ReadonlyMap<string, TypeRef> | undefined
}

declare const boundBrand: unique symbol

/** A statement the binding made (see the header), with the plan it proved: minted here alone. */
export interface BoundStatement<S extends SqlStatement = SqlStatement> {
	readonly statement: S
	readonly plan: ReadPlan<AccessIndexRequest>
	readonly [boundBrand]: true
}

/** The name a FROM source's columns are read by where it is written: its alias, or an unaliased CTE read's CTE name. */
const writtenOf = (source: FromSource): string | undefined =>
	source.kind === "cte" ? (source.alias ?? source.name) : source.alias

/** A relation a place sees by its written name: its new alias, its level's depth, and its place among the level's. */
interface Declared {
	readonly alias: Alias
	readonly depth: number
	readonly place: number
}

/** The relations and CTEs a place sees, by their written names, the innermost binding of a name winning. */
interface Env {
	readonly relations: ReadonlyMap<string, Declared>
	readonly ctes: ReadonlyMap<string, Alias>
	readonly depth: number
}

const topEnv: Env = { relations: new Map(), ctes: new Map(), depth: 0 }

/** `env` with `written` bound to `alias` at its place `place` of the level of depth `depth`. */
const withRelation = (
	env: Env,
	written: string,
	alias: Alias,
	depth: number,
	place: number
): Env => ({
	...env,
	relations: new Map([...env.relations, [written, { alias, depth, place }]])
})

/** The conjuncts of a condition, each AND's arguments in turn. */
const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined ? [] : e.kind === "and" ? e.args.flatMap(conjunctsOf) : [e]

/** A column reference a side of an equality is, through a collation, which keeps the column's order. */
const columnOf = (e: Expr): { readonly table: string; readonly column: string } | undefined => {
	if (e.kind === "collate") {
		return columnOf(e.expr)
	}
	return e.kind === "column" && e.table !== undefined
		? { table: e.table, column: e.column }
		: undefined
}

/** Every column reference of an expression, at its own level and in its sublinks, as `f` meets it. */
const eachColumn = (e: Expr, f: (table: string, column: string) => void): void => {
	new (class extends Transform {
		override readonly expr = (x: Expr): Expr => {
			if (x.kind === "column" && x.table !== undefined) {
				f(x.table, x.column)
			}
			return this.exprChildren(x)
		}
	})(identityHooks).expr(e)
}

/** The qualifiers of every column reference of an expression (`eachColumn`). */
const qualifiersOf = (e: Expr): ReadonlySet<string> => {
	const out = new Set<string>()
	eachColumn(e, (table) => {
		out.add(table)
	})
	return out
}

/** Whether an expression holds a sublink or a VOLATILE call, which no binding or pushed conjunct carries. */
const opaque = (e: Expr): boolean => {
	let found = false
	new (class extends Transform {
		override readonly expr = (x: Expr): Expr => {
			if (
				x.kind === "exists" ||
				x.kind === "subquery" ||
				x.kind === "array" ||
				x.kind === "inQuery"
			) {
				found = true
				return x
			}
			if (
				x.kind === "call" &&
				!x.star &&
				(x.fn.kind === "qualified"
					? x.fn.volatility === "VOLATILE"
					: builtinFunctions[x.fn.name].volatility === "VOLATILE")
			) {
				found = true
			}
			return this.exprChildren(x)
		}
	})(identityHooks).expr(e)
	return found
}

/**
 * Every column each written alias of a statement is read at, anywhere in it, by the alias: what a probe made of a table
 * delivers, and what a read's index-only scan must store. An alias two items declare reads the columns of both.
 */
const neededColumns = (statement: SqlStatement): ReadonlyMap<string, ReadonlySet<string>> => {
	const out = new Map<string, Set<string>>()
	new (class extends Transform {
		override readonly expr = (x: Expr): Expr => {
			if (x.kind === "column" && x.table !== undefined) {
				out.getOrInsertComputed(x.table, () => new Set<string>()).add(x.column)
			}
			return this.exprChildren(x)
		}
	})(identityHooks).statement(statement)
	return out
}

/**
 * A binding of `alias`'s column a conjunct states: an equality of the column, through a collation, with a value that
 * reads no column of `alias` (`=`), or its membership in a list of such values or its equality with an element of such
 * an array (`in`).
 */
interface Binding {
	readonly conjunct: Expr
	readonly column: string
	readonly value: Expr
	readonly schema: string | undefined
	readonly op: "=" | "in"
}

const bindingOf = (c: Expr, alias: string): Binding | undefined => {
	if (opaque(c)) {
		return undefined
	}
	if (c.kind === "binary" && c.op === "=") {
		const left = columnOf(c.left)
		if (left?.table === alias && !qualifiersOf(c.right).has(alias)) {
			return { conjunct: c, column: left.column, value: c.right, schema: c.schema, op: "=" }
		}
		const right = columnOf(c.right)
		if (right?.table === alias && !qualifiersOf(c.left).has(alias)) {
			return { conjunct: c, column: right.column, value: c.left, schema: c.schema, op: "=" }
		}
		return undefined
	}
	if (c.kind === "inList" && !c.not) {
		const ref = columnOf(c.expr)
		return ref?.table === alias && !c.list.some((x) => qualifiersOf(x).has(alias))
			? {
					conjunct: c,
					column: ref.column,
					value: { kind: "row", items: c.list },
					schema: undefined,
					op: "in"
				}
			: undefined
	}
	if (c.kind === "equalsAny") {
		const ref = columnOf(c.expr)
		return ref?.table === alias && !qualifiersOf(c.array).has(alias)
			? { conjunct: c, column: ref.column, value: c.array, schema: c.schema, op: "in" }
			: undefined
	}
	return undefined
}

/** Whether a set of bound columns holds a unique key of `table` whole, so its read reaches one row at most. */
const holdsKey = (table: BindTable, bound: ReadonlySet<string>): boolean =>
	table.keys.some((k) => k.length > 0 && k.every((c) => bound.has(c)))

/** The request of a read of `table` at `bound`, its installed columns, each a key it binds by equality. */
const requestOf = (
	table: BindTable,
	bound: NonEmptyReadonlyArray<string>,
	trailing: ReadonlyArray<string>,
	use: AccessUse
): AccessIndexRequest => ({
	relation: table.relation,
	keys: [...bound, ...trailing].map((c) => {
		const column = table.columns.get(c)
		return column === undefined
			? defect(`a bound column of ${table.relation} a B-tree holds; ${c} is none`)
			: { expr: column.field, dir: "asc" as const, opclass: defaultOpclass }
	}),
	method: "btree",
	fixed: bound.length,
	role: "access",
	use
})

/** The comparisons PostgreSQL reads as a B-tree's range of one column (nbtree's strategies `<`, `<=`, `>=`, `>`). */
const rangeOperators: ReadonlySet<string> = new Set(["<", "<=", ">", ">="])

/** A range of `alias`'s column a conjunct states: an ordering comparison of it with a value reading no column of it. */
const rangeOf = (
	c: Expr,
	alias: string
): { readonly conjunct: Expr; readonly column: string; readonly value: Expr } | undefined => {
	if (c.kind !== "binary" || !rangeOperators.has(c.op) || c.schema !== undefined || opaque(c)) {
		return undefined
	}
	const left = columnOf(c.left)
	if (left?.table === alias && !qualifiersOf(c.right).has(alias)) {
		return { conjunct: c, column: left.column, value: c.right }
	}
	const right = columnOf(c.right)
	return right?.table === alias && !qualifiersOf(c.left).has(alias)
		? { conjunct: c, column: right.column, value: c.left }
		: undefined
}

/**
 * One entry of a level's FROM, flattened from its items and join chains in order: its source, and how it joins the
 * entries before it, a FROM list's item or a chain's first (`item`), an inner join on a condition, a LEFT JOIN on one,
 * or a cross join.
 */
type Entry =
	| { readonly join: "item" | "cross"; readonly source: FromSource }
	| { readonly join: "on" | "left"; readonly source: FromSource; readonly on: Expr }

const entriesOf = (from: ReadonlyArray<FromItem>): ReadonlyArray<Entry> =>
	from.flatMap((item): ReadonlyArray<Entry> =>
		item.kind === "joins"
			? [{ join: "item", source: item.first }, ...item.steps.map(stepEntry)]
			: [{ join: "item", source: item }]
	)

const stepEntry = (step: JoinStep): Entry =>
	step.kind === "cross"
		? { join: "cross", source: step.source }
		: { join: step.kind, source: step.source, on: step.on }

/** How a bound entry joins the entries before it, in the join chain of its level: crosswise, or on its ON. */
type Step = { readonly join: "cross" } | { readonly join: "on" | "left"; readonly on: Expr }

/** A bound entry: its source, its step, and its plan item and the method that joins it inner. */
interface BoundEntry {
	readonly source: FromSource
	readonly step: Step
	readonly item: PlanItem<AccessIndexRequest>
	readonly method: JoinMethod
}

/** A level's FROM, one join chain: its first entry, every other a step, each joined as it states. */
const fromOf = (entries: ReadonlyArray<BoundEntry>): ReadonlyArray<FromItem> => {
	const [first, ...rest] = entries
	if (first === undefined) {
		return []
	}
	const steps = rest.map((e): JoinStep => {
		const step = e.step
		return step.join === "cross"
			? { kind: "cross", source: e.source }
			: { kind: step.join, source: e.source, on: step.on }
	})
	return isNonEmpty(steps) ? [{ kind: "joins", first: first.source, steps }] : [first.source]
}

/** A query's ORDER BY, LIMIT and OFFSET, which read its body's FROM. */
type Tail = Pick<OperandSelect, "orderBy" | "limit" | "offset">

/** A query fenced by OFFSET 0 where PostgreSQL would pull it up (sql/pull-up.ts simpleQuery), so it is planned apart. */
const fenced = (q: OperandSelect): OperandSelect =>
	simpleQuery(q) ? { ...q, offset: lit.int(0, types.bigint) } : q

/** The written alias a wrapper takes (`wrapped`): one no lowering writes, whose scope's alias the binding mints. */
const wrapperAlias = "__wrapped"

/**
 * Whether a query reads its relations at its own level where that level is one PostgreSQL names itself, a sublink's or a
 * set operation's arm's: a core reading two items or more, or a stored table or a view; any other query reads through
 * one item already planned apart under the scope's alias, or reads none.
 */
const readsAtOwnLevel = (q: OperandSelect): boolean => {
	const body = q.body
	if (body.kind !== "core") {
		return false
	}
	const entries = entriesOf(body.from)
	return entries.length > 1 || entries.some((e) => e.source.kind === "table")
}

/**
 * A query a level PostgreSQL names reads through one item of the scope's (see the header): where it reads at its own
 * level (`readsAtOwnLevel`), the query whole is a derived table under a fresh alias, fenced by an OFFSET 0 where it
 * states none, so neither PostgreSQL nor the fold of pass-through projections (sql/print.ts foldedCore) takes it into
 * the wrapper, its outputs given fresh names `c<n>` and read back under their own where its reader reads them by name
 * (`named`), a set operation's arm's, and bare where it reads them by place, a sublink's, so its rows, its multiplicity
 * and every name a reader reads are the query's.
 */
const wrapped = (q: OperandSelect, named: boolean): OperandSelect => {
	if (!readsAtOwnLevel(q)) {
		return q
	}
	const outputs = bodyPositionNames(q.body)
	const names = outputs.map((_, i) => `c${i + 1}`)
	const inner = namedQuery(q, names)
	const targets = names.map((n, i) => {
		const output = outputs[i]
		return output === undefined || !named
			? target(col(wrapperAlias, n))
			: targetAs(col(wrapperAlias, n), output)
	})
	const fence = inner.offset === undefined ? { ...inner, offset: lit.int(0, types.bigint) } : inner
	return operandSelect(keyedRead(targets, [derived(fence, wrapperAlias, false)], undefined))
}

/**
 * Whether a derived table's query takes a conjunct of its reader pushed into it (allpaths.c subquery_push_qual's
 * conditions, as grizzle's queries meet them), and the query with it pushed: one core of no WITH, LIMIT or OFFSET, each
 * column the conjunct reads of `alias` a target reading no aggregate, window, set-returning or VOLATILE call, in a
 * grouped core one it groups by, under DISTINCT ON one it distinguishes, and in a core that calls a window function
 * one every window partitions by, a conjunct of which keeps each partition whole (check_output_expressions,
 * targetIsInAllPartitionLists): an attachment's take ranked per partition of its input, read at the partition its
 * parent row binds, reads that partition's rows alone. The conjunct holds no sublink and no VOLATILE call. The pushed
 * conjunct reads each column's target in its place, a WHERE conjunct of the core.
 */
const pushedInto = (q: OperandSelect, alias: string, c: Expr): OperandSelect | undefined => {
	const body = q.body
	if (
		body.kind !== "core" ||
		q.with !== undefined ||
		q.limit !== undefined ||
		q.offset !== undefined ||
		opaque(c) ||
		!qualifiersOf(c).has(alias)
	) {
		return undefined
	}
	const names = selectColumns(q)
	const grouped =
		body.groupBy.length > 0 ||
		body.having !== undefined ||
		body.targets.some((t) => overRowsOf(t.expr) === "aggregate")
	const text = (e: Expr) =>
		JSON.stringify(e, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))
	const groups = new Set(body.groupBy.map(text))
	const distinguished =
		typeof body.distinct === "object" ? new Set(body.distinct.on.map(text)) : undefined
	/** Each window a target's window call reads the level's rows by, whose partitions a pushed conjunct keeps whole. */
	const windows: Array<ReadonlyArray<string>> = []
	for (const t of body.targets) {
		visitLevelExpr(t.expr, (x) => {
			if (x.kind === "call" && x.over !== undefined) {
				windows.push(x.over.partitionBy.map(text))
			}
		})
	}
	const read: Array<string> = []
	eachColumn(c, (table, column) => {
		if (table === alias) {
			read.push(column)
		}
	})
	const columns = new Map<string, Expr>()
	for (const column of read) {
		const t = body.targets[names.indexOf(column)]
		if (
			t === undefined ||
			opaque(t.expr) ||
			overRowsOf(t.expr) !== undefined ||
			returnsSet(t.expr) ||
			(grouped && !groups.has(text(t.expr))) ||
			(distinguished !== undefined && !distinguished.has(text(t.expr))) ||
			!windows.every((w) => w.includes(text(t.expr)))
		) {
			return undefined
		}
		columns.set(column, t.expr)
	}
	const substituted = new (class extends Transform {
		override readonly expr = (x: Expr): Expr =>
			x.kind === "column" && x.table === alias ? (columns.get(x.column) ?? x) : this.exprChildren(x)
	})(identityHooks).expr(c)
	return { ...q, body: { ...body, where: conjunction([...conjunctsOf(body.where), substituted]) } }
}

/**
 * The binding of the statements of one scope (see the header). Local mutable state owned by one binding: the plan's
 * levels in the order the walk meets them; the columns each written alias is read at; the scope and the catalog; and
 * whether the statement reads what it reads whole, once (`#whole`).
 */
class Binder {
	readonly #scope: AdviceScope
	readonly #catalog: ReadCatalog
	readonly #levels: Array<PlanLevel<AccessIndexRequest>> = []
	#needs: ReadonlyMap<string, ReadonlySet<string>> = new Map()
	#whole = false

	constructor(scope: AdviceScope, catalog: ReadCatalog) {
		this.#scope = scope
		this.#catalog = catalog
	}

	plan(): ReadPlan<AccessIndexRequest> {
		return { levels: [...this.#levels] }
	}

	/** The statement bound (see the header), its columns' needs read off it first; a whole one's reads joined by hash. */
	statement(s: SqlStatement, whole: boolean): SqlStatement {
		this.#needs = neededColumns(s)
		this.#whole = whole
		const top: PlanName = { kind: "top" }
		if (s.kind === "select") {
			return this.setQuery(s, topEnv, top)
		}
		if (s.kind === "insert") {
			return this.insert(s, topEnv, top)
		}
		if (s.kind === "update") {
			return this.update(s, topEnv, top)
		}
		if (s.kind === "delete") {
			return this.delete(s, topEnv, top)
		}
		if (s.kind === "merge") {
			return this.merge(s, topEnv, top)
		}
		if (s.kind === "fillStored") {
			this.#whole = true
			return { ...s, query: this.setQuery(s.query, topEnv, top) }
		}
		return s.kind === "createFunction" ? this.routine(s) : s
	}

	#alias(written: string | undefined): Alias {
		return this.#scope.alias({ kind: "internal", purpose: `bound ${written ?? "source"}` })
	}

	/** Every column the statement reads of the written alias `alias`, in name order. */
	#needed(alias: string): ReadonlyArray<string> {
		return [...(this.#needs.get(alias) ?? [])].toSorted()
	}

	/** A transform under `env`: each column reference read at its relation's new alias, each sublink bound. */
	renamer(env: Env): Transform {
		const sublink = (q: OperandSelect) => this.sublink(q, env)
		const array = (q: OperandSelect) => this.setQuery(wrapped(q, false), env, undefined)
		return new (class extends Transform {
			override readonly expr = (x: Expr): Expr => {
				if (x.kind === "column") {
					const declared = x.table === undefined ? undefined : env.relations.get(x.table)
					return declared === undefined ? x : { ...x, table: declared.alias }
				}
				if (x.kind === "exists" || x.kind === "subquery") {
					return { ...x, query: sublink(x.query) }
				}
				if (x.kind === "array") {
					return { ...x, query: array(x.query) }
				}
				if (x.kind === "inQuery") {
					return { ...x, expr: this.expr(x.expr), query: sublink(x.query) }
				}
				return this.exprChildren(x)
			}
		})(identityHooks)
	}

	/** An expression under `env` (`renamer`). */
	expr(e: Expr, env: Env): Expr {
		return this.renamer(env).expr(e)
	}

	/** A sublink's query under the env its reader's place gives it: a level PostgreSQL names itself (`wrapped`). */
	sublink(q: OperandSelect, env: Env): OperandSelect {
		return this.query(wrapped(q, false), env, undefined)
	}

	/** A set query bound, a set still: every rebuild of it keeps its body's proof. */
	setQuery(
		q: OperandSelect & { readonly body: OperandSelect["body"] },
		env: Env,
		name: PlanName | undefined
	) {
		const bound = this.query(q, env, name)
		return isSetQuery(bound) ? bound : defect("a set query bound a set still")
	}

	/**
	 * A query: its WITH's CTEs, each a level its new name names, then its body under `name` (none for a level PostgreSQL
	 * names itself), then its ORDER BY, LIMIT and OFFSET over the body's FROM.
	 */
	query(q: OperandSelect, env: Env, name: PlanName | undefined): OperandSelect {
		const { with: w, env: inner } = this.with(q.with, env)
		const body = this.body(q.body, inner, name, {
			orderBy: q.orderBy,
			limit: q.limit,
			offset: q.offset
		})
		return { ...q, with: w, body: body.body, ...body.tail }
	}

	/** A WITH: each CTE under its new name, each a level that name names, a recursive one's every CTE seen in each. */
	with(w: With | undefined, env: Env): { readonly with: With | undefined; readonly env: Env } {
		if (w === undefined) {
			return { with: undefined, env }
		}
		const ctes = new Map(env.ctes)
		const names = w.ctes.map((cte) => this.#alias(cte.name))
		if (w.recursive) {
			for (const [i, cte] of w.ctes.entries()) {
				ctes.set(cte.name, names[i] ?? defect("a name for each CTE"))
			}
		}
		const bound = w.ctes.map((cte, i): Cte => {
			const name = names[i] ?? defect("a name for each CTE")
			const query = this.cteBody(cte.query, { ...env, ctes: new Map(ctes) }, name)
			ctes.set(cte.name, name)
			return { ...cte, name, query }
		})
		return isNonEmpty(bound)
			? { with: { ...w, ctes: bound }, env: { ...env, ctes } }
			: defect("a WITH of at least one CTE")
	}

	cteBody(body: CteBody, env: Env, name: Alias): CteBody {
		const level: PlanName = { kind: "named", name }
		switch (body.kind) {
			case "select":
				return this.query(body, env, level)
			case "insert":
				return this.insert(body, env, level)
			case "update":
				return this.update(body, env, level)
			case "delete":
				return this.delete(body, env, level)
			case "merge":
				return this.merge(body, env, level)
		}
	}

	/** A query body under `env`, its query's ORDER BY, LIMIT and OFFSET read under the env its body binds. */
	body(
		b: OperandBody,
		env: Env,
		name: PlanName | undefined,
		tail: Tail
	): { readonly body: OperandBody; readonly tail: Tail } {
		const tailUnder = (under: Env): Tail => {
			const rename = this.renamer(under)
			return {
				orderBy: rename.orderItems(tail.orderBy),
				limit: tail.limit === undefined ? undefined : rename.expr(tail.limit),
				offset: tail.offset === undefined ? undefined : rename.expr(tail.offset)
			}
		}
		switch (b.kind) {
			case "core": {
				const folded = tail.orderBy.length > 0 ? b : foldedCore(b, true)
				const bound = this.core(folded, env, name)
				return { body: bound.core, tail: tailUnder(bound.env) }
			}
			case "select":
				return { body: this.query(b, env, name), tail: tailUnder(env) }
			case "setOp": {
				const [one, two, ...rest] = b.arms
				const arms = [
					this.arm(one, env),
					this.arm(two, env),
					...rest.map((a) => this.arm(a, env))
				] as const
				if (b.op === "UNION ALL" && b.rows !== "oneRow" && b.rows !== "operand") {
					const set = (arm: SetOperand) =>
						arm.kind === "core"
							? isSetBodyCore(arm)
							: isSetQuery(arm)
								? arm
								: defect("a UNION ALL arm bound a set still, as its proof requires")
					return {
						body: { ...b, arms: [set(arms[0]), set(arms[1]), ...arms.slice(2).map(set)] },
						tail: tailUnder(env)
					}
				}
				return { body: { ...b, arms }, tail: tailUnder(env) }
			}
		}
	}

	/** A set operation's arm: a level PostgreSQL names itself, so it reads its relations through one item (`wrapped`). */
	arm(arm: SetOperand, env: Env): SetOperand {
		const query = arm.kind === "core" ? operandSelect(arm) : arm
		const bound = this.query(wrapped(query, true), env, undefined)
		return arm.kind === "core" &&
			bound.with === undefined &&
			bound.orderBy.length === 0 &&
			bound.limit === undefined &&
			bound.offset === undefined &&
			bound.body.kind === "core"
			? bound.body
			: bound
	}

	/**
	 * One level (see the header): a core under `env`, planned under `name`, none for one PostgreSQL names itself. Its
	 * FROM is walked in order, each entry seeing the ones before it; each stored table's bindings are taken from the
	 * conjuncts that may bind it, moved into its read, and the rest of the level is read under every entry's new alias.
	 */
	core(
		c: SelectCore,
		env: Env,
		name: PlanName | undefined
	): { readonly core: SelectCore; readonly env: Env } {
		const depth = env.depth + 1
		const where: Array<Expr> = [...conjunctsOf(c.where)]
		let here: Env = { ...env, depth }
		const bound: Array<BoundEntry> = []
		for (const [place, entry] of entriesOf(c.from).entries()) {
			const written = writtenOf(entry.source)
			const alias = this.#alias(written)
			bound.push(this.entry(entry, place, where, here, env, alias))
			if (written !== undefined) {
				here = withRelation(here, written, alias, depth, place)
			}
		}
		const rename = this.renamer(here)
		this.#level(name, bound)
		const frame = {
			kind: "core",
			from: fromOf(bound),
			where: conjunction(where.map((w) => rename.expr(w))),
			groupBy: rename.exprs(c.groupBy),
			having: c.having === undefined ? undefined : rename.expr(c.having)
		} as const
		if (c.distinct === false) {
			return {
				core: { ...frame, distinct: false, rows: c.rows, targets: rename.targets(c.targets) },
				env: here
			}
		}
		const [t0, ...ts] = rename.targets(c.targets)
		if (t0 === undefined) {
			return defect("a DISTINCT core of a target at least")
		}
		const distinct = c.distinct === true ? true : { on: rename.nonEmptyExprs(c.distinct.on) }
		return { core: { ...frame, distinct, targets: [t0, ...ts] }, env: here }
	}

	/** A level's plan, its first entry driving and the rest joined in order, where the scope names it. */
	#level(name: PlanName | undefined, bound: ReadonlyArray<BoundEntry>): void {
		const [first, ...joined] = bound
		if (name === undefined || first === undefined) {
			return
		}
		this.#levels.push({
			name,
			first: first.item,
			joined: joined.map((j): JoinedItem<AccessIndexRequest> => ({ item: j.item, join: j.method })),
			appended: []
		})
	}

	/**
	 * One entry of a level at `place`, under `here` (its enclosing levels' relations and its level's entries before it)
	 * and `outer` (its enclosing levels' alone): its source bound under `alias`, the conjuncts of `where` it binds or
	 * takes moved out of it.
	 */
	entry(
		entry: Entry,
		place: number,
		where: Array<Expr>,
		here: Env,
		outer: Env,
		alias: Alias
	): BoundEntry {
		const source = entry.source
		const writtenAlias = writtenOf(source)
		const self =
			writtenAlias === undefined ? here : withRelation(here, writtenAlias, alias, here.depth, place)
		const step = (): Step =>
			entry.join === "on" || entry.join === "left"
				? { join: entry.join, on: this.expr(entry.on, self) }
				: { join: "cross" }
		const rows = (s: FromSource, method: JoinMethod): BoundEntry => ({
			source: s,
			step: step(),
			item: { alias, scan: { kind: "rows" } },
			method
		})
		switch (source.kind) {
			case "table":
				return this.#catalog.view(nameKey(source.table))
					? rows({ ...source, alias }, this.#method(entry, source.alias, where, here, place))
					: this.tableEntry(entry, source, place, where, here, alias)
			case "derived":
				return this.derivedEntry(entry, source, place, where, here, outer, alias)
			case "cte": {
				const name = here.ctes.get(source.name)
				return name === undefined
					? defect(`a CTE ${source.name} a WITH in reach binds`)
					: rows(
							{ kind: "cte", name, alias },
							this.#method(entry, source.alias ?? source.name, where, here, place)
						)
			}
			case "probe":
				return this.statedProbe(source, here, alias, step())
			case "met":
				return this.statedMet(source, here, alias, step())
			case "metRows": {
				const cteOf = (name: string) =>
					here.ctes.get(name) ?? defect(`a CTE ${name} a WITH in reach binds, which met rows read`)
				return rows(
					{ ...source, insert: cteOf(source.insert), proposed: cteOf(source.proposed), alias },
					this.#method(entry, source.alias, where, here, place)
				)
			}
			case "read":
				return defect("a read source the lowering stated, which the binding alone makes")
			case "enclosing":
				return rows({ ...source, alias }, "nestedLoop")
			case "transition":
			case "context":
				return rows({ ...source, alias }, this.#method(entry, source.alias, where, here, place))
			case "function":
				return rows(
					{
						...source,
						alias,
						call: { ...source.call, args: this.renamer(here).exprs(source.call.args) }
					},
					"nestedLoop"
				)
			case "arrays": {
				const arrays = source.source
				const renamer = this.renamer(here)
				return rows(
					{
						...source,
						alias,
						source:
							arrays.kind === "carried" || arrays.kind === "setting"
								? {
										...arrays,
										columns: mapNonEmpty(arrays.columns, (c) => ({
											...c,
											array: renamer.expr(c.array)
										}))
									}
								: arrays
					},
					"nestedLoop"
				)
			}
			case "values":
				return rows(
					{ ...source, alias, rows: mapNonEmpty(source.rows, (r) => this.renamer(outer).exprs(r)) },
					this.#method(entry, source.alias, where, here, place)
				)
		}
	}

	/**
	 * A read a driving row reaches that the lowering stated (FromSource `probe` and `met`), planned apart at each driving
	 * row under its alias: its inner read under a fresh alias of the scope, every value and filter read under `here` and
	 * the inner read, and its level the read of its table through the index its bound columns lead, a key's, a group's
	 * or a met row's, the group's order after them, at the columns it delivers. A table the catalog holds no B-tree
	 * column of it binds, a span key's probe read by its overlap among them, is a level of its own the plan states no scan
	 * of, PostgreSQL's choice by cost.
	 */
	#driven(
		table: ObjectName,
		written: string,
		bound: ReadonlyArray<string>,
		order: ReadonlyArray<string>,
		keyed: boolean,
		delivered: ReadonlyArray<string>,
		alias: Alias
	): { readonly inner: Alias; readonly inside: (env: Env) => Env } {
		const inner = this.#alias(written)
		const catalogTable = this.#catalog.table(nameKey(table))
		const held = catalogTable === undefined ? [] : bound.filter((c) => catalogTable.columns.has(c))
		const trailing =
			catalogTable === undefined
				? []
				: order.filter((c) => catalogTable.columns.has(c) && !held.includes(c))
		const [h0, ...hs] = held
		this.#levels.push({
			name: { kind: "named", name: alias },
			first: {
				alias: inner,
				scan:
					catalogTable === undefined || h0 === undefined || held.length !== bound.length
						? { kind: "rows" }
						: {
								kind: "index",
								index: requestOf(
									catalogTable,
									[h0, ...hs],
									trailing,
									keyed ? "key lookup" : "join key"
								),
								bound: held,
								needs: [...new Set([...delivered, ...held])].toSorted()
							}
			},
			joined: [],
			appended: []
		})
		return { inner, inside: (env) => withRelation(env, written, inner, env.depth + 1, 0) }
	}

	/** A probe the lowering stated (`#driven`): its key's, its rows', its group's or its group's last row's. */
	statedProbe(
		source: Extract<FromSource, { readonly kind: "probe" }>,
		here: Env,
		alias: Alias,
		step: Step
	): BoundEntry {
		const by = source.by
		const { inner, inside } = this.#driven(
			source.table,
			source.inner,
			by.columns.map((c) => c.column),
			by.kind === "group" || by.kind === "last" ? by.order : [],
			by.kind === "key",
			source.columns.map((c) => c.read),
			alias
		)
		const value = (c: ProbeColumn): ProbeColumn => ({ ...c, value: this.expr(c.value, here) })
		const bound: ProbeBy =
			by.kind === "key"
				? { kind: "key", columns: by.columns.map(value) }
				: by.kind === "rows"
					? { kind: "rows", columns: mapNonEmpty(by.columns, value) }
					: { kind: by.kind, columns: mapNonEmpty(by.columns, value), order: by.order }
		return {
			source: {
				...source,
				inner,
				by: bound,
				filter: source.filter.map((f) => this.expr(f, inside(here))),
				alias
			},
			step,
			item: { alias, scan: { kind: "rows" } },
			method: "nestedLoop"
		}
	}

	/** A met row's stored row the lowering stated (`#driven`), at its key of the met rows in scope. */
	statedMet(
		source: Extract<FromSource, { readonly kind: "met" }>,
		here: Env,
		alias: Alias,
		step: Step
	): BoundEntry {
		const { inner, inside } = this.#driven(
			source.table,
			source.inner,
			source.key.map((k) => k.column),
			[],
			true,
			source.columns.map((c) => c.read),
			alias
		)
		const rows =
			here.relations.get(source.rows)?.alias ??
			defect(`the met rows ${source.rows} a met row reads in scope`)
		return {
			source: {
				...source,
				inner,
				rows,
				filter: source.filter.map((f) => this.expr(f, inside(here))),
				alias
			},
			step,
			item: { alias, scan: { kind: "rows" } },
			method: "nestedLoop"
		}
	}

	/**
	 * How an item no index binds joins the items before it: by a hash where an equality of its WHERE or ON pairs one of
	 * its columns with a column of an earlier item of its level, a set join's; else by a nested loop.
	 */
	#method(
		entry: Entry,
		written: string,
		where: ReadonlyArray<Expr>,
		here: Env,
		place: number
	): JoinMethod {
		if (place === 0) {
			return "nestedLoop"
		}
		const pool =
			entry.join === "on" || entry.join === "left" ? [...where, ...conjunctsOf(entry.on)] : where
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === here.depth && d.place < place
		}
		return pool.some((c) => {
			const b = bindingOf(c, written)
			return b?.op === "=" && [...qualifiersOf(b.value)].some(earlier)
		})
			? "hash"
			: "nestedLoop"
	}

	/** A stored table's entry (see the header): a probe where an earlier item binds it, a seek, or a whole read. */
	tableEntry(
		entry: Entry,
		source: Extract<FromSource, { readonly kind: "table" }>,
		place: number,
		where: Array<Expr>,
		here: Env,
		alias: Alias
	): BoundEntry {
		const written = source.alias
		const table = this.#catalog.table(nameKey(source.table))
		const ons: Array<Expr> =
			entry.join === "on" || entry.join === "left" ? [...conjunctsOf(entry.on)] : []
		const pools: ReadonlyArray<Array<Expr>> = entry.join === "left" ? [ons] : [where, ons]
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === here.depth && d.place < place
		}
		const fixed = (e: Expr) =>
			[...qualifiersOf(e)].every((a) => {
				const d = here.relations.get(a)
				return d !== undefined && d.depth < here.depth
			})
		const bindings =
			table === undefined
				? []
				: pools.flatMap((pool) =>
						pool.flatMap((c): ReadonlyArray<Binding & { readonly driven: boolean }> => {
							const b = bindingOf(c, written)
							if (b === undefined || !table.columns.has(b.column)) {
								return []
							}
							const driven = b.op === "=" && [...qualifiersOf(b.value)].some(earlier)
							return (driven && !this.#whole) || fixed(b.value) ? [{ ...b, driven }] : []
						})
					)
		const needs = this.#needed(written)
		const take = (conjunct: Expr) => {
			for (const pool of pools) {
				const at = pool.indexOf(conjunct)
				if (at >= 0) {
					pool.splice(at, 1)
				}
			}
		}
		if (table !== undefined && bindings.some((b) => b.driven)) {
			return this.probeEntry(entry, source, table, bindings, ons, where, here, alias, needs, take)
		}
		const many =
			table !== undefined && bindings.some((b) => table.columns.get(b.column)?.holds === "many")
		const self = withRelation(here, written, alias, here.depth, place)
		const seek = many
			? bindings.map((b): SeekBinding => {
					take(b.conjunct)
					return { column: b.column, condition: this.expr(b.conjunct, self) }
				})
			: []
		const equal = new Set(seek.map((b) => b.column))
		/** The one range a seek reads past its bound columns, of the least column it ranges at a value its level fixes. */
		const [range] =
			table === undefined || seek.length === 0
				? []
				: pools
						.flatMap((pool) =>
							pool.flatMap((c) => {
								const r = rangeOf(c, written)
								return r !== undefined &&
									table.columns.has(r.column) &&
									!equal.has(r.column) &&
									fixed(r.value)
									? [r]
									: []
							})
						)
						.toSorted((x, y) => (x.column < y.column ? -1 : x.column > y.column ? 1 : 0))
		if (range !== undefined) {
			take(range.conjunct)
			seek.push({ column: range.column, condition: this.expr(range.conjunct, self) })
		}
		const step: Step =
			entry.join === "on" || entry.join === "left"
				? {
						join: entry.join,
						on: conjunction(ons.map((c) => this.expr(c, self))) ?? lit.bool(true)
					}
				: { join: "cross" }
		const method = this.#method(entry, written, where, here, place)
		const bound = [...equal].toSorted()
		const [b0, ...bs] = bound
		const [s0, ...ss] = seek
		if (table === undefined || s0 === undefined || b0 === undefined) {
			return {
				source: { kind: "read", table: source.table, alias, access: { kind: "whole" } },
				step,
				item: { alias, scan: table === undefined ? { kind: "rows" } : { kind: "seq" } },
				method
			}
		}
		return {
			source: {
				kind: "read",
				table: source.table,
				alias,
				access: { kind: "seek", bound: [s0, ...ss] }
			},
			step,
			item: {
				alias,
				scan: {
					kind: "index",
					index: requestOf(
						table,
						[b0, ...bs],
						range === undefined ? [] : [range.column],
						holdsKey(table, equal) ? "key lookup" : "equality lookup"
					),
					bound: range === undefined ? bound : [...bound, range.column],
					needs
				}
			},
			method
		}
	}

	/**
	 * A stored table an earlier item binds, as a probe: every binding moved into it, a `=` one as the probe's column, any
	 * other into its filter, read at its inner alias; under a LEFT JOIN its whole ON moved in, the step's ON then true;
	 * a key probe where its `=` bindings hold a unique key whole, else every row at them; delivering every column the
	 * statement reads of it under its own name, its alias the table's, so every reference reads it as it read the table.
	 */
	probeEntry(
		entry: Entry,
		source: Extract<FromSource, { readonly kind: "table" }>,
		table: BindTable,
		bindings: ReadonlyArray<Binding>,
		ons: Array<Expr>,
		where: Array<Expr>,
		here: Env,
		alias: Alias,
		needs: ReadonlyArray<string>,
		take: (conjunct: Expr) => void
	): BoundEntry {
		const written = source.alias
		const inner = this.#alias(written)
		const inside = withRelation(here, written, inner, here.depth + 1, 0)
		for (const b of bindings) {
			take(b.conjunct)
		}
		const moved = entry.join === "left" ? ons.splice(0) : []
		const columns: Array<ProbeColumn> = []
		const filter: Array<Expr> = []
		for (const b of bindings) {
			if (b.op === "=") {
				columns.push({ column: b.column, value: this.expr(b.value, here), schema: b.schema })
			} else {
				filter.push(this.expr(b.conjunct, inside))
			}
		}
		for (const c of moved) {
			filter.push(this.expr(c, inside))
		}
		for (const c of entry.join === "on" ? ons.splice(0) : []) {
			where.push(c)
		}
		const keyed = holdsKey(table, new Set(columns.map((c) => c.column)))
		const bound = [...new Set(bindings.map((b) => b.column))].toSorted()
		const delivered = needs.length > 0 ? needs : bound
		const [d0, ...ds] = delivered.map((c): DrivenColumn => ({ read: c, as: c }))
		const [c0, ...cs] = columns
		const [k0, ...ks] = bound
		if (d0 === undefined || c0 === undefined || k0 === undefined) {
			return defect("a probe of a column at least, bound by one")
		}
		this.#levels.push({
			name: { kind: "named", name: alias },
			first: {
				alias: inner,
				scan: {
					kind: "index",
					index: requestOf(table, [k0, ...ks], [], keyed ? "key lookup" : "join key"),
					bound,
					needs: delivered
				}
			},
			joined: [],
			appended: []
		})
		return {
			source: {
				kind: "probe",
				table: source.table,
				inner,
				by: keyed ? { kind: "key", columns: [c0, ...cs] } : { kind: "rows", columns: [c0, ...cs] },
				filter,
				columns: [d0, ...ds],
				alias
			},
			step: entry.join === "left" ? { join: "left", on: lit.bool(true) } : { join: "cross" },
			item: { alias, scan: { kind: "rows" } },
			method: "nestedLoop"
		}
	}

	/**
	 * A derived table's entry: each conjunct of its level that reads its columns beside values its place fixes, and that
	 * its query takes (`pushedInto`), pushed in first, the table then LATERAL where a pushed conjunct reads an earlier
	 * item; its query bound as a level its alias names, fenced where PostgreSQL would pull it up.
	 */
	derivedEntry(
		entry: Entry,
		source: Extract<FromSource, { readonly kind: "derived" }>,
		place: number,
		where: Array<Expr>,
		here: Env,
		outer: Env,
		alias: Alias
	): BoundEntry {
		const written = source.alias
		const ons: Array<Expr> =
			entry.join === "on" || entry.join === "left" ? [...conjunctsOf(entry.on)] : []
		const pool = entry.join === "left" ? ons : where
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === here.depth && d.place < place
		}
		let query = source.query
		let lateral = source.lateral
		for (const c of pool.slice()) {
			const qualifiers = qualifiersOf(c)
			if (![...qualifiers].every((a) => a === written || here.relations.has(a))) {
				continue
			}
			const pushed = pushedInto(query, written, c)
			if (pushed === undefined) {
				continue
			}
			pool.splice(pool.indexOf(c), 1)
			query = pushed
			lateral ||= [...qualifiers].some(earlier)
		}
		const self = withRelation(here, written, alias, here.depth, place)
		const step: Step =
			entry.join === "on" || entry.join === "left"
				? {
						join: entry.join,
						on: conjunction(ons.map((c) => this.expr(c, self))) ?? lit.bool(true)
					}
				: { join: "cross" }
		return {
			source: {
				kind: "derived",
				query: this.query(fenced(query), lateral ? here : outer, { kind: "named", name: alias }),
				alias,
				lateral
			},
			step,
			item: { alias, scan: { kind: "rows" } },
			method: lateral ? "nestedLoop" : this.#method(entry, written, where, here, place)
		}
	}

	/**
	 * An INSERT: its query read through one item of the scope's where it reads at its own level (`wrapped`), the
	 * INSERT's source being a level PostgreSQL pulls up into the INSERT's or names itself; its arbitration and RETURNING
	 * read under its target's new alias.
	 */
	insert(s: Insert, env: Env, name: PlanName): Insert {
		const { with: w, env: inner } = this.with(s.with, env)
		const targetAlias = s.alias === undefined ? undefined : this.#alias(s.alias)
		const own =
			s.alias === undefined || targetAlias === undefined
				? inner
				: withRelation(inner, s.alias, targetAlias, inner.depth + 1, 0)
		const rename = this.renamer(own)
		const base = {
			kind: "insert",
			with: w,
			table: s.table,
			alias: targetAlias,
			onConflict: s.onConflict === undefined ? undefined : rename.onConflict(s.onConflict),
			returning: rename.targets(s.returning)
		} as const
		if (isValuesTarget(s)) {
			return {
				...base,
				columns: s.columns,
				source: {
					kind: "values",
					rows: mapNonEmpty(s.source.rows, (r) => this.renamer(inner).exprs(r))
				}
			}
		}
		const source = s.source
		return {
			...base,
			columns: s.columns,
			source: { kind: "query", query: this.setQuery(wrapped(source.query, false), inner, name) }
		}
	}

	/**
	 * A write's target and the items it reads beside it (an UPDATE's FROM, a DELETE's USING), at the write's level: the
	 * items first, in order, which never see the target; then the target, read at the tuple ids a probe of it at its
	 * bindings to those items finds where they bind it, else at its own bindings or whole.
	 */
	written(
		table: Extract<FromSource, { readonly kind: "table" }>["table"],
		written: string,
		items: ReadonlyArray<FromItem>,
		condition: Expr | undefined,
		env: Env,
		name: PlanName
	): {
		readonly alias: Alias
		readonly items: ReadonlyArray<FromItem>
		readonly where: Expr | undefined
		readonly env: Env
	} {
		const depth = env.depth + 1
		const where: Array<Expr> = [...conjunctsOf(condition)]
		let here: Env = { ...env, depth }
		const bound: Array<BoundEntry> = []
		for (const [place, entry] of entriesOf(items).entries()) {
			const w = writtenOf(entry.source)
			const alias = this.#alias(w)
			bound.push(this.entry(entry, place, where, here, env, alias))
			if (w !== undefined) {
				here = withRelation(here, w, alias, depth, place)
			}
		}
		const alias = this.#alias(written)
		const place = bound.length
		const catalogTable = this.#catalog.table(nameKey(table))
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === depth && d.place < place
		}
		const bindings =
			catalogTable === undefined
				? []
				: where.flatMap((c) => {
						const b = bindingOf(c, written)
						return b !== undefined && catalogTable.columns.has(b.column) ? [b] : []
					})
		const driven = bindings.filter((b) => b.op === "=" && [...qualifiersOf(b.value)].some(earlier))
		if (catalogTable !== undefined && driven.length > 0) {
			const probeAlias = this.#alias(written)
			const probed = this.probeEntry(
				{ join: "cross", source: { kind: "table", table, alias: written } },
				{ kind: "table", table, alias: written },
				catalogTable,
				driven,
				[],
				where,
				here,
				probeAlias,
				["ctid"],
				(conjunct) => {
					const at = where.indexOf(conjunct)
					if (at >= 0) {
						where.splice(at, 1)
					}
				}
			)
			bound.push(probed)
			here = withRelation(here, written, alias, depth, place + 1)
			this.#level(name, [
				...bound,
				{
					source: probed.source,
					step: { join: "cross" },
					item: { alias, scan: { kind: "tid" } },
					method: "nestedLoop"
				}
			])
			const rename = this.renamer(here)
			return {
				alias,
				items: fromOf(bound),
				where: conjunction([
					eq(col(alias, "ctid"), col(probeAlias, "ctid")),
					...where.map((x) => rename.expr(x))
				]),
				env: here
			}
		}
		const many =
			catalogTable !== undefined &&
			bindings.some((b) => catalogTable.columns.get(b.column)?.holds === "many")
		const fixedBindings = bindings.filter((b) =>
			[...qualifiersOf(b.value)].every((a) => {
				const d = here.relations.get(a)
				return d !== undefined && d.depth < depth
			})
		)
		const boundColumns = [...new Set((many ? fixedBindings : []).map((b) => b.column))].toSorted()
		const [b0, ...bs] = boundColumns
		const targetItem: PlanItem<AccessIndexRequest> =
			catalogTable === undefined
				? { alias, scan: { kind: "rows" } }
				: b0 === undefined
					? { alias, scan: { kind: "seq" } }
					: {
							alias,
							scan: {
								kind: "index",
								index: requestOf(
									catalogTable,
									[b0, ...bs],
									[],
									holdsKey(catalogTable, new Set(boundColumns)) ? "key lookup" : "equality lookup"
								),
								bound: boundColumns,
								needs: this.#needed(written)
							}
						}
		here = withRelation(here, written, alias, depth, place)
		this.#level(name, [
			{
				source: { kind: "read", table, alias, access: { kind: "whole" } },
				step: { join: "cross" },
				item: targetItem,
				method: "nestedLoop"
			},
			...bound
		])
		const rename = this.renamer(here)
		return {
			alias,
			items: fromOf(bound),
			where: conjunction(where.map((x) => rename.expr(x))),
			env: here
		}
	}

	update(s: Update, env: Env, name: PlanName): Update {
		const { with: w, env: inner } = this.with(s.with, env)
		const t = this.written(s.table, s.alias, s.from, s.where, inner, name)
		const rename = this.renamer(t.env)
		return {
			...s,
			with: w,
			alias: t.alias,
			set: rename.assignments(s.set),
			from: t.items,
			where: t.where,
			returning: rename.targets(s.returning)
		}
	}

	delete(s: Delete, env: Env, name: PlanName): Delete {
		const { with: w, env: inner } = this.with(s.with, env)
		const t = this.written(s.table, s.alias, s.using, s.where, inner, name)
		return {
			...s,
			with: w,
			alias: t.alias,
			using: t.items,
			where: t.where,
			returning: this.renamer(t.env).targets(s.returning)
		}
	}

	/** A MERGE: its source an item of the MERGE's level, its target joined to it on its ON, read by its ON's bindings. */
	merge(s: Merge, env: Env, name: PlanName): Merge {
		const { with: w, env: inner } = this.with(s.with, env)
		const t = this.written(s.table, s.alias, [s.using], s.on, inner, name)
		const [using] = t.items
		if (using === undefined || t.items.length !== 1) {
			return defect("a MERGE's one source, bound as one item")
		}
		const rename = this.renamer(t.env)
		return {
			...s,
			with: w,
			alias: t.alias,
			using,
			on: t.where ?? lit.bool(true),
			whens: mapWhens(s.whens, (when) => rename.mergeWhen(when)),
			returning: rename.targets(s.returning)
		}
	}

	/** A query bound as a statement's top level, its columns' needs read off it first. */
	selectOf(q: Select): Select {
		this.#needs = neededColumns(q)
		this.#whole = false
		return this.setQuery(q, topEnv, { kind: "top" })
	}

	/** A routine bound (`routine`), its columns' needs read off it first. */
	routineOf(fn: CreateFunction): CreateFunction {
		this.#needs = neededColumns(fn)
		this.#whole = false
		return this.routine(fn)
	}

	/**
	 * A routine bound under the scope (sql/naming.ts AdviceScope `routine`): each statement PL/pgSQL hands the planner
	 * its own top level, a PL variable and a record's field a value it fixes; a SQL function's body one SELECT of it.
	 */
	routine(fn: CreateFunction): CreateFunction {
		if (fn.language === "sql") {
			return { ...fn, body: this.expr(fn.body, topEnv) }
		}
		return { ...fn, body: this.block(fn.body) }
	}

	block(b: PlBlock): PlBlock {
		const [first, ...rest] = b.body
		return { ...b, body: [this.pl(first), ...rest.map((s) => this.pl(s))] }
	}

	pl(s: PlStatement): PlStatement {
		const plain = (e: Expr) => this.expr(e, topEnv)
		switch (s.kind) {
			case "if": {
				const [b0, ...bs] = s.branches
				const branch = (b: typeof b0) => ({
					condition: plain(b.condition),
					body: b.body.map((x) => this.pl(x))
				})
				return {
					...s,
					branches: [branch(b0), ...bs.map(branch)],
					else: s.else.map((x) => this.pl(x))
				}
			}
			case "assign":
				return { ...s, value: plain(s.value) }
			case "forQuery":
				return {
					...s,
					query: this.setQuery(s.query, topEnv, { kind: "top" }),
					body: s.body.map((x) => this.pl(x))
				}
			case "perform": {
				const q = this.query(operandSelect(s.query.body), topEnv, { kind: "top" })
				const body = q.body
				return body.kind === "core"
					? { ...s, query: { ...s.query, body } }
					: defect("a PERFORM of one core bound one core")
			}
			case "whenFound": {
				const [b0, ...bs] = s.body
				return {
					...s,
					query: this.query(s.query, topEnv, { kind: "top" }),
					body: [this.pl(b0), ...bs.map((x) => this.pl(x))]
				}
			}
			case "wholeReads": {
				const whole = this.#whole
				this.#whole = true
				const [b0, ...bs] = s.body
				const body = [this.pl(b0), ...bs.map((x) => this.pl(x))] as const
				this.#whole = whole
				return { ...s, body }
			}
			case "case": {
				const [w0, ...ws] = s.whens
				const when = (w: typeof w0) => ({
					values: [plain(w.values[0]), ...w.values.slice(1).map(plain)] as const,
					body: w.body.map((x) => this.pl(x))
				})
				return { ...s, operand: plain(s.operand), whens: [when(w0), ...ws.map(when)] }
			}
			case "raise":
				return { ...s, using: s.using.map((o) => ({ ...o, value: plain(o.value) })) }
			case "return":
				return { ...s, value: plain(s.value) }
			case "modify": {
				const statement = s.statement
				switch (statement.kind) {
					case "insert":
						return { ...s, statement: this.insert(statement, topEnv, { kind: "top" }) }
					case "update":
						return { ...s, statement: this.update(statement, topEnv, { kind: "top" }) }
					case "delete":
						return { ...s, statement: this.delete(statement, topEnv, { kind: "top" }) }
					case "merge":
						return { ...s, statement: this.merge(statement, topEnv, { kind: "top" }) }
				}
			}
			case "returnQuery":
				return { ...s, query: this.query(s.query, topEnv, { kind: "top" }) }
			case "createSessionTable":
			case "createSessionIndex":
			case "createSessionTrigger":
			case "truncateSessionTable":
				return s
		}
	}
}

/** Whether a core is a set, as a UNION ALL's proof requires of each arm. */
const isSetBodyCore = (core: SelectCore) =>
	core.distinct !== false || core.rows !== "operand"
		? core
		: defect("a UNION ALL arm bound a set still, as its proof requires")

/** A MERGE's WHENs, each mapped. */
const mapWhens = <W>(whens: NonEmptyReadonlyArray<W>, f: (w: W) => W): NonEmptyReadonlyArray<W> => {
	const [w0, ...ws] = whens
	return [f(w0), ...ws.map(f)]
}

/**
 * A routine bound under a scope of its own (sql/naming.ts AdviceScope), with the plan of its statements and each query
 * PL/pgSQL hands the planner (`plannedOf`).
 */
export interface BoundRoutine {
	readonly fn: CreateFunction
	readonly plan: ReadPlan<AccessIndexRequest>
	readonly planned: ReadonlyArray<string>
}

/**
 * The routine `fn`, bound over `catalog` under a scope of its own, each statement PL/pgSQL hands the planner its own
 * top level (see the header), after its logical rewrites (sql/print-once.ts printedOnce).
 */
export const bindRoutine = (
	fn: CreateFunction,
	scope: AdviceScope,
	catalog: ReadCatalog
): BoundRoutine => {
	const binder = new Binder(scope, catalog)
	const once = printedOnce(fn)
	if (once.kind !== "createFunction") {
		return defect("a routine printed once a routine still")
	}
	const bound = binder.routineOf(once)
	return {
		fn: bound,
		plan: binder.plan(),
		planned: plannedOf(bound, catalog.fired(nameKey(fn.name)))
	}
}

/** A name PL/pgSQL reads in a query, as the planner gets it: a typed placeholder, each name one number. */
interface Placed {
	readonly number: number
	readonly type: TypeRef
}

/**
 * Each query PL/pgSQL hands the planner of the bound routine `fn`, in body order, printed by the one printer of its
 * statements (sql/print.ts), every PL/pgSQL name it reads a typed placeholder `$n::<type>`, numbered in the order the
 * query reads them, as PL/pgSQL passes each variable a parameter of its datum's type (pl_comp.c make_datum_param): a
 * declared variable or argument by its declared type, a field of NEW or OLD by its column's in `fired`, the table the
 * trigger fires on, TG_TABLE_NAME and TG_TABLE_SCHEMA a `name`, TG_OP a `text`. A PERFORM is the SELECT its keyword
 * replaces, a probe's `PERFORM 1 FROM (<query>) AS "found"` likewise (pl_exec.c exec_stmt_perform), a FOR's and a RETURN
 * QUERY's their query, a data-modifying statement itself, and every expression `SELECT <expr>` (exec_eval_expr), but
 * a RETURN of a name alone, which plans nothing (pl_gram.y make_return_stmt `retvarno`). An SQL function's body is
 * `SELECT <body>`, its arguments its own placeholders. A name of no declaration is an internal compiler error.
 */
const plannedOf = (
	fn: CreateFunction,
	fired: ReadonlyMap<string, TypeRef> | undefined
): ReadonlyArray<string> => {
	if (fn.language === "sql") {
		return [printPlannedQuery({ kind: "expr", expr: fn.body })]
	}
	const declared = new Map([...fn.params, ...fn.body.declare].map((d) => [d.name, d.type] as const))
	const out: Array<string> = []
	/** What `print` prints of what `placing` places, each name it reads a placeholder, numbered afresh: one query. */
	const placed = (print: (t: Transform) => string): void => {
		const numbers = new Map<string, Placed>()
		const at = (name: string, type: TypeRef): Expr => {
			const known = numbers.get(name) ?? { number: numbers.size + 1, type }
			numbers.set(name, known)
			return {
				kind: "param",
				slot: { placeholder: "value", number: known.number },
				type: known.type
			}
		}
		const name = (x: Expr): Expr | undefined => {
			if (x.kind === "plVar") {
				return at(
					x.name,
					declared.get(x.name) ?? defect(`the declaration of ${x.name} in ${fn.name.name}`)
				)
			}
			if (x.kind === "field") {
				return x.record.kind === "plSpecial"
					? at(
							`${x.record.name}.${x.field}`,
							fired?.get(x.field) ??
								defect(`the column ${x.field} of the table ${fn.name.name} fires on`)
						)
					: defect(`a field of the record ${x.record.name} in a query of ${fn.name.name}`)
			}
			if (x.kind !== "plSpecial") {
				return undefined
			}
			if (x.name === "TG_OP") {
				return at(x.name, types.text)
			}
			return x.name === "TG_TABLE_NAME" || x.name === "TG_TABLE_SCHEMA"
				? at(x.name, builtinType("name"))
				: defect(`the row ${x.name} whole in a query of ${fn.name.name}`)
		}
		const t = new (class extends Transform {
			override readonly expr = (x: Expr): Expr => name(x) ?? this.exprChildren(x)
		})(identityHooks)
		out.push(print(t))
	}
	const query = (q: OperandSelect) =>
		placed((t) => printPlannedQuery({ kind: "query", query: t.select(q) }))
	const expr = (e: Expr) => placed((t) => printPlannedQuery({ kind: "expr", expr: t.expr(e) }))
	const walk = (statements: ReadonlyArray<PlStatement>): void => {
		for (const s of statements) {
			switch (s.kind) {
				case "if":
					for (const b of s.branches) {
						expr(b.condition)
						walk(b.body)
					}
					walk(s.else)
					break
				case "assign":
					expr(s.value)
					break
				case "forQuery":
					query(s.query)
					walk(s.body)
					break
				case "perform": {
					const performed = s.query
					placed((t) => {
						const body = t.select(operandSelect(performed.body)).body
						return body.kind === "core"
							? printPlannedQuery({
									kind: "perform",
									query: {
										body,
										orderBy: t.orderItems(performed.orderBy),
										limit: performed.limit === undefined ? undefined : t.expr(performed.limit),
										offset: performed.offset === undefined ? undefined : t.expr(performed.offset)
									}
								})
							: defect("a PERFORM's one core placed one core")
					})
					break
				}
				case "whenFound": {
					const found = s.query
					placed((t) => printPlannedQuery({ kind: "found", query: t.select(found) }))
					walk(s.body)
					break
				}
				case "wholeReads":
					walk(s.body)
					break
				case "case":
					expr(s.operand)
					for (const w of s.whens) {
						for (const v of w.values) {
							expr(v)
						}
						walk(w.body)
					}
					break
				case "raise":
					for (const o of s.using) {
						expr(o.value)
					}
					break
				case "return":
					if (s.value.kind !== "plVar" && s.value.kind !== "plSpecial") {
						expr(s.value)
					}
					break
				case "modify": {
					const modified = s.statement
					placed((t) => printStatement(t.statement(modified)))
					break
				}
				case "returnQuery":
					query(s.query)
					break
				case "createSessionTable":
				case "createSessionIndex":
				case "createSessionTrigger":
				case "truncateSessionTable":
					break
			}
		}
	}
	walk(fn.body.body)
	return out
}

/** The query `query`, bound as a statement is (`bindStatement`), a query still. */
export const bindSelect = (
	query: Select,
	scope: AdviceScope,
	catalog: ReadCatalog
): BoundStatement<Select> => {
	const once = printedOnce(query)
	if (once.kind !== "select") {
		return defect("a query printed once a query still")
	}
	const binder = new Binder(scope, catalog)
	const bound = binder.selectOf(once)
	return nominal<
		{ readonly statement: Select; readonly plan: ReadPlan<AccessIndexRequest> },
		BoundStatement<Select>
	>()({
		statement: bound,
		plan: binder.plan()
	})
}

/**
 * The statement `statement`, bound under `scope` over `catalog` (see the header), after its logical rewrites
 * (sql/print-once.ts printedOnce): the only form anything prints or plans from.
 */
export const bindStatement = (
	statement: SqlStatement,
	scope: AdviceScope,
	catalog: ReadCatalog
): BoundStatement => {
	const binder = new Binder(scope, catalog)
	const bound = binder.statement(printedOnce(statement), false)
	return nominal<
		{ readonly statement: SqlStatement; readonly plan: ReadPlan<AccessIndexRequest> },
		BoundStatement
	>()({ statement: bound, plan: binder.plan() })
}
