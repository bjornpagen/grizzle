import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type {
	UnboundUnitReadCause,
	UnfixedReason,
	UnstoredDerivationCause
} from "#compiler/core/causes.ts"
import {
	type BinaryOperator,
	builtinFunctions,
	type Cte,
	cteColumns,
	type Expr,
	type FromItem,
	type FromSource,
	type NameKey,
	nameKey,
	type ObjectName,
	type OperandSelect,
	type SelectCore,
	selectColumns,
	type SetOperand,
	type SqlStatement,
	type Target
} from "#compiler/sql/ast.ts"
import { carrierReadBy } from "#compiler/sql/naming.ts"
import {
	fencingTarget,
	ownLevel,
	printedOnce,
	printedQueryOnce,
	pulledUp,
	subqueryForm
} from "#compiler/sql/print-once.ts"
import { identityHooks, transformQuery, transformStatement } from "#compiler/sql/transform.ts"

/**
 * Unit-bound reads: in every statement a call runs, each scan of a relation under a declared unit reads that unit's rows
 * alone, at units the call fixes.
 *
 * The invariant. Let S be a statement grizzle prints for one call (a served read, a write's statements, parted or
 * riding, its read-backs and memberships, and the judges and upkeeps its COMMIT runs over its delta), and R a stored
 * relation under a declared unit U (schema/own.ts OwnedUnit), whose primary key leads with U's fields F, or a stored
 * derived relation whose admission seats it under U at its fields F (ir/unit.ts StoredUnit `declared`). Every scan of R
 * in S compares each field of F, at that scan, to a value fixed for the scan, or every column of one of R's declared
 * keys, which reads one row, of one unit, or columns a dependency its declared containments give it makes determine F
 * (ReadTable `determined`):
 *
 * - (a) a constant of the statement's own: a parameter, a literal, the clock, a claim (a context source, a query of no
 *   FROM PostgreSQL pulls up into a stable expression), or an expression of those alone;
 * - (b) a column of an outer row a query block reads that PostgreSQL evaluates per outer row (a LATERAL or a sub-link it
 *   keeps as a SubPlan, its outer columns its parameters), where that column is held;
 * - (c) whatever an equality of the scan's level makes one with (a) or (b): its equivalence class;
 * - (d) for a membership (= ANY), the elements of an ARRAY of a sub-select that reads no outer row, which PostgreSQL
 *   evaluates once (an InitPlan, its array a parameter), where its output is held: the values of the call's rows,
 *   `root = ANY (ARRAY(SELECT DISTINCT … FROM r1))`, or of a keyed chain, never every unit's.
 *
 * A column is held where its level fixes it so, where its row is a stored relation's read at a held non-empty prefix of
 * one of its declared keys (a keyed chain: a course's packages read at the course; cte-policy boundPrefix), or where it
 * is an output of a query PostgreSQL computes apart whose expression there is held (lineage). The call's own rows are
 * held: its relation inputs, VALUES of its values, its claims, the rows its statements wrote and the carriers a write
 * stages its rows in, read through their readers (sql/naming.ts carrierReadBy).
 *
 * Why it bounds the read: F leads R's primary key, so a comparison of F to values fixed per scan is an index condition on
 * that key in every plan PostgreSQL may choose, each scan reading the held units' rows alone, whatever its statistics.
 * Two shapes hold the unit only through a join, so they are unbound by construction, each a plan PostgreSQL chooses by
 * its estimates: a scan equated to a keyed sibling of its own level, which a hash join reads whole; and a restriction of
 * a query PostgreSQL computes apart that it cannot move into it, a join's equality, or any past a bound, a window or a
 * materialized CTE.
 *
 * The level is PostgreSQL's after its deterministic rewrites of the statement, before any choice by cost, and the walk
 * models each one, and nothing it does not model makes a scan bound: a query no clause fences is pulled up into its
 * reader (prepjointree.c is_simple_subquery), so its scans join their reader's level and its targets are their
 * expressions; a CTE read once is printed in place (print-once.ts), and one stated NOT MATERIALIZED read in place at each
 * read; an EXISTS or an uncorrelated IN of a top-level conjunct becomes a semi-join, whose equalities join the level's
 * classes, since an outer row it keeps holds the inner side's constant, and a NOT EXISTS an anti-join (subselect.c
 * convert_EXISTS_sublink_to_join, convert_ANY_sublink_to_join), whose inner side takes a constant of the outer side's
 * class and never gives one back, as a LEFT JOIN's inner side does (equivclass.c reconsider_outer_join_clauses), but
 * for a LEFT JOIN whose inner side a strict conjunct of the WHERE reads, which is an inner join (prepjointree.c
 * reduce_outer_joins); an
 * equality's two sides are one class, a class of a constant fixing every member
 * (equivclass.c); a class's constant is moved into a query computed apart through DISTINCT, a grouping key and the
 * arms of a union or an intersection, never past a bound, a window, a set-returning target or an EXCEPT (allpaths.c
 * subquery_push_qual); a sub-link kept as a SubPlan reads its outer columns as parameters, and one that reads no outer
 * row is an InitPlan PostgreSQL evaluates once, its output a parameter of its level (subselect.c make_subplan).
 *
 * A stored derived relation whose rows are an open frontier is no relation a scan must fix a unit of (UnitReach
 * `frontier`): its rows are one relation's that no fact of another settles yet, each removed by the upkeep of the
 * COMMIT that settles it, so a read of it, whole or not, costs its open rows, never its settled history
 * (analysis/theory/unit.ts frontierOf).
 *
 * Out of the invariant, by what they are: a migration's backfill of a stored derived relation fills every unit's rows,
 * which no call fixes; a deploy-time violation probe and the drift check judge the whole installation, which no call
 * runs. Neither is a statement of a call, so neither is walked.
 *
 * The walk also finds a closed derivation PostgreSQL computes whole in a call's statement: a query that reads stored
 * rows, no parameter and no outer row, at a site PostgreSQL computes it apart (a CTE's body, a sub-link, a FROM query a
 * clause fences that no constant reaches), whose rows are one set for every call, which the installation stores or the
 * statement reads at a key.
 */

/**
 * What a scan of a table must fix (the module header): its declared unit's key, where it sits under a declared unit
 * (`member`), by the columns that hold it; nothing where it sits under none; and nothing where it is a stored derived
 * relation whose rows are an open frontier (analysis/theory/unit.ts frontierOf), one relation's rows that no fact of
 * another (`settledBy`) settles yet, each leaving it at its own settlement, so a read of it, whole or not, reads open
 * rows alone, never the history its settled rows were.
 */
export type UnitReach =
	| {
			readonly kind: "member"
			readonly name: string
			readonly columns: NonEmptyReadonlyArray<string>
	  }
	| { readonly kind: "frontier"; readonly name: string; readonly settledBy: string }
	| { readonly kind: "none" }

/** A table a statement may read, as the schema declares it: its relation, its declared keys and its unit. */
export interface ReadTable {
	readonly relation: string
	/** Each declared key, the primary key first, by its columns. */
	readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
	/** What a scan of it must fix (`UnitReach`). */
	readonly unit: UnitReach
	/**
	 * The dependencies its declared containments give it, by its columns (ir/keys.ts ContainedDependency): a row's values
	 * at `by` determine its values at `columns`, so a scan that fixes `by` reads the rows of one value of them.
	 */
	readonly determined: ReadonlyArray<{
		readonly by: NonEmptyReadonlyArray<string>
		readonly columns: NonEmptyReadonlyArray<string>
	}>
}

/** The tables a statement may read, by the name it reads them under (sql/ast.ts nameKey). */
export type ReadTables = ReadonlyMap<NameKey, ReadTable>

/**
 * A fault of a statement's reads (readFaults): a scan of a unit's relation at no unit the call fixes, or a closed
 * derivation computed whole (core/causes.ts), each but the statement it stands in, which its judge names.
 */
export type ReadFault =
	| ({ readonly kind: "unboundUnitRead" } & Omit<UnboundUnitReadCause, "statement">)
	| ({ readonly kind: "wholeDerivation" } & Omit<UnstoredDerivationCause, "statement">)

/** A column of an item, or a constant, as an equality's side reads it. */
type Term =
	| { readonly kind: "column"; readonly item: Item; readonly column: string }
	| { readonly kind: "constant" }
	| { readonly kind: "opaque" }

/** What a level's items are: a scan of a table, a query computed apart, a CTE's rows, rows the call holds, a function's rows, a driven read. */
type Item =
	| {
			readonly kind: "scan"
			readonly alias: string
			readonly table: ObjectName
			readonly facts: ReadTable | undefined
			readonly group: number
			readonly at: ReadonlyArray<string>
	  }
	| {
			readonly kind: "apart"
			readonly alias: string
			readonly columns: ReadonlyArray<string>
			readonly query: OperandSelect
			readonly lateral: boolean
			readonly group: number
			readonly at: ReadonlyArray<string>
			/** Each output column's held, once the query is walked. */
			held: ReadonlyArray<boolean> | undefined
	  }
	| {
			readonly kind: "cteScan"
			readonly alias: string
			readonly cte: CteDef
			readonly group: number
	  }
	| {
			readonly kind: "given"
			readonly alias: string
			readonly group: number
			/** Each column's value where it is an expression of the level, none where it is the call's own. */
			readonly columns: ReadonlyMap<string, Expr>
			/**
			 * Whether its every column is a constant of the statement's: a context source's claims, a query of no FROM
			 * over the session's setting that PostgreSQL pulls up into a stable expression of each claim.
			 */
			readonly constant: boolean
	  }
	| {
			readonly kind: "pulled"
			readonly alias: string
			readonly group: number
			readonly targets: ReadonlyMap<string, Expr>
	  }
	| {
			readonly kind: "driven"
			readonly alias: string
			readonly group: number
			/** The driven read's held columns, by the name it delivers them under. */
			held: ReadonlySet<string>
	  }

/** A CTE as its readers see it: its columns and, once walked, each column's held. */
interface CteDef {
	readonly name: string
	readonly columns: ReadonlyArray<string>
	readonly query: Cte["query"]
	readonly inPlace: boolean
	held: ReadonlyArray<boolean> | undefined
	/** Whether its body reads a value of the call's (holdsParameter), once worked out. */
	parameterized: boolean
}

/**
 * The rows a condition's sub-link may read of the query the condition stands in and still be made a join (#where,
 * subselect.c available_rels): a WHERE's, every row of the level (`every`); a join's condition, those of its sides, the
 * level's other rows its query's too (`join`); and a query pulled up into the level, its own rows alone, which
 * PostgreSQL converts its sub-links in before it pulls it up, the level's other rows its outer rows, a parameter's
 * (`query`).
 */
type Available =
	| { readonly kind: "every" }
	| { readonly kind: "join"; readonly rows: ReadonlySet<string> }
	| { readonly kind: "query"; readonly rows: ReadonlySet<string> }

/** What a CTE's copy read in place renames each alias of its body with, before the read's alias (#copyAt). */
const copyMark = "\u00b7"

/** The alias a statement prints for one the walk renamed in a CTE's copy (#copyAt). */
const printedAlias = (a: string): string => a.split(copyMark)[0] ?? a

/**
 * The rows a condition's place in the join tree stands above (#reduce): every row of the level, for its WHERE, a
 * restriction moved in from outside or a semi-join's condition, which wraps them; or a query's own, for the WHERE of a
 * query pulled up into the level and a join's condition, which stand above their own rows alone (prepjointree.c
 * reduce_outer_joins reads a FromExpr's or a JoinExpr's quals for the joins below it).
 */
type Scope = "every" | ReadonlySet<string>

/** A WHERE's: every row of the level. */
const everyRow: Available = { kind: "every" }

/** The CTEs visible where a query stands, by name, innermost first. */
type CteScope = ReadonlyArray<ReadonlyMap<string, CteDef>>

/** A union-find over a level's column keys and its constant. */
class Classes {
	readonly #parent = new Map<string, string>()
	find(k: string): string {
		let at = k
		for (
			let next = this.#parent.get(at);
			next !== undefined && next !== at;
			next = this.#parent.get(at)
		) {
			at = next
		}
		return at
	}
	union(a: string, b: string): void {
		const [x, y] = [this.find(a), this.find(b)]
		if (!this.#parent.has(y)) {
			this.#parent.set(y, y)
		}
		if (x !== y) {
			this.#parent.set(x, y)
		}
	}
	members(k: string): number {
		return this.keysWith(k).length
	}
	/** Every key in `k`'s class. */
	keysWith(k: string): ReadonlyArray<string> {
		const root = this.find(k)
		return [...this.#parent.keys()].filter((key) => this.find(key) === root)
	}
}

/**
 * The restrictions of a query's reader PostgreSQL may move into it, where its clauses let it (allpaths.c
 * subquery_push_qual): its output positions a restriction fixes, each by how (Level `pushed`); and the pairs of its
 * output positions one class of the reader holds both of, which an equality of the two restricts the query by
 * (equivclass.c generate_base_implied_equalities, a class's two members of one relation).
 */
interface Pushed {
	readonly fixed: ReadonlyMap<number, "class" | "member">
	readonly equal: ReadonlyArray<readonly [number, number]>
}

/** No restriction moved in from outside. */
const nothingPushed: Pushed = { fixed: new Map(), equal: [] }

/** The constant's key in a level's classes. */
const constantKey = "#constant"

/** Whether an expression calls a VOLATILE function at its own level. */
const volatileIn = (e: Expr): boolean => {
	let found = false
	ownLevel(e, (x) => {
		if (x.kind === "call") {
			found ||=
				x.fn.kind === "qualified"
					? x.fn.volatility === "VOLATILE"
					: builtinFunctions[x.fn.name].volatility === "VOLATILE"
		}
	})
	return found
}

/** The sub-link queries `e` holds at its own level. */
const sublinksOf = (
	e: Expr
): ReadonlyArray<{ readonly query: OperandSelect; readonly label: string }> => {
	const out: Array<{ readonly query: OperandSelect; readonly label: string }> = []
	ownLevel(e, (x) => {
		if (x.kind === "exists") {
			out.push({ query: x.query, label: x.not ? "notExists" : "exists" })
		} else if (x.kind === "inQuery") {
			out.push({ query: x.query, label: x.not ? "notIn" : "in" })
		} else if (x.kind === "subquery") {
			out.push({ query: x.query, label: "scalar" })
		} else if (x.kind === "array") {
			out.push({ query: x.query, label: "array" })
		}
	})
	return out
}

/** A value's JSON text, a bigint spelled as its digits: the structure the walk compares and searches. */
const textOf = (v: unknown): string =>
	JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? `${x}n` : x))

/** The comparisons of PostgreSQL's builtin operators, each strict: NULL on either side compares as NULL. */
const strictComparisons: ReadonlySet<BinaryOperator> = new Set<BinaryOperator>([
	"=",
	"<>",
	"<",
	"<=",
	">",
	">="
])

/**
 * The aliases a condition reads where it is NULL or false on a row that holds NULL there: a builtin comparison's or a
 * membership's column operand, as written or cast. A left join whose inner side's alias a condition of the joins above
 * it reads so keeps no row it extends with NULLs, so PostgreSQL makes it an inner join (prepjointree.c
 * reduce_outer_joins, find_nonnullable_rels), its scans one class with the level's own.
 */
const strictlyRead = (c: Expr): ReadonlyArray<StrictColumn> =>
	c.kind === "binary" && c.schema === undefined && strictComparisons.has(c.op)
		? [...strictOperand(c.left), ...strictOperand(c.right)]
		: c.kind === "equalsAny" || (c.kind === "inList" && !c.not)
			? strictOperand(c.expr)
			: []

/** A column a strict condition reads, by the alias it reads it under. */
interface StrictColumn {
	readonly table: string
	readonly column: string
}

/** A strict comparison's operand where it is a column, as written or cast: a NULL there is the whole's. */
const strictOperand = (e: Expr): ReadonlyArray<StrictColumn> =>
	e.kind === "column" && e.table !== undefined
		? [{ table: e.table, column: e.column }]
		: e.kind === "cast"
			? strictOperand(e.expr)
			: []

/**
 * A query of `from` and `where` alone, no target: what a summary of a part of a query reads (Summaries), its FROM's rows
 * or a condition's.
 */
const readOf = (from: ReadonlyArray<FromItem>, where: Expr | undefined): OperandSelect => ({
	kind: "select",
	with: undefined,
	body: {
		kind: "core",
		distinct: false,
		rows: "operand",
		from,
		where,
		targets: [],
		groupBy: [],
		having: undefined
	},
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/** The conjuncts of a condition: its AND's arguments, flattened. */
const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined ? [] : e.kind === "and" ? e.args.flatMap((a) => conjunctsOf(a)) : [e]

/** Whether two expressions are one by their structure (a grouping key and a target's). */
const sameExpr = (a: Expr, b: Expr): boolean => textOf(a) === textOf(b)

/** The names a FROM query's columns are read under: its column list, else each target's alias or column. */
const columnNames = (
	columns: ReadonlyArray<string>,
	targets: ReadonlyArray<Target>
): ReadonlyArray<string> =>
	columns.length > 0
		? columns
		: targets.map((t) => t.alias ?? (t.expr.kind === "column" ? t.expr.column : ""))

/** The targets of a query's first core: the columns a set operation's arms deliver by position. */
const targetsOf = (q: OperandSelect | SetOperand): ReadonlyArray<Target> => {
	if (q.kind === "core") {
		return q.targets
	}
	switch (q.body.kind) {
		case "core":
			return q.body.targets
		case "setOp":
			return targetsOf(q.body.arms[0])
		case "select":
			return targetsOf(q.body)
	}
}

/**
 * What a query holds at any depth, read once (Summaries): the aliases it defines and the aliases its column references
 * read, the CTEs its sources read by name, the stored tables it scans, and whether it reads a value of the call's (a
 * parameter or the clock) or calls a VOLATILE function.
 */
interface Summary {
	readonly defined: ReadonlySet<string>
	readonly read: ReadonlySet<string>
	readonly ctes: ReadonlySet<string>
	readonly tables: ReadonlySet<NameKey>
	readonly parameter: boolean
	readonly volatile: boolean
}

/**
 * The summaries of one walk's queries, each built once from its sub-queries' (Summary): a walk asks of each query it
 * computes apart whether it is closed and parameter-free, and of nested ones it asks again, so each is read once and
 * its parents fold its summary in, the walk linear in the statement.
 */
class Summaries {
	readonly #known = new WeakMap<OperandSelect, Summary>()

	of(q: OperandSelect): Summary {
		const known = this.#known.get(q)
		if (known !== undefined) {
			return known
		}
		const defined = new Set<string>()
		const read = new Set<string>()
		const ctes = new Set<string>()
		const tables = new Set<NameKey>()
		let parameter = false
		let volatile = false
		const fold = (inner: Summary): void => {
			for (const a of inner.defined) {
				defined.add(a)
			}
			for (const a of inner.read) {
				read.add(a)
			}
			for (const c of inner.ctes) {
				ctes.add(c)
			}
			for (const t of inner.tables) {
				tables.add(t)
			}
			parameter ||= inner.parameter
			volatile ||= inner.volatile
		}
		const expr = (e: Expr): void => {
			ownLevel(e, (x) => {
				if (x.kind === "column" && x.table !== undefined) {
					read.add(x.table)
				} else if (x.kind === "param" || x.kind === "clock") {
					parameter = true
				}
			})
			volatile ||= volatileIn(e)
			for (const s of sublinksOf(e)) {
				fold(this.of(s.query))
			}
		}
		const source = (s: FromSource): void => {
			switch (s.kind) {
				case "table":
					defined.add(s.alias)
					if (typeof s.table !== "string") {
						tables.add(nameKey(s.table))
					}
					break
				case "transition":
				case "context":
				case "enclosing":
					defined.add(s.alias)
					break
				case "metRows":
					defined.add(s.alias)
					ctes.add(s.proposed)
					ctes.add(s.insert)
					break
				case "cte":
					defined.add(s.alias ?? s.name)
					ctes.add(s.name)
					break
				case "derived":
					defined.add(s.alias)
					fold(this.of(s.query))
					break
				case "function":
					defined.add(s.alias)
					expr(s.call)
					break
				case "arrays":
					defined.add(s.alias)
					if (s.source.kind === "carried") {
						for (const c of s.source.columns) {
							expr(c.array)
						}
					} else {
						parameter = true
					}
					break
				case "values":
					defined.add(s.alias)
					for (const row of s.rows) {
						for (const e of row) {
							expr(e)
						}
					}
					break
				case "probe":
					defined.add(s.alias)
					defined.add(s.inner)
					tables.add(nameKey(s.table))
					for (const c of s.by.columns) {
						expr(c.value)
					}
					for (const f of s.filter) {
						expr(f)
					}
					break
				case "met":
					defined.add(s.alias)
					defined.add(s.inner)
					tables.add(nameKey(s.table))
					read.add(s.rows)
					for (const f of s.filter) {
						expr(f)
					}
					break
			}
		}
		const item = (i: FromItem): void => {
			if (i.kind === "joins") {
				source(i.first)
				for (const step of i.steps) {
					source(step.source)
					if (step.kind !== "cross") {
						expr(step.on)
					}
				}
			} else {
				source(i)
			}
		}
		const core = (c: SelectCore): void => {
			for (const i of c.from) {
				item(i)
			}
			if (c.where !== undefined) {
				expr(c.where)
			}
			for (const t of c.targets) {
				expr(t.expr)
			}
			for (const g of c.groupBy) {
				expr(g)
			}
			if (c.having !== undefined) {
				expr(c.having)
			}
		}
		for (const c of q.with?.ctes ?? []) {
			defined.add(c.name)
			if (c.query.kind === "select") {
				fold(this.of(c.query))
			}
		}
		switch (q.body.kind) {
			case "core":
				core(q.body)
				break
			case "setOp":
				for (const arm of q.body.arms) {
					if (arm.kind === "core") {
						core(arm)
					} else {
						fold(this.of(arm))
					}
				}
				break
			case "select":
				fold(this.of(q.body))
				break
		}
		for (const o of q.orderBy) {
			expr(o.expr)
		}
		for (const e of [q.limit, q.offset]) {
			if (e !== undefined) {
				expr(e)
			}
		}
		const summary: Summary = { defined, read, ctes, tables, parameter, volatile }
		this.#known.set(q, summary)
		return summary
	}

	/** Whether a query reads a name defined outside it, a CTE of `ctes` aside: an outer row. */
	readsOutside(q: OperandSelect, ctes: CteScope): boolean {
		const { defined, read } = this.of(q)
		for (const a of read) {
			if (!defined.has(a) && !ctes.some((m) => m.has(a))) {
				return true
			}
		}
		return false
	}

	/**
	 * Whether a query reads a value of the call's: a parameter at any depth, the clock, the call's input, or a CTE of
	 * `ctes` whose body does, which a reader of it reads through the CTE.
	 */
	holdsParameter(q: OperandSelect, ctes: CteScope): boolean {
		const summary = this.of(q)
		if (summary.parameter) {
			return true
		}
		for (const name of summary.ctes) {
			const def = ctes.map((m) => m.get(name)).find((d) => d !== undefined)
			if (def?.parameterized === true) {
				return true
			}
		}
		return false
	}
}

/** One level of the statement, as PostgreSQL plans it after its rewrites: the walk's unit of equality. */
class Level {
	readonly items = new Map<string, Item>()
	/** The level's conditions, each with the group it binds: 0 the level's own joins, any other an inner side's. */
	readonly quals: Array<{ readonly expr: Expr; readonly group: number; readonly scope: Scope }> = []
	/**
	 * Each inner side's kind, by its group, an anti-join's or a left join's, and the group its join stands in: the outer
	 * side gives it constants and takes none back. A semi-join's inner side is in the group of its join.
	 */
	readonly groups: Array<{ readonly kind: "inner" | "outer"; readonly parent: number }> = [
		{ kind: "inner", parent: 0 }
	]
	/**
	 * Expressions a restriction PostgreSQL moved in from outside fixes, each in its group: by an equality to a constant,
	 * which fixes its class, or by a membership of constants, which fixes it alone.
	 */
	readonly pushed: Array<{
		readonly expr: Expr
		readonly group: number
		readonly by: "class" | "member"
	}> = []
	/** The queries the level reads as SubPlans. */
	readonly subplans: Array<{ readonly query: OperandSelect; readonly label: string }> = []
	/** Each group's classes, once built. */
	readonly classes: Array<Classes> = []
	/** Columns a set membership fixes (= ANY of an array of constants, IN of constants), not their class. */
	readonly members = new Set<string>()
	/**
	 * Each sub-link that reads no row of the level, which PostgreSQL evaluates once per run of the level as an InitPlan,
	 * its output a parameter of the level (subselect.c make_subplan, a sub-link of no parParam): the held of its output
	 * columns, walked before the level's classes.
	 */
	readonly initPlans = new Map<OperandSelect, ReadonlyArray<boolean>>()
	/**
	 * Whether PostgreSQL proves the level reads no row: one class of its own joins equated to two different literals
	 * (equivclass.c generate_base_implied_equalities_const, a constant-false clause), so it plans none of its scans and
	 * none of the queries it reads apart; the sub-links of its conditions it still plans, as SubPlans.
	 */
	empty = false
	/** The left joins' groups PostgreSQL makes inner joins (reduce_outer_joins), each read as the level's own. */
	readonly reduced = new Set<number>()
	/**
	 * The semi-join each item a semi-join brought into the level stands in, by its alias, each semi-join by its place
	 * among the level's: a self-join elimination joins two scans of one join domain alone (#twins), the level's own
	 * joins or one semi-join's inner side.
	 */
	readonly semiJoined = new Map<string, number>()
	#semiJoins = 0

	/** The next semi-join's place among the level's. */
	semiJoin(): number {
		this.#semiJoins += 1
		return this.#semiJoins
	}
	readonly parent: Level | undefined
	readonly ctes: CteScope
	readonly #ids = new WeakMap<Item, number>()
	#next = 0

	constructor(parent: Level | undefined, ctes: CteScope) {
		this.parent = parent
		this.ctes = ctes
	}

	/** The sub-links `e` holds, each a query the level reads as a SubPlan. */
	readsApart(e: Expr): void {
		for (const s of sublinksOf(e)) {
			this.subplans.push(s)
		}
	}

	/**
	 * Whether the rows of group `outer` are non-null where group `inner`'s conditions read them: `outer` is `inner` or a
	 * group its join stands in, at any remove. A left join's inner side, read above its join, may be NULL there, so a
	 * constant its own class holds fixes none of the reads of it from outside (equivclass.c: a class's members below an
	 * outer join are no members above it).
	 */
	encloses(outer: number, inner: number): boolean {
		for (let g: number | undefined = inner; g !== undefined;) {
			if (g === outer) {
				return true
			}
			const parent: number | undefined = this.groups[g]?.parent
			g = parent === g ? undefined : parent
		}
		return false
	}

	/**
	 * The group whose classes `group`'s columns are in: that of the group its left join stands in, where PostgreSQL makes
	 * the join an inner join.
	 */
	resolved(group: number): number {
		const g = this.groups[group]
		return g !== undefined && this.reduced.has(group) ? this.resolved(g.parent) : group
	}

	/** The columns of `item` a class of `classes` holds, `k`'s. */
	columnsWith(classes: Classes, k: string, item: Item): ReadonlyArray<string> {
		const prefix = this.key(item, "")
		return classes.keysWith(k).filter((key) => key.startsWith(prefix))
	}

	key(item: Item, column: string): string {
		let id = this.#ids.get(item)
		if (id === undefined) {
			id = this.#next
			this.#next += 1
			this.#ids.set(item, id)
		}
		return `${id}\u0000${column}`
	}
}

/** The walk of one statement: its faults, collected as it meets them. */
class Walk {
	readonly faults: Array<ReadFault> = []
	/**
	 * The aliases, as printed, of every scan the walk judged or proved unread (an empty level's), each a level it reached
	 * holds (readFaults checks the statement's every scan is among them).
	 */
	readonly judged = new Set<string>()
	readonly #tables: ReadTables
	readonly #outer: OuterReading
	readonly #summaries = new Summaries()
	/** The rows of the lowest outer join above the FROM source being read, none where none is (#item). */
	#outerJoin: ReadonlySet<string> | undefined = undefined

	constructor(tables: ReadTables, outer: OuterReading) {
		this.#tables = tables
		this.#outer = outer
	}

	/** What an expression is at `level`: a column of an item there, a constant, or neither. */
	term(e: Expr, level: Level): Term {
		if (e.kind === "param" || e.kind === "literal" || e.kind === "clock") {
			return { kind: "constant" }
		}
		if (e.kind === "column") {
			return e.table === undefined ? { kind: "opaque" } : this.#column(e.table, e.column, level)
		}
		return this.constant(e, level) ? { kind: "constant" } : { kind: "opaque" }
	}

	/** A reference `table.column` read at `level`: an item of its own, or an outer row's column, a parameter there. */
	#column(table: string, column: string, level: Level): Term {
		const item = level.items.get(table)
		if (item !== undefined) {
			if (item.kind === "pulled") {
				const e = item.targets.get(column)
				return e === undefined ? { kind: "opaque" } : this.term(e, level)
			}
			return item.kind === "given" && item.constant
				? { kind: "constant" }
				: { kind: "column", item, column }
		}
		for (let at = level.parent; at !== undefined; at = at.parent) {
			const outer = at.items.get(table)
			if (outer !== undefined) {
				return this.#outer === "parameter" || this.held(this.#column(table, column, at), at)
					? { kind: "constant" }
					: { kind: "opaque" }
			}
		}
		return { kind: "opaque" }
	}

	/**
	 * Whether an expression is a constant at `level`: every column it reads one, no fold or VOLATILE call, and no sub-link
	 * but an uncorrelated scalar sub-select, an InitPlan PostgreSQL evaluates once, its output a parameter of the
	 * statement (subselect.c make_subplan, an EXPR_SUBLINK of no outer parameter): a claim's value read through the
	 * session's setting among them.
	 */
	constant(e: Expr, level: Level): boolean {
		if (fencingTarget(e)) {
			return false
		}
		for (const s of sublinksOf(e)) {
			if (s.label !== "scalar" || this.#summaries.readsOutside(s.query, level.ctes)) {
				return false
			}
		}
		let constant = true
		ownLevel(e, (x) => {
			if (x.kind === "column") {
				constant &&= this.term(x, level).kind === "constant"
			} else if (
				x.kind === "excluded" ||
				x.kind === "returning" ||
				x.kind === "plVar" ||
				x.kind === "field"
			) {
				constant = false
			}
		})
		return constant
	}

	/** Whether a term is fixed at its level: a constant, or a column whose class holds one or a membership fixes. */
	fixed(t: Term, level: Level): boolean {
		switch (t.kind) {
			case "constant":
				return true
			case "opaque":
				return false
			case "column": {
				const k = level.key(t.item, t.column)
				const classes = level.classes[level.resolved(t.item.group)] ?? level.classes[0]
				return (
					level.members.has(k) ||
					(classes !== undefined && classes.find(k) === classes.find(constantKey))
				)
			}
		}
	}

	/** How a column of an item is fixed at its level: by its class's constant, by a membership alone, or not at all. */
	#fixedBy(t: Term, level: Level): "class" | "member" | undefined {
		if (t.kind !== "column") {
			return undefined
		}
		const k = level.key(t.item, t.column)
		const classes = level.classes[level.resolved(t.item.group)] ?? level.classes[0]
		return classes !== undefined && classes.find(k) === classes.find(constantKey)
			? "class"
			: level.members.has(k)
				? "member"
				: undefined
	}

	/** Whether a term is held at its level (the module header): fixed, read by a keyed chain, or held by lineage. */
	held(t: Term, level: Level): boolean {
		if (this.fixed(t, level)) {
			return true
		}
		if (t.kind !== "column") {
			return false
		}
		const item = t.item
		switch (item.kind) {
			case "scan": {
				const facts = item.facts
				if (facts === undefined) {
					return false
				}
				const bound = determinedBy(facts, (column) =>
					this.fixed({ kind: "column", item, column }, level)
				)
				return boundPrefix(facts.keys, bound) > 0
			}
			case "apart": {
				const at = columnNames(item.columns, targetsOf(item.query)).indexOf(t.column)
				return item.held?.[at] === true
			}
			case "cteScan": {
				const at = item.cte.columns.indexOf(t.column)
				return item.cte.held?.[at] === true
			}
			case "given": {
				const e = item.columns.get(t.column)
				return e === undefined || this.heldExpr(e, level)
			}
			case "driven":
				return item.held.has(t.column)
			case "pulled":
				return false
		}
	}

	/**
	 * Whether an expression is held at `level`: a function of held values alone, a constant, a held column, or a cast of
	 * one among them, whose values a held value determines; no sub-link but a constant's and no VOLATILE call.
	 */
	heldExpr(e: Expr, level: Level): boolean {
		if (e.kind === "column") {
			return this.held(this.term(e, level), level)
		}
		if (this.constant(e, level)) {
			return true
		}
		if (sublinksOf(e).length > 0 || volatileIn(e) || fencingTarget(e)) {
			return false
		}
		let held = true
		ownLevel(e, (x) => {
			if (x.kind === "column") {
				held &&= this.held(this.term(x, level), level)
			} else if (
				x.kind === "excluded" ||
				x.kind === "returning" ||
				x.kind === "plVar" ||
				x.kind === "field"
			) {
				held = false
			}
		})
		return held
	}

	/** The faults of a statement as it is printed (print-once.ts printedOnce), the CTEs of `outer` in scope. */
	statement(s: SqlStatement, outer: CteScope): void {
		const printed = printedOnce(s)
		if (printed.kind === "select") {
			this.query(printed, undefined, outer, [], nothingPushed)
		} else if (printed.kind === "insert") {
			const ctes = this.#with(printed.with, undefined, outer, [])
			if (printed.source.kind === "query") {
				this.query(printed.source.query, undefined, ctes, ["insert"], nothingPushed)
			} else {
				const level = new Level(undefined, ctes)
				for (const row of printed.source.rows) {
					for (const e of row) {
						level.readsApart(e)
					}
				}
				this.#settle(level, ["insert values"])
			}
		} else if (printed.kind === "update" || printed.kind === "delete") {
			const ctes = this.#with(printed.with, undefined, outer, [])
			const level = new Level(undefined, ctes)
			const at = [printed.kind]
			this.#scan(level, printed.table, printed.alias, 0, at)
			for (const item of printed.kind === "update" ? printed.from : printed.using) {
				this.#item(level, item, 0, at)
			}
			this.#where(level, printed.where, 0, at, everyRow, "every")
			for (const t of printed.returning) {
				level.readsApart(t.expr)
			}
			if (printed.kind === "update") {
				for (const a of printed.set) {
					level.readsApart(a.value)
				}
			}
			this.#settle(level, at)
		} else if (printed.kind === "merge") {
			const ctes = this.#with(printed.with, undefined, outer, [])
			const level = new Level(undefined, ctes)
			const at = ["merge"]
			this.#item(level, printed.using, 0, at)
			const target = level.groups.push({ kind: "outer", parent: 0 }) - 1
			this.#scan(level, printed.table, printed.alias, target, at)
			for (const c of conjunctsOf(printed.on)) {
				level.quals.push({ expr: c, group: target, scope: "every" })
			}
			this.#settle(level, at)
		}
	}

	/** A WITH's CTEs, each walked where it stands, visible to the query that holds it and to each later CTE. */
	#with(
		w: OperandSelect["with"],
		parent: Level | undefined,
		ctes: CteScope,
		at: ReadonlyArray<string>
	): CteScope {
		if (w === undefined) {
			return ctes
		}
		const own = new Map<string, CteDef>()
		const scope: CteScope = [own, ...ctes]
		for (const c of w.ctes) {
			const def: CteDef = {
				name: c.name,
				columns: cteColumns(c),
				query: c.query,
				inPlace:
					c.materialized === "NOT MATERIALIZED" &&
					c.query.kind === "select" &&
					!w.recursive &&
					!this.#summaries.of(c.query).volatile,
				held: undefined,
				parameterized: false
			}
			own.set(c.name, def)
			def.parameterized =
				c.query.kind !== "select" || this.#summaries.holdsParameter(c.query, scope)
		}
		for (const def of own.values()) {
			if (def.inPlace) {
				continue
			}
			const here = [...at, `with ${def.name}`]
			if (def.query.kind === "select") {
				def.held = this.query(def.query, parent, scope, here, nothingPushed)
				this.#whole(def.query, scope, here, "body")
			} else {
				this.statement({ ...def.query, with: undefined }, scope)
				def.held = def.columns.map(() => true)
			}
		}
		return scope
	}

	/** A closed, parameter-free query computed whole where it stands, which reads stored rows: a fault of its own. */
	#whole(
		q: OperandSelect,
		ctes: CteScope,
		at: ReadonlyArray<string>,
		site: "body" | "from" | "sublink"
	): void {
		if (
			this.#summaries.holdsParameter(q, ctes) ||
			this.#summaries.readsOutside(q, ctes) ||
			subqueryForm(q) === "read"
		) {
			return
		}
		const reads = [
			...new Set(
				[...this.#summaries.of(q).tables].flatMap((t) => {
					const facts = this.#tables.get(t)
					return facts === undefined ? [] : [facts.relation]
				})
			)
		].toSorted()
		if (isNonEmpty(reads)) {
			this.faults.push({ kind: "wholeDerivation", at, reads, site })
		}
	}

	/**
	 * A query walked under `parent`, a constant fixing each output position in `pushed` where PostgreSQL moves it in: the
	 * held of each of its output columns.
	 */
	query(
		q: OperandSelect,
		parent: Level | undefined,
		ctes: CteScope,
		at: ReadonlyArray<string>,
		pushed: Pushed
	): ReadonlyArray<boolean> {
		const scope = this.#with(q.with, parent, ctes, at)
		const moves = q.limit === undefined && q.offset === undefined ? pushed : nothingPushed
		switch (q.body.kind) {
			case "core":
				return this.core(q.body, parent, scope, at, moves)
			case "select":
				return this.query(q.body, parent, scope, at, moves)
			case "setOp": {
				const body = q.body
				const into = body.op === "EXCEPT" ? nothingPushed : moves
				const arms = body.arms.map((arm, i) =>
					arm.kind === "core"
						? this.core(arm, parent, scope, [...at, `arm ${i}`], into)
						: this.query(arm, parent, scope, [...at, `arm ${i}`], into)
				)
				const width = arms[0]?.length ?? 0
				return Array.from({ length: width }, (_, i) => arms.every((a) => a[i] === true))
			}
		}
	}

	/** A core walked as a level of its own: each output column's held. */
	core(
		c: SelectCore,
		parent: Level | undefined,
		ctes: CteScope,
		at: ReadonlyArray<string>,
		pushed: Pushed
	): ReadonlyArray<boolean> {
		const level = new Level(parent, ctes)
		const windowed = c.targets.some((t) => {
			let w = false
			ownLevel(t.expr, (x) => {
				w ||= x.kind === "call" && x.over !== undefined
			})
			return w
		})
		/** The target at `i` where a restriction of it moves in: none past a window, a fold or a set-returning target. */
		const movable = (i: number): Expr | undefined => {
			const t = c.targets[i]
			if (t === undefined || windowed || fencingTarget(t.expr)) {
				return undefined
			}
			const moves =
				c.groupBy.length > 0
					? c.groupBy.some((g) => sameExpr(g, t.expr))
					: c.distinct === false || c.distinct === true
						? true
						: c.distinct.on.some((g) => sameExpr(g, t.expr))
			return moves ? t.expr : undefined
		}
		const moved = [...pushed.fixed].flatMap(([i, by]) => {
			const expr = movable(i)
			return expr === undefined ? [] : [{ expr, group: 0, by }]
		})
		for (const [i, j] of pushed.equal) {
			const [left, right] = [movable(i), movable(j)]
			if (left !== undefined && right !== undefined) {
				level.quals.push({
					expr: { kind: "binary", op: "=", left, right, schema: undefined },
					group: 0,
					scope: "every"
				})
			}
		}
		const enclosing = this.#outerJoin
		this.#outerJoin = undefined
		this.#core(level, c, 0, at, everyRow, "every")
		this.#outerJoin = enclosing
		for (const m of moved) {
			level.pushed.push(m)
		}
		for (const t of c.targets) {
			level.readsApart(t.expr)
		}
		for (const g of c.groupBy) {
			level.readsApart(g)
		}
		if (c.having !== undefined) {
			level.readsApart(c.having)
		}
		this.#settle(level, at)
		return c.targets.map((t) => this.heldExpr(t.expr, level))
	}

	/**
	 * A core's FROM and WHERE flattened into `level`, in `group`, its WHERE's sub-links made joins where they read the rows
	 * `available` holds (#where).
	 */
	#core(
		level: Level,
		c: SelectCore,
		group: number,
		at: ReadonlyArray<string>,
		available: Available,
		scope: Scope
	): void {
		for (const item of c.from) {
			this.#item(level, item, group, at)
		}
		this.#where(level, c.where, group, at, available, scope)
	}

	/** The rows a core's FROM names (#rowsOf), a join's every source's. */
	#fromRows(from: ReadonlyArray<FromItem>): ReadonlySet<string> {
		return new Set(
			from.flatMap((item) =>
				item.kind === "joins"
					? [item.first, ...item.steps.map((step) => step.source)].flatMap((s) => this.#rowsOf(s))
					: this.#rowsOf(item)
			)
		)
	}

	/**
	 * A condition's conjuncts into `level`: each top-level EXISTS or uncorrelated IN PostgreSQL makes a semi-join, in
	 * `group`, and each NOT EXISTS an anti-join, an inner group of its own, where the rows of the level it reads are rows
	 * `available` holds (subselect.c convert_EXISTS_sublink_to_join, convert_ANY_sublink_to_join available_rels: a WHERE's
	 * every row, an inner join's condition its two sides' rows, a left join's or a semi-join's its inner side's); the rest
	 * conditions.
	 */
	#where(
		level: Level,
		where: Expr | undefined,
		group: number,
		at: ReadonlyArray<string>,
		available: Available,
		scope: Scope
	): void {
		for (const conjunct of conjunctsOf(where)) {
			const negated = conjunct.kind === "not" ? conjunct.expr : undefined
			const exists =
				conjunct.kind === "exists"
					? conjunct
					: negated?.kind === "exists"
						? { ...negated, not: !negated.not }
						: undefined
			if (exists !== undefined && this.#joinable(exists.query, level, available)) {
				const inner = exists.not ? level.groups.push({ kind: "inner", parent: group }) - 1 : group
				const q = exists.query
				if (q.body.kind === "core") {
					const before = new Set(level.items.keys())
					this.#core(
						level,
						q.body,
						inner,
						[...at, exists.not ? "antiJoin" : "semiJoin"],
						{ kind: "join", rows: this.#fromRows(q.body.from) },
						scope === "every" ? scope : new Set([...scope, ...this.#fromRows(q.body.from)])
					)
					const domain = level.semiJoin()
					for (const a of level.items.keys()) {
						if (!before.has(a)) {
							level.semiJoined.set(a, domain)
						}
					}
				}
				continue
			}
			const tested =
				conjunct.kind === "inQuery"
					? this.#queryRows(readOf([], conjunct.expr), level, available)
					: []
			if (
				conjunct.kind === "inQuery" &&
				!conjunct.not &&
				this.#queryRows(conjunct.query, level, available).length === 0 &&
				!volatileIn(conjunct.expr) &&
				tested.length > 0 &&
				tested.every((a) => available.kind === "every" || available.rows.has(a))
			) {
				const alias = `in ${level.items.size}`
				const names = targetsOf(conjunct.query).map((_, i) => `in ${i}`)
				const before = new Set(level.items.keys())
				this.#derived(level, conjunct.query, alias, names, false, group, [...at, "in"])
				const domain = level.semiJoin()
				for (const a of level.items.keys()) {
					if (!before.has(a)) {
						level.semiJoined.set(a, domain)
					}
				}
				const left = conjunct.expr.kind === "row" ? conjunct.expr.items : [conjunct.expr]
				left.forEach((l, i) => {
					level.quals.push({
						expr: {
							kind: "binary",
							op: "=",
							left: { kind: "column", table: alias, column: names[i] ?? "" },
							right: l,
							schema: undefined
						},
						group,
						scope
					})
				})
				continue
			}
			level.quals.push({ expr: conjunct, group, scope })
			level.readsApart(conjunct)
		}
	}

	/**
	 * Whether PostgreSQL makes an EXISTS a semi- or anti-join (subselect.c convert_EXISTS_sublink_to_join,
	 * simplify_EXISTS_query): a core of no WITH, aggregate, window, HAVING or OFFSET, a FROM, the rows of the level it
	 * stands in read in its WHERE alone, and read there; a row of a level further out it may read anywhere.
	 */
	#joinable(q: OperandSelect, level: Level, available: Available): boolean {
		if (
			q.with !== undefined ||
			q.offset !== undefined ||
			(q.limit !== undefined && q.limit.kind !== "literal") ||
			q.body.kind !== "core" ||
			q.body.having !== undefined ||
			q.body.from.length === 0 ||
			q.body.targets.some((t) => fencingTarget(t.expr))
		) {
			return false
		}
		const body = q.body
		const where = body.where
		if (where === undefined || volatileIn(where)) {
			return false
		}
		if (this.#queryRows(readOf(body.from, undefined), level, available).length > 0) {
			return false
		}
		const rows = this.#queryRows(readOf(body.from, where), level, available)
		return rows.length > 0 && rows.every((a) => available.kind === "every" || available.rows.has(a))
	}

	/**
	 * The rows a query reads, at any depth, of the query its sub-link stands in (subselect.c contain_vars_of_level at 1):
	 * the level's rows, but in a query pulled up into it (Available `query`) that query's own alone.
	 */
	#queryRows(q: OperandSelect, level: Level, available: Available): ReadonlyArray<string> {
		const { defined, read } = this.#summaries.of(q)
		return [...read].filter(
			(a) =>
				!defined.has(a) && (available.kind === "query" ? available.rows.has(a) : level.items.has(a))
		)
	}

	/**
	 * Whether PostgreSQL may run an EXISTS it keeps as a SubPlan hashed instead (subselect.c convert_EXISTS_to_ANY, an
	 * AlternativeSubPlan setrefs.c chooses by cost): a core of no aggregate, HAVING, window or OFFSET, its GROUP BY
	 * dropped as simplify_EXISTS_query drops it, its FROM reading no outer
	 * row, and every outer row its WHERE reads read in a top-level equality of an outer side and an inner side. Hashed,
	 * its query runs once over every row, so an outer row's value fixes none of its scans: they are walked with no outer
	 * row (`query` of no parent).
	 */
	#hashable(q: OperandSelect): boolean {
		if (
			q.with !== undefined ||
			q.offset !== undefined ||
			(q.limit !== undefined && q.limit.kind !== "literal") ||
			q.body.kind !== "core" ||
			q.body.having !== undefined ||
			q.body.targets.some((t) => fencingTarget(t.expr))
		) {
			return false
		}
		const { defined } = this.#summaries.of(q)
		const outer = (e: Expr | undefined): ReadonlyArray<string> =>
			[...this.#summaries.of(readOf([], e)).read].filter((a) => !defined.has(a))
		const fromOuter = [...this.#summaries.of(readOf(q.body.from, undefined)).read].some(
			(a) => !defined.has(a)
		)
		if (fromOuter) {
			return false
		}
		let correlated = false
		for (const c of conjunctsOf(q.body.where)) {
			if (outer(c).length === 0) {
				continue
			}
			if (c.kind !== "binary" || c.op !== "=" || c.schema !== undefined) {
				return false
			}
			const [l, r] = [outer(c.left), outer(c.right)]
			const leftOuter = l.length > 0 && r.length === 0 && this.#innerOnly(c.right, defined)
			const rightOuter = r.length > 0 && l.length === 0 && this.#innerOnly(c.left, defined)
			if (!leftOuter && !rightOuter) {
				return false
			}
			correlated = true
		}
		return correlated
	}

	/** Whether an expression reads a row of its query's own (`defined`) and no sub-link: an equality's inner side. */
	#innerOnly(e: Expr, defined: ReadonlySet<string>): boolean {
		const tables: Array<string> = []
		ownLevel(e, (x) => {
			if (x.kind === "column" && x.table !== undefined) {
				tables.push(x.table)
			}
		})
		return tables.some((t) => defined.has(t)) && sublinksOf(e).length === 0
	}

	/**
	 * Whether a query reads, at any depth, a row of `level`'s own, the level it stands in, where PostgreSQL's sub-link
	 * conversions look for the parent's Vars (subselect.c contain_vars_of_level at 1): a row of a level further out is a
	 * parameter of the level's, which no conversion minds.
	 */
	#readsLevel(q: OperandSelect, level: Level): boolean {
		const { defined, read } = this.#summaries.of(q)
		for (const a of read) {
			if (!defined.has(a) && level.items.has(a)) {
				return true
			}
		}
		return false
	}

	/** A FROM item into `level`, in `group`. */
	#item(level: Level, item: FromItem, group: number, at: ReadonlyArray<string>): void {
		if (item.kind !== "joins") {
			this.#source(level, item, group, at)
			return
		}
		const sources = [item.first, ...item.steps.map((step) => step.source)]
		/**
		 * The rows of the lowest outer join above the source at `k` (0 the first, k the k-th step's), the item's joins
		 * nesting to the left, so the join of a step holds every source before it; none where no outer join is above it.
		 */
		const scope = (k: number): ReadonlySet<string> | undefined => {
			const j = item.steps.findIndex((step, i) => i + 1 >= k && step.kind === "left")
			return j < 0
				? undefined
				: new Set(sources.slice(0, j + 2).flatMap((src) => this.#rowsOf(src)))
		}
		const enclosing = this.#outerJoin
		this.#outerJoin = scope(1)
		this.#source(level, item.first, group, at)
		for (const [i, step] of item.steps.entries()) {
			this.#outerJoin = scope(i + 1)
			switch (step.kind) {
				case "cross":
					this.#source(level, step.source, group, at)
					break
				case "on":
					this.#source(level, step.source, group, at)
					{
						const rows = new Set(sources.slice(0, i + 2).flatMap((src) => this.#rowsOf(src)))
						this.#where(level, step.on, group, at, { kind: "join", rows }, rows)
					}
					break
				case "left": {
					const inner = level.groups.push({ kind: "outer", parent: group }) - 1
					this.#source(level, step.source, inner, [...at, "leftJoin"])
					{
						const rows = new Set(this.#rowsOf(step.source))
						this.#where(level, step.on, inner, [...at, "leftJoin"], { kind: "join", rows }, rows)
					}
					break
				}
			}
		}
		this.#outerJoin = enclosing
	}

	/** The rows a FROM source names: its alias, and a FROM query's every alias within. */
	#rowsOf(s: FromSource): ReadonlyArray<string> {
		switch (s.kind) {
			case "derived":
				return [s.alias, ...this.#summaries.of(s.query).defined]
			case "cte":
				return [s.alias ?? s.name]
			case "table":
			case "enclosing":
			case "context":
			case "transition":
			case "values":
			case "arrays":
			case "function":
			case "met":
			case "metRows":
			case "probe":
				return [s.alias]
		}
	}

	/**
	 * Whether PostgreSQL pulls up a LATERAL query (prepjointree.c is_simple_subquery,
	 * jointree_contains_lateral_outer_refs), `safe` the rows of the lowest outer join above it, none where none is: below
	 * an outer join, its WHERE, its joins' conditions and its targets read no row of the level outside `safe`; below an
	 * outer join within it, a join's condition reads no row of the level at all; and where a sub-link of its WHERE is made
	 * a join (#convertsSublink), no condition of it reads one.
	 */
	#lateralPulled(
		q: OperandSelect & { readonly body: SelectCore },
		level: Level,
		safe: ReadonlySet<string> | undefined
	): boolean {
		const { defined } = this.#summaries.of(q)
		const rows = (e: Expr | undefined): ReadonlyArray<string> =>
			e === undefined
				? []
				: [...this.#summaries.of(readOf([], e)).read].filter(
						(a) => !defined.has(a) && level.items.has(a)
					)
		const none: ReadonlySet<string> = new Set()
		const converted = this.#convertsSublink(q, level)
		const within = (e: Expr | undefined, scope: ReadonlySet<string> | undefined): boolean => {
			const bound = converted ? none : scope
			return bound === undefined || rows(e).every((a) => bound.has(a))
		}
		const joins = q.body.from.every(
			(item) =>
				item.kind !== "joins" ||
				item.steps.every((step, k) =>
					step.kind === "cross"
						? true
						: within(step.on, item.steps.slice(k).some((s) => s.kind === "left") ? none : safe)
				)
		)
		return (
			joins &&
			within(q.body.where, safe) &&
			q.body.targets.every((t) => safe === undefined || rows(t.expr).every((a) => safe.has(a)))
		)
	}

	/**
	 * A CTE's body as PostgreSQL reads it in place at the read `alias`: a copy of its own, every alias it defines renamed
	 * for the read (`copyMark`), so two reads of one CTE in one level are two sets of rows, as EXPLAIN tells them apart
	 * (r1, r1_1). A fault names the alias as printed (`printedAlias`).
	 */
	#copyAt(q: OperandSelect, alias: string): OperandSelect {
		const { defined } = this.#summaries.of(q)
		const renamed = (a: string): string => (defined.has(a) ? `${a}${copyMark}${alias}` : a)
		return transformQuery(q, {
			...identityHooks,
			fromSource: (source) =>
				source.kind === "cte"
					? { ...source, alias: renamed(source.alias ?? source.name) }
					: source.kind === "probe"
						? { ...source, alias: renamed(source.alias), inner: renamed(source.inner) }
						: { ...source, alias: renamed(source.alias) },
			expr: (e) =>
				e.kind === "column" && e.table !== undefined ? { ...e, table: renamed(e.table) } : e
		})
	}

	/**
	 * Whether PostgreSQL makes a sub-link of a query's WHERE a join before it pulls the query up (#where under the query's
	 * own rows): the join it makes wraps the query's rows and the rest of its WHERE, so a LATERAL query's every condition
	 * then stands below a semi- or an anti-join, where no row outside it may be read (jointree_contains_lateral_outer_refs).
	 */
	#convertsSublink(q: OperandSelect & { readonly body: SelectCore }, level: Level): boolean {
		const own: Available = { kind: "query", rows: this.#fromRows(q.body.from) }
		return conjunctsOf(q.body.where).some((c) => {
			const exists =
				c.kind === "exists" ? c : c.kind === "not" && c.expr.kind === "exists" ? c.expr : undefined
			if (exists !== undefined) {
				return this.#joinable(exists.query, level, own)
			}
			if (c.kind !== "inQuery" || c.not || volatileIn(c.expr)) {
				return false
			}
			const tested = this.#queryRows(readOf([], c.expr), level, own)
			return (
				this.#queryRows(c.query, level, own).length === 0 &&
				tested.length > 0 &&
				tested.every((a) => own.rows.has(a))
			)
		})
	}

	/**
	 * A table scan into `level`: a stored table's, or a carrier's, the session table a write stages its call's rows in
	 * (sql/naming.ts CarrierName), whose rows are the call's own.
	 */
	#scan(
		level: Level,
		table: ObjectName | string,
		alias: string,
		group: number,
		at: ReadonlyArray<string>
	): void {
		if (typeof table === "string") {
			level.items.set(alias, { kind: "given", alias, group, columns: new Map(), constant: false })
			return
		}
		const facts = this.#tables.get(nameKey(table))
		this.judged.add(printedAlias(alias))
		level.items.set(alias, { kind: "scan", alias, table, facts, group, at: [...at, alias] })
	}

	/** A FROM query into `level`: pulled up where PostgreSQL pulls it up, else read apart. */
	#derived(
		level: Level,
		q: OperandSelect,
		alias: string,
		columns: ReadonlyArray<string>,
		lateral: boolean,
		group: number,
		at: ReadonlyArray<string>
	): void {
		if (pulledUp(q) && (!lateral || this.#lateralPulled(q, level, this.#outerJoin))) {
			const names = columnNames(columns, q.body.targets)
			level.items.set(alias, {
				kind: "pulled",
				alias,
				group,
				targets: new Map(
					names.flatMap((n, i) => {
						const t = q.body.targets[i]
						return t === undefined ? [] : [[n, t.expr] as const]
					})
				)
			})
			for (const t of q.body.targets) {
				level.readsApart(t.expr)
			}
			const rows = this.#fromRows(q.body.from)
			this.#core(level, q.body, group, at, { kind: "query", rows }, rows)
			return
		}
		level.items.set(alias, {
			kind: "apart",
			alias,
			columns,
			query: q,
			lateral,
			group,
			at: [...at, `${lateral ? "lateral" : "from"} ${alias}`],
			held: undefined
		})
	}

	/** A FROM source into `level`. */
	#source(level: Level, s: FromSource, group: number, at: ReadonlyArray<string>): void {
		switch (s.kind) {
			case "table":
				this.#scan(level, s.table, s.alias, group, at)
				return
			case "derived":
				this.#derived(level, s.query, s.alias, selectColumns(s.query), s.lateral, group, at)
				return
			case "cte": {
				const alias = s.alias ?? s.name
				const def = level.ctes.map((m) => m.get(s.name)).find((d) => d !== undefined)
				if (def === undefined) {
					level.items.set(alias, { kind: "driven", alias, group, held: new Set() })
					return
				}
				if (def.inPlace && def.query.kind === "select") {
					this.#derived(level, this.#copyAt(def.query, alias), alias, def.columns, false, group, [
						...at,
						`cte ${s.name}`
					])
					return
				}
				level.items.set(alias, { kind: "cteScan", alias, cte: def, group })
				return
			}
			case "enclosing": {
				const def = level.ctes.map((m) => m.get(s.name)).find((d) => d !== undefined)
				level.items.set(
					s.alias,
					def === undefined
						? { kind: "driven", alias: s.alias, group, held: new Set() }
						: { kind: "cteScan", alias: s.alias, cte: def, group }
				)
				return
			}
			case "context":
				level.items.set(s.alias, {
					kind: "given",
					alias: s.alias,
					group,
					columns: new Map(),
					constant: true
				})
				return
			case "transition":
				level.items.set(s.alias, {
					kind: "given",
					alias: s.alias,
					group,
					columns: new Map(),
					constant: false
				})
				return
			case "values":
				level.items.set(s.alias, {
					kind: "given",
					alias: s.alias,
					group,
					columns: new Map(),
					constant: false
				})
				for (const row of s.rows) {
					for (const e of row) {
						level.readsApart(e)
					}
				}
				return
			case "arrays":
				level.items.set(s.alias, {
					kind: "given",
					alias: s.alias,
					group,
					columns:
						s.source.kind === "carried"
							? new Map(s.source.columns.map((c) => [c.definition.name, c.array] as const))
							: new Map(),
					constant: false
				})
				if (s.source.kind === "carried") {
					for (const c of s.source.columns) {
						level.readsApart(c.array)
					}
				}
				return
			case "function":
				level.items.set(s.alias, {
					kind: "given",
					alias: s.alias,
					group,
					columns:
						carrierReadBy(s) === undefined
							? new Map(
									(s.columns.kind === "named"
										? s.columns.names
										: s.columns.definitions.map((d) => d.name)
									).map((n) => [n, s.call] as const)
								)
							: new Map(),
					constant: false
				})
				level.readsApart(s.call)
				return
			case "metRows": {
				const def = level.ctes.map((m) => m.get(s.proposed)).find((d) => d !== undefined)
				const held = new Set(
					s.columns.flatMap((c) => {
						const place = def?.columns.indexOf(c.column) ?? -1
						return def?.held?.[place] === true ? [c.column] : []
					})
				)
				level.items.set(s.alias, { kind: "driven", alias: s.alias, group, held })
				return
			}
			case "probe":
			case "met": {
				const facts = this.#tables.get(nameKey(s.table))
				const by =
					s.kind === "probe"
						? s.by.columns.map((c) => ({ column: c.column, value: c.value }))
						: s.key.map((k) => ({
								column: k.column,
								value: { kind: "column", table: s.rows, column: k.from } satisfies Expr
							}))
				const fixed = new Set(
					by.flatMap((b) => {
						const t = this.term(b.value, level)
						return (this.#outer === "parameter" && t.kind !== "opaque") ||
							this.heldExpr(b.value, level)
							? [b.column]
							: []
					})
				)
				const here = [...at, `${s.kind} ${s.alias}`]
				if (facts?.unit.kind === "member") {
					const determined = determinedBy(facts, (c) => fixed.has(c))
					const missing = facts.unit.columns.filter((c) => !determined.has(c))
					if (isNonEmpty(missing)) {
						this.faults.push({
							kind: "unboundUnitRead",
							relation: facts.relation,
							alias: printedAlias(s.inner),
							unit: facts.unit.name,
							missing: [
								{ column: missing[0], reason: "unstated" },
								...missing.slice(1).map((column) => ({ column, reason: "unstated" as const }))
							],
							at: here
						})
					}
				}
				const keyed =
					facts !== undefined &&
					boundPrefix(
						facts.keys,
						determinedBy(facts, (c) => fixed.has(c))
					) > 0
				level.items.set(s.alias, {
					kind: "driven",
					alias: s.alias,
					group,
					held: new Set(s.columns.flatMap((c) => (keyed || fixed.has(c.read) ? [c.as] : [])))
				})
				return
			}
		}
	}

	/**
	 * The level's InitPlans, which read nothing of it, then its classes, then every query it reads apart and every SubPlan,
	 * then its scans judged.
	 */
	#settle(level: Level, at: ReadonlyArray<string>): void {
		this.#reduce(level)
		const subplans: Array<{ readonly query: OperandSelect; readonly label: string }> = []
		for (const s of level.subplans) {
			if (this.#readsLevel(s.query, level)) {
				subplans.push(s)
				continue
			}
			const here = [...at, s.label]
			level.initPlans.set(s.query, this.query(s.query, level, level.ctes, here, nothingPushed))
			this.#whole(s.query, level.ctes, here, "sublink")
		}
		this.#classes(level)
		for (const item of level.items.values()) {
			if (item.kind !== "apart") {
				continue
			}
			const names = columnNames(item.columns, targetsOf(item.query))
			if (level.empty) {
				item.held = names.map(() => true)
				this.unread(item.query)
				continue
			}
			const fixed = new Map(
				names.flatMap((n, i) => {
					const t: Term = { kind: "column", item, column: n }
					const by = this.#fixedBy(t, level)
					return by === undefined ? [] : [[i, by] as const]
				})
			)
			const classes = level.classes[level.resolved(item.group)] ?? level.classes[0]
			const roots = names.map((n) => classes?.find(level.key(item, n)))
			const equal = roots.flatMap((r, i) =>
				roots.flatMap((q, j) => (j > i && r !== undefined && r === q ? [[i, j] as const] : []))
			)
			item.held = this.query(item.query, level, level.ctes, item.at, { fixed, equal })
			if (fixed.size === 0) {
				this.#whole(item.query, level.ctes, item.at, "from")
			}
		}
		for (const s of subplans) {
			const here = [...at, s.label]
			const hashed = (s.label === "exists" || s.label === "notExists") && this.#hashable(s.query)
			this.query(s.query, hashed ? undefined : level, level.ctes, here, nothingPushed)
			this.#whole(s.query, level.ctes, here, "sublink")
		}
		for (const item of level.items.values()) {
			const facts = item.kind === "scan" ? item.facts : undefined
			const unit = facts?.unit
			if (level.empty || item.kind !== "scan" || facts === undefined || unit?.kind !== "member") {
				continue
			}
			const twins = this.#twins(item, level)
			const determined = determinedBy(facts, (column) =>
				[item, ...twins].some((t) => this.fixed({ kind: "column", item: t, column }, level))
			)
			const unfixed = unit.columns.flatMap((column) => {
				if (determined.has(column)) {
					return []
				}
				const classes = level.classes[level.resolved(item.group)] ?? level.classes[0]
				const reason: UnfixedReason =
					classes !== undefined && classes.members(level.key(item, column)) > 1
						? "joined"
						: "unstated"
				return [{ column, reason }]
			})
			if (isNonEmpty(unfixed)) {
				this.faults.push({
					kind: "unboundUnitRead",
					relation: facts.relation,
					alias: printedAlias(item.alias),
					unit: unit.name,
					missing: unfixed,
					at: item.at
				})
			}
		}
	}

	/**
	 * Every scan of a query PostgreSQL reads no row of, judged as read by none: one it proves empty (Level `empty`), or a
	 * CTE no query reads, which it never plans.
	 */
	unread(q: OperandSelect): void {
		transformQuery(q, {
			...identityHooks,
			fromSource: (source) => {
				if (source.kind === "table") {
					this.judged.add(printedAlias(source.alias))
				}
				return source
			}
		})
	}

	/**
	 * The scans PostgreSQL makes one with `item` (analyzejoins.c remove_useless_self_joins): each scan of its table in its
	 * group and its join domain (Level `semiJoined`), whose every column of one of the table's declared keys is in one
	 * class with `item`'s, so both read the one row of the key: what fixes a column of one fixes it in the other. The
	 * classes hold every constant as one, so a key column a constant fixes in each joins nothing: the two constants may
	 * differ. A class that holds another column of either scan beside the key's may give PostgreSQL its join clause on
	 * that column instead (equivclass.c generate_join_implied_equalities picks one), so it joins nothing either. A scan
	 * that is the one relation of a semi-join pairs with the scans outside it, the semi-join made an inner join where its
	 * key is joined whole (reduce_unique_semijoins).
	 */
	#twins(item: Extract<Item, { readonly kind: "scan" }>, level: Level): ReadonlyArray<Item> {
		const facts = item.facts
		const group = level.resolved(item.group)
		const classes = level.classes[group] ?? level.classes[0]
		if (facts === undefined || classes === undefined) {
			return []
		}
		/** Whether `alias` is the one relation of the semi-join it stands in, which PostgreSQL makes an inner join where its rows are unique on the join (analyzejoins.c reduce_unique_semijoins). */
		const sole = (alias: string): boolean => {
			const domain = level.semiJoined.get(alias)
			return (
				domain !== undefined &&
				[...level.semiJoined].filter(
					([a, d]) => d === domain && level.items.get(a)?.kind !== "pulled"
				).length === 1
			)
		}
		const domain = level.semiJoined.get(item.alias)
		return [...level.items.values()].filter(
			(t) =>
				t !== item &&
				t.kind === "scan" &&
				nameKey(t.table) === nameKey(item.table) &&
				level.resolved(t.group) === group &&
				(level.semiJoined.get(t.alias) === domain || sole(t.alias) || sole(item.alias)) &&
				facts.keys.some((k) =>
					k.every((c) => {
						const key = level.key(item, c)
						const root = classes.find(key)
						return (
							root !== classes.find(constantKey) &&
							classes.find(level.key(t, c)) === root &&
							level.columnsWith(classes, key, item).length === 1 &&
							level.columnsWith(classes, key, t).length === 1
						)
					})
				)
		)
	}

	/**
	 * The left joins of `level` PostgreSQL makes inner joins (prepjointree.c reduce_outer_joins): each whose inner side a
	 * strict condition of the group its join stands in reads, its WHERE's, a semi-join's, an inner join's, a restriction
	 * moved in from outside, or a left join's made inner before it, whose condition is then that group's, to a fixpoint.
	 * A column of a query pulled up is read where its target is.
	 */
	#reduce(level: Level): void {
		const groupsOf = (c: StrictColumn): ReadonlyArray<number> => {
			const item = level.items.get(c.table)
			if (item === undefined) {
				return []
			}
			if (item.kind !== "pulled") {
				return [item.group]
			}
			const e = item.targets.get(c.column)
			return [item.group, ...(e === undefined ? [] : strictOperand(e).flatMap(groupsOf))]
		}
		for (let grew = true; grew;) {
			grew = false
			const strict = [
				...level.quals.map((q) => ({
					at: level.resolved(q.group),
					read: strictlyRead(q.expr),
					scope: q.scope
				})),
				...level.pushed.map((p) => ({
					at: level.resolved(p.group),
					read: strictOperand(p.expr),
					scope: "every" as const
				}))
			]
			for (const { at, read, scope } of strict) {
				const above = read.filter((c) => scope === "every" || scope.has(c.table))
				for (const g of above.flatMap(groupsOf)) {
					const join = level.groups[g]
					if (
						join?.kind === "outer" &&
						!level.reduced.has(g) &&
						level.resolved(join.parent) === at
					) {
						level.reduced.add(g)
						grew = true
					}
				}
			}
		}
	}

	/**
	 * A level's classes: its own joins' equalities first, the constants moved in among them, then each inner side's,
	 * where a column of the outer side is a constant only if the outer side fixes it.
	 */
	#classes(level: Level): void {
		const own = new Classes()
		level.classes[0] = own
		this.#equate(level, own, 0, () => true)
		level.groups.forEach((_, g) => {
			if (g === 0 || level.reduced.has(g)) {
				return
			}
			const classes = new Classes()
			level.classes[g] = classes
			this.#equate(level, classes, g, (item) => level.resolved(item.group) === g)
		})
	}

	/**
	 * Whether a set membership's set fixes the column it compares: a constant, or an ARRAY of a sub-select PostgreSQL
	 * evaluates once (Level `initPlans`), an array parameter of the level, which its reading takes for fixed and the
	 * invariant's where the sub-select's output is held, the values of the call's rows or of a keyed chain, never every
	 * unit's: the form grizzle prints a key read at the call's rows in, `root = ANY (ARRAY(SELECT DISTINCT … FROM r1))`.
	 */
	#member(x: Expr, level: Level): boolean {
		if (x.kind !== "array") {
			return this.constant(x, level)
		}
		const held = level.initPlans.get(x.query)
		return held !== undefined && (this.#outer === "parameter" || held[0] === true)
	}

	/**
	 * The equalities of `group` into `classes`, a column of an item `mine` refuses read as fixed where its class holds a
	 * constant, else opaque: a membership (= ANY) fixes its column alone, never a class, so PostgreSQL derives no
	 * comparison from it across a join's equality (equivclass.c reconsider_outer_join_clauses reads a class's constant).
	 */
	#equate(level: Level, classes: Classes, group: number, mine: (item: Item) => boolean): void {
		/** The literals the level's own equalities equate its columns to, each by the column's key. */
		const literals: Array<{ readonly key: string; readonly value: string }> = []
		const keyOf = (e: Expr): string | undefined => {
			const t = this.term(e, level)
			switch (t.kind) {
				case "constant":
					return constantKey
				case "opaque":
					return undefined
				case "column":
					if (mine(t.item)) {
						return level.key(t.item, t.column)
					}
					return level.encloses(level.resolved(t.item.group), group) &&
						this.#fixedBy(t, level) === "class"
						? constantKey
						: undefined
			}
		}
		for (const p of level.pushed) {
			if (level.resolved(p.group) === group) {
				const k = keyOf(p.expr)
				if (k !== undefined && k !== constantKey) {
					switch (p.by) {
						case "class":
							classes.union(k, constantKey)
							break
						case "member":
							level.members.add(k)
							break
					}
				}
			}
		}
		for (const q of level.quals) {
			if (level.resolved(q.group) !== group) {
				continue
			}
			const e = q.expr
			if (e.kind === "binary" && e.op === "=") {
				const [a, b] = [keyOf(e.left), keyOf(e.right)]
				if (a !== undefined && b !== undefined) {
					classes.union(a, b)
				}
				const literal =
					e.right.kind === "literal" ? e.right : e.left.kind === "literal" ? e.left : undefined
				const other = literal === e.right ? a : b
				if (group === 0 && literal !== undefined && other !== undefined && other !== constantKey) {
					literals.push({ key: other, value: textOf(literal.value) })
				}
			} else if (e.kind === "equalsAny" || (e.kind === "inList" && !e.not)) {
				const t = this.term(e.expr, level)
				const set = e.kind === "equalsAny" ? [e.array] : e.list
				if (t.kind === "column" && mine(t.item) && set.every((x) => this.#member(x, level))) {
					level.members.add(level.key(t.item, t.column))
				}
			}
		}
		if (group === 0 && literals.length > 1) {
			const columns = new Classes()
			for (const q of level.quals) {
				const e = q.expr
				if (level.resolved(q.group) === 0 && e.kind === "binary" && e.op === "=") {
					const [a, b] = [keyOf(e.left), keyOf(e.right)]
					if (a !== undefined && b !== undefined && a !== constantKey && b !== constantKey) {
						columns.union(a, b)
					}
				}
			}
			const values = new Map<string, Set<string>>()
			for (const { key, value } of literals) {
				values.getOrInsertComputed(columns.find(key), () => new Set()).add(value)
			}
			level.empty = [...values.values()].some((v) => v.size > 1)
		}
	}
}

/**
 * The columns of a table a scan fixes, closed under its declared dependencies (ReadTable `determined`): a dependency
 * whose every determining column the scan fixes fixes each column it determines, as cte-policy's closedUnder reads a
 * read's bound columns; and a declared key the scan fixes whole reads one row, of one unit, so it determines the unit's
 * columns too.
 */
const determinedBy = (
	facts: ReadTable,
	fixed: (column: string) => boolean
): ReadonlySet<string> => {
	const all = new Set([
		...facts.keys.flat(),
		...(facts.unit.kind === "member" ? facts.unit.columns : []),
		...facts.determined.flatMap((d) => [...d.by, ...d.columns])
	])
	const out = new Set([...all].filter(fixed))
	for (let grew = true; grew;) {
		grew = false
		for (const d of facts.determined) {
			if (d.by.every((c) => out.has(c))) {
				for (const c of d.columns) {
					if (!out.has(c)) {
						out.add(c)
						grew = true
					}
				}
			}
		}
	}
	if (facts.unit.kind === "member" && facts.keys.some((k) => k.every((c) => out.has(c)))) {
		for (const c of facts.unit.columns) {
			out.add(c)
		}
	}
	return out
}

/**
 * The length of the longest prefix of one of `keys` (a relation's declared keys, its primary key first) whose every
 * column is in `bound`: the rows a read at such a prefix reads share that prefix's value, never another's; 0 where no
 * such prefix stands.
 */
const boundPrefix = (
	keys: ReadonlyArray<ReadonlyArray<string>>,
	bound: ReadonlySet<string>
): number => {
	let longest = 0
	for (const key of keys) {
		let length = 0
		for (const column of key) {
			if (!bound.has(column)) {
				break
			}
			length += 1
		}
		longest = Math.max(longest, length)
	}
	return longest
}

/**
 * How a walk reads a column of an outer row a query block reads per outer row: `held`, the invariant's (the module
 * header's (b)), fixed where the outer row's column is held, so a scan read at a value no keyed chain from the call's
 * values holds is unbound; or `parameter`, PostgreSQL's own, every such column a parameter of the block, fixed for each
 * evaluation whatever holds it: the scans a plan compares at a value fixed for them, which PostgreSQL itself judges
 * (test/pg/sql/unit-bound.test.ts).
 */
export type OuterReading = "held" | "parameter"

/** What the walk reads: a statement, or a query a function's body holds (a judge's, an upkeep's). */
export type WalkedRead =
	| { readonly kind: "statement"; readonly statement: SqlStatement }
	| { readonly kind: "query"; readonly query: OperandSelect }

/**
 * The faults of a statement's reads (the module header), in the order the walk meets them, each outer row's column read
 * as `outer` says.
 */
export const readFaults = (
	read: WalkedRead,
	tables: ReadTables,
	outer: OuterReading
): ReadonlyArray<ReadFault> => {
	const walk = new Walk(tables, outer)
	const scans: Array<{ readonly alias: string; readonly table: ObjectName }> = []
	const readCtes = new Set<string>()
	const defined: Array<Cte> = []
	const hooks = {
		...identityHooks,
		fromSource: (source: FromSource): FromSource => {
			if (source.kind === "table" && typeof source.table !== "string") {
				scans.push({ alias: source.alias, table: source.table })
			} else if (source.kind === "cte" || source.kind === "enclosing") {
				readCtes.add(source.name)
			}
			return source
		},
		select: (q: OperandSelect): OperandSelect => {
			for (const c of q.with?.ctes ?? []) {
				defined.push(c)
			}
			return q
		}
	}
	switch (read.kind) {
		case "statement":
			walk.statement(read.statement, [])
			transformStatement(read.statement, hooks)
			if (read.statement.kind !== "select" && "with" in read.statement) {
				for (const c of read.statement.with?.ctes ?? []) {
					defined.push(c)
				}
			}
			break
		case "query":
			walk.query(printedQueryOnce(read.query), undefined, [], [], nothingPushed)
			transformQuery(read.query, hooks)
			break
	}
	for (const c of defined) {
		if (!readCtes.has(c.name) && c.query.kind === "select") {
			walk.unread(c.query)
		}
	}
	return [...walk.faults, ...unwalked(scans, walk.judged, tables)]
}

/**
 * The scans of a unit's relation the statement holds that the walk judged at no level (Walk `judged`), every table
 * source the statement's whole tree holds, read by the one total traversal every rewrite of a statement runs
 * (sql/transform.ts): a shape the walk does not model leaves its scans unjudged, and an unjudged scan is unbound, never
 * passed.
 */
const unwalked = (
	scans: ReadonlyArray<{ readonly alias: string; readonly table: ObjectName }>,
	judged: ReadonlySet<string>,
	tables: ReadTables
): ReadonlyArray<ReadFault> =>
	scans.flatMap(({ alias, table }) => {
		const facts = tables.get(nameKey(table))
		const unit = facts?.unit
		return facts === undefined || unit?.kind !== "member" || judged.has(alias)
			? []
			: [
					{
						kind: "unboundUnitRead" as const,
						relation: facts.relation,
						alias,
						unit: unit.name,
						missing: mapNonEmpty(unit.columns, (column) => ({
							column,
							reason: "unwalked" as const
						})),
						at: ["unwalked", alias]
					}
				]
	})
