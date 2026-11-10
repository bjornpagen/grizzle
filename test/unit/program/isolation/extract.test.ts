/**
 * What a change member's statements read and write, as the isolation certifier reads them (program/isolation/extract.ts
 * memberFacts): every read with its mode, whether it is the call's own, the fields it is bound at and what binds
 * them; and every write with the positive reads that feed it.
 *
 * Each case draws a member of one to three statements over W, R and S, stored relations of fields id, a and b whose
 * tables also hold a column no field is (a law column), and X, a table no relation names: a SELECT; an INSERT with ON
 * CONFLICT DO NOTHING, DO SELECT or DO UPDATE over drawn conflict columns or ON CONSTRAINT, an UPDATE, a DELETE (an
 * INSERT's and a DELETE's target may be a carrier), or a MERGE of up to three WHEN clauses; with statement CTEs that
 * read or write, the reading ones read where a source names them; an ANALYZE, a REFRESH, or a statement no member
 * sends. Each query is a core or a UNION, EXCEPT or INTERSECT of cores. A core reads tables, carriers, CTEs, relation
 * inputs' arrays, VALUES, a function's rows and derived tables, joined in one chain or crosswise, under a WHERE and ON
 * conjuncts that equate a table's columns with a placeholder, an own source's column of its core or an enclosing one,
 * another table's column, a literal or a cast placeholder; it filters by EXISTS, NOT EXISTS, IN, NOT IN, NOT and calls
 * of schema functions, nested; it counts by GROUP BY, HAVING, count(*), an aggregate call, ordered-set ones among them,
 * an aggregate inside COALESCE, or a window call; and it projects a scalar subquery, an ARRAY or an EXISTS.
 *
 * Oracle: the extractor's contract restated over the drawn shape, never over the built statements.
 * - A read's polarity: NOT flips it, an EXCEPT arm after the first flips it, EXISTS and IN keep it and their NOT flips
 *   it in a condition, and in a value either is either way, `both`. Counted beneath a counting core (a GROUP BY, a
 *   HAVING, a call over many rows, an aggregate's or a window's), a scalar subquery and an ARRAY. Probe on the table
 *   sources of an EXISTS's own cores alone.
 * - A read's mode: arbiter for a probe of a relation its statement writes, an ON CONFLICT, and a MERGE's NOT MATCHED
 *   where it writes; else negated where not positive; else counted where counted; else positive.
 * - A carrier read is the call's own, of no group; a table no relation names is `?schema.name`, a schema function the
 *   names do not clear `?function:schema.name`, negated, a REFRESH `?refresh:schema.name` and a statement no member
 *   sends `?statement:<kind>`.
 * - A table's group is the fields of its columns its core's conditions (its WHERE and every ON of its FROM; a MERGE's ON
 *   and its clause's condition as the clause reads it) equate with a placeholder or a column of an own source in
 *   scope, its core's or an enclosing core's (a non-LATERAL derived table and a CTE see none of their reader's), the
 *   field-less column dropped, sorted; its binding is their texts in that order. An ON CONFLICT's group is its conflict
 *   columns', each bound to EXCLUDED's.
 * - A query CTE is read where a source names it, with that source's polarity, count and writes; a writing CTE runs once.
 * - A write's `from` is the positive reads that feed it: its source's, an UPDATE's and a DELETE's target and FROM, a
 *   MERGE's source and every target read; a DO UPDATE writes its table twice from them.
 * Reads are compared as multisets, the arbitrations after every other read, and writes by the reads their `from` names.
 *
 * Planted in a scratch copy of the extractor, each of these fails the search: NOT EXISTS read as positive, an
 * aggregate's scan read as positive, a probe of the written relation read as negated, and a table no relation names
 * dropped instead of named.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	type Weighted,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { type ExtractNames, memberFacts } from "#compiler/program/isolation/extract.ts"
import type {
	Cte,
	Delete,
	Expr,
	FromItem,
	FromSource,
	Insert,
	JoinStep,
	Merge,
	MergeWhen,
	ObjectName,
	OperandCore,
	OperandSelect,
	Select,
	SelectBody,
	SqlStatement,
	TableName,
	Target,
	Update,
	With
} from "#compiler/sql/ast.ts"
import {
	and,
	arrays,
	asc,
	call,
	cast,
	col,
	columnDefinition,
	core,
	countStar,
	cteRefAs,
	derived,
	eq,
	exists,
	firstNonNull,
	lit,
	not,
	objectName,
	operandSelect,
	param,
	positionalValue,
	proved,
	qualifiedCall,
	select,
	setOp,
	setOperation,
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import { carrierName } from "#compiler/sql/naming.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The relations the drawn statements name: three stored ones, and X, whose table no relation names. */
type Rel = "W" | "R" | "S" | "X"
const RELS: Arr.NonEmptyReadonlyArray<Rel> = ["W", "R", "S", "X"]
const TABLES: Readonly<Record<Rel, ObjectName>> = {
	W: objectName("app", "w"),
	R: objectName("app", "r"),
	S: objectName("app", "s"),
	X: objectName("app", "x")
}
/** The relation a read or a write of `rel` names: its own, or `?schema.name` for X. */
const relationOf = (rel: Rel): string => (rel === "X" ? "?app.x" : rel)

/** The columns of every table: three fields' and a law column's, which no field is. */
const COLUMNS = ["c_id", "c_a", "c_b", "c_hidden"] as const
type Column = (typeof COLUMNS)[number]
const FIELDS: ReadonlyMap<string, string> = new Map([
	["c_id", "id"],
	["c_a", "a"],
	["c_b", "b"]
])

/** A function the names know reads no table, as a refusal function reads none; any other schema function may read
 * relations in its body, as a world's filter function does. */
const NO_TABLE = "refuse"
const READS_TABLES = "filter_rows"

const NAMES: ExtractNames = {
	relationOf: (table) =>
		Option.getOrUndefined(
			Arr.findFirst(
				["W", "R", "S"] as const,
				(rel) => TABLES[rel].schema === table.schema && TABLES[rel].name === table.name
			)
		),
	fieldOf: (relation, column) =>
		relation === "W" || relation === "R" || relation === "S" ? FIELDS.get(column) : undefined,
	readsNoTable: (fn) => fn.schema === "app" && fn.name === NO_TABLE
}

/** A source of a core that is the call's own: a relation input's arrays, VALUES, a CTE, a carrier or a function. */
type OwnKind = "arrays" | "values" | "cte" | "carrier" | "function"
const OWN_KINDS: Arr.NonEmptyReadonlyArray<OwnKind> = [
	"arrays",
	"values",
	"cte",
	"carrier",
	"function"
]

/**
 * What a table's column is equated with: a placeholder; an own source's column, one of the core's own or derived
 * sources, or one of an enclosing core's own sources, resolved where the core has one and else a placeholder of its
 * number; another table's column; a literal; or a placeholder cast.
 */
type Other =
	| { readonly kind: "param"; readonly slot: number }
	| { readonly kind: "own"; readonly at: number }
	| { readonly kind: "outer"; readonly at: number }
	| { readonly kind: "table"; readonly at: number }
	| { readonly kind: "literal" }
	| { readonly kind: "cast"; readonly slot: number }

/** One equality over a table's column: its other side, which side the column stands on, and whether it is an ON's. */
interface Equality {
	readonly column: Column
	readonly other: Other
	readonly flipped: boolean
	readonly inJoin: boolean
}

type Source =
	| { readonly kind: "table"; readonly rel: Rel; readonly equalities: ReadonlyArray<Equality> }
	| { readonly kind: "own"; readonly own: OwnKind; readonly at: number }
	| { readonly kind: "derived"; readonly query: QuerySpec }

/** A filter: EXISTS, IN, NOT, or a call of a schema function, one the names know reads no table or not. */
type Filter =
	| { readonly kind: "exists"; readonly not: boolean; readonly query: QuerySpec }
	| { readonly kind: "in"; readonly not: boolean; readonly query: QuerySpec }
	| { readonly kind: "not"; readonly inner: Filter }
	| { readonly kind: "call"; readonly readsNoTable: boolean }

/** The calls over many rows a core may hold: PostgreSQL's aggregates, the ordered-set ones among them, and its window
 * functions, which a core calls only OVER a window. */
const AGGREGATES = [
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"bool_and",
	"bool_or",
	"range_agg",
	"array_agg",
	"jsonb_agg",
	"string_agg",
	"bit_or"
] as const
const ORDERED_SET = ["percentile_disc", "percentile_cont", "mode"] as const
const WINDOWS = ["row_number", "rank", "dense_rank", "lead", "lag"] as const

type Aggregate =
	| { readonly kind: "none" }
	| { readonly kind: "groupBy" }
	| { readonly kind: "having" }
	| { readonly kind: "countStar" }
	| { readonly kind: "nested" }
	| { readonly kind: "call"; readonly name: (typeof AGGREGATES)[number] }
	| { readonly kind: "orderedSet"; readonly name: (typeof ORDERED_SET)[number] }
	| { readonly kind: "window" }
	| { readonly kind: "windowCall"; readonly name: (typeof WINDOWS)[number] }

/** What a core projects beside its first target: nothing, or a scalar subquery, an ARRAY or an EXISTS. */
type Projection =
	| { readonly kind: "plain" }
	| { readonly kind: "subquery" | "array" | "exists"; readonly query: QuerySpec }

interface CoreSpec {
	readonly sources: Arr.NonEmptyReadonlyArray<Source>
	readonly filters: ReadonlyArray<Filter>
	readonly aggregate: Aggregate
	readonly projection: Projection
	/** Whether the WHERE nests its conjunctions, which the extractor flattens. */
	readonly nested: boolean
}

/** A query: one core, or a set operation of them all, left to right. */
interface QuerySpec {
	readonly cores: Arr.NonEmptyReadonlyArray<CoreSpec>
	readonly op: "UNION" | "EXCEPT" | "INTERSECT"
}

type TargetSpec = { readonly kind: "table"; readonly rel: Rel } | { readonly kind: "carrier" }

/** An INSERT's ON CONFLICT: none, an action over conflict columns, or DO NOTHING ON CONSTRAINT. */
type Conflict =
	| { readonly kind: "none" }
	| {
			readonly kind: "columns"
			readonly columns: Arr.NonEmptyReadonlyArray<Column>
			readonly action: "doNothing" | "doSelect" | "doUpdate"
	  }
	| { readonly kind: "constraint" }

/** A MERGE's WHEN clause: its match, its action, and whether its condition binds the target's c_a to `$7`. */
type WhenSpec =
	| {
			readonly match: "MATCHED" | "NOT MATCHED BY SOURCE"
			readonly action: "update" | "delete" | "doNothing"
			readonly condition: boolean
	  }
	| {
			readonly match: "NOT MATCHED"
			readonly action: "insert" | "insertDefault" | "doNothing"
			readonly condition: boolean
	  }

type Dml =
	| {
			readonly kind: "insert"
			readonly target: TargetSpec
			readonly source: QuerySpec | undefined
			readonly conflict: Conflict
	  }
	| {
			readonly kind: "update"
			readonly rel: Rel
			readonly from: CoreSpec
			readonly keyed: Column | undefined
	  }
	| {
			readonly kind: "delete"
			readonly target: TargetSpec
			readonly using: CoreSpec
			readonly keyed: Column | undefined
	  }
	| {
			readonly kind: "merge"
			readonly rel: Rel
			readonly using: QuerySpec
			readonly whens: Arr.NonEmptyReadonlyArray<WhenSpec>
	  }

type CteSpec =
	| { readonly kind: "query"; readonly query: QuerySpec }
	| { readonly kind: "dml"; readonly dml: Dml }

type StatementSpec =
	| { readonly kind: "dml"; readonly dml: Dml; readonly ctes: ReadonlyArray<CteSpec> }
	| { readonly kind: "select"; readonly query: QuerySpec; readonly ctes: ReadonlyArray<CteSpec> }
	| { readonly kind: "analyze" | "refresh" | "schema" }

interface MemberCase {
	readonly statements: Arr.NonEmptyReadonlyArray<StatementSpec>
}

/** The other side of an equality over the `self`-th of a core's `tables` tables, beside its `owns` own sources. */
const otherGen = (owns: number, tables: number, self: number): Gen<Other> => {
	const own: ReadonlyArray<Weighted<Other>> =
		owns > 0 ? [[3, (s) => ({ kind: "own", at: s.draw(int(0, owns - 1)) })]] : []
	const table: ReadonlyArray<Weighted<Other>> =
		tables > 1
			? [
					[
						1,
						(s) => {
							const at = s.draw(int(0, tables - 2))
							return { kind: "table", at: at >= self ? at + 1 : at }
						}
					]
				]
			: []
	return weighted<Other>([
		[3, (s) => ({ kind: "param", slot: s.draw(int(1, 9)) })],
		...own,
		...table,
		[2, (s) => ({ kind: "outer", at: s.draw(int(0, 3)) })],
		[1, () => ({ kind: "literal" })],
		[1, (s) => ({ kind: "cast", slot: s.draw(int(1, 9)) })]
	])
}

const derivedArm: Weighted<"table" | "own" | "derived"> = [1, () => "derived"]

/** A core's sources first, then each table's equalities over distinct columns of it. */
const coreGen =
	(depth: number): Gen<CoreSpec> =>
	(s) => {
		const shapes = nonEmpty(
			s.draw(
				array(
					weighted<"table" | "own" | "derived">([
						[4, () => "table"],
						[2, () => "own"],
						...(depth > 0 ? [derivedArm] : [])
					]),
					{ min: 1, max: 3 }
				)
			),
			"a core's sources"
		)
		const owns = Arr.filter(shapes, (k) => k !== "table").length
		const tables = Arr.filter(shapes, (k) => k === "table").length
		const sources = Arr.map(shapes, (kind, at): Source => {
			switch (kind) {
				case "table": {
					const self = Arr.filter(Arr.take(shapes, at), (k) => k === "table").length
					const columns = Arr.dedupe(s.draw(array(element(COLUMNS), { min: 0, max: 3 })))
					return {
						kind: "table",
						rel: s.draw(element(RELS)),
						equalities: Arr.map(columns, (column) => ({
							column,
							other: s.draw(otherGen(owns, tables, self)),
							flipped: s.draw(boolean),
							inJoin: s.draw(boolean)
						}))
					}
				}
				case "own":
					return { kind: "own", own: s.draw(element(OWN_KINDS)), at: s.draw(int(0, 2)) }
				case "derived":
					return { kind: "derived", query: s.draw(queryGen(depth - 1)) }
			}
		})
		return {
			sources: nonEmpty(sources, "a core's sources"),
			filters: depth > 0 ? s.draw(array(filterGen(depth - 1), { min: 0, max: 2 })) : [],
			aggregate: s.draw(aggregateGen),
			projection:
				depth > 0
					? s.draw(
							weighted<Projection>([
								[6, () => ({ kind: "plain" })],
								[1, (t) => ({ kind: "subquery", query: t.draw(queryGen(depth - 1)) })],
								[1, (t) => ({ kind: "array", query: t.draw(queryGen(depth - 1)) })],
								[1, (t) => ({ kind: "exists", query: t.draw(queryGen(depth - 1)) })]
							])
						)
					: { kind: "plain" },
			nested: s.draw(boolean)
		}
	}

const aggregateGen: Gen<Aggregate> = weighted<Aggregate>([
	[8, () => ({ kind: "none" })],
	[1, () => ({ kind: "groupBy" })],
	[1, () => ({ kind: "having" })],
	[1, () => ({ kind: "countStar" })],
	[1, () => ({ kind: "nested" })],
	[1, (s) => ({ kind: "call", name: s.draw(element(AGGREGATES)) })],
	[1, (s) => ({ kind: "orderedSet", name: s.draw(element(ORDERED_SET)) })],
	[1, () => ({ kind: "window" })],
	[1, (s) => ({ kind: "windowCall", name: s.draw(element(WINDOWS)) })]
])

const filterGen = (depth: number): Gen<Filter> =>
	weighted<Filter>([
		[3, (s) => ({ kind: "exists", not: s.draw(boolean), query: s.draw(queryGen(depth)) })],
		[1, (s) => ({ kind: "in", not: s.draw(boolean), query: s.draw(queryGen(depth)) })],
		[1, (s) => ({ kind: "not", inner: s.draw(filterGen(depth)) })],
		[1, (s) => ({ kind: "call", readsNoTable: s.draw(boolean) })]
	])

const queryGen =
	(depth: number): Gen<QuerySpec> =>
	(s) => ({
		cores: nonEmpty(
			s.draw(
				weighted<ReadonlyArray<CoreSpec>>([
					[4, (t) => [t.draw(coreGen(depth))]],
					[1, (t) => t.draw(array(coreGen(depth), { min: 2, max: 3 }))]
				])
			),
			"a query's cores"
		),
		op: s.draw(element(["UNION", "EXCEPT", "INTERSECT"] as const))
	})

/** A DML's target: a stored relation, or, for an INSERT and a DELETE, a carrier, which is no relation's write. */
const targetGen: Gen<TargetSpec> = weighted<TargetSpec>([
	[4, (s) => ({ kind: "table", rel: s.draw(element(RELS)) })],
	[1, () => ({ kind: "carrier" })]
])

const conflictGen: Gen<Conflict> = weighted<Conflict>([
	[2, () => ({ kind: "none" })],
	[
		3,
		(s) => ({
			kind: "columns",
			columns: nonEmpty(
				Arr.dedupe(s.draw(array(element(COLUMNS), { min: 1, max: 3 }))),
				"conflict columns"
			),
			action: s.draw(element(["doNothing", "doSelect", "doUpdate"] as const))
		})
	],
	[1, () => ({ kind: "constraint" })]
])

const whenGen: Gen<WhenSpec> = weighted<WhenSpec>([
	[
		2,
		(s) => ({
			match: s.draw(element(["MATCHED", "NOT MATCHED BY SOURCE"] as const)),
			action: s.draw(element(["update", "delete", "doNothing"] as const)),
			condition: s.draw(boolean)
		})
	],
	[
		2,
		(s) => ({
			match: "NOT MATCHED",
			action: s.draw(element(["insert", "insertDefault", "doNothing"] as const)),
			condition: s.draw(boolean)
		})
	]
])

/** An UPDATE's FROM or a DELETE's USING: a core's sources and filters, counting and projecting nothing. */
const flatCoreGen: Gen<CoreSpec> = (s) => ({
	...s.draw(coreGen(1)),
	aggregate: { kind: "none" },
	projection: { kind: "plain" }
})

const keyedGen: Gen<Column | undefined> = weighted<Column | undefined>([
	[1, () => undefined],
	[1, (s) => s.draw(element(COLUMNS))]
])

const dmlGen: Gen<Dml> = weighted<Dml>([
	[
		3,
		(s) => ({
			kind: "insert",
			target: s.draw(targetGen),
			source: s.draw(
				weighted<QuerySpec | undefined>([
					[5, (t) => t.draw(queryGen(2))],
					[1, () => undefined]
				])
			),
			conflict: s.draw(conflictGen)
		})
	],
	[
		1,
		(s) => ({
			kind: "update",
			rel: s.draw(element(RELS)),
			from: s.draw(flatCoreGen),
			keyed: s.draw(keyedGen)
		})
	],
	[
		1,
		(s) => ({
			kind: "delete",
			target: s.draw(targetGen),
			using: s.draw(flatCoreGen),
			keyed: s.draw(keyedGen)
		})
	],
	[
		1,
		(s) => ({
			kind: "merge",
			rel: s.draw(element(RELS)),
			using: s.draw(queryGen(1)),
			whens: nonEmpty(s.draw(array(whenGen, { min: 1, max: 3 })), "a MERGE's WHEN clauses")
		})
	]
])

const cteGen: Gen<CteSpec> = weighted<CteSpec>([
	[2, (s) => ({ kind: "query", query: s.draw(queryGen(1)) })],
	[1, (s) => ({ kind: "dml", dml: s.draw(dmlGen) })]
])

const statementGen: Gen<StatementSpec> = weighted<StatementSpec>([
	[
		6,
		(s) => ({ kind: "dml", dml: s.draw(dmlGen), ctes: s.draw(array(cteGen, { min: 0, max: 2 })) })
	],
	[
		2,
		(s) => ({
			kind: "select",
			query: s.draw(queryGen(2)),
			ctes: s.draw(array(cteGen, { min: 0, max: 2 }))
		})
	],
	[1, (s) => ({ kind: s.draw(element(["analyze", "refresh", "schema"] as const)) })]
])

const caseGen: Gen<MemberCase> = (s) => ({
	statements: nonEmpty(s.draw(array(statementGen, { min: 1, max: 3 })), "a member's statements")
})

/** The column every own and derived source delivers, which an IN and an aggregate read. */
const OWN_COLUMN = "v"

/**
 * The query CTEs a statement's sources may name, by name, beside its WITH: a CTE's body, and a writing CTE's source,
 * name none, so no CTE reads another and none is read before it is defined.
 */
type Env = ReadonlyArray<{
	readonly name: string
	readonly path: string
	readonly query: QuerySpec
}>

/** A source as its core places it: under its alias, an own CTE source resolved to the CTE it names, or VALUES where the
 * statement defines none. */
type PlacedSource =
	| {
			readonly kind: "table"
			readonly alias: string
			readonly rel: Rel
			readonly equalities: ReadonlyArray<Equality>
	  }
	| { readonly kind: "carrier"; readonly alias: string; readonly carrier: number }
	| {
			readonly kind: "cte"
			readonly alias: string
			readonly name: string
			readonly path: string
			readonly query: QuerySpec
	  }
	| {
			readonly kind: "plain"
			readonly alias: string
			readonly own: "arrays" | "values" | "function"
	  }
	| { readonly kind: "derived"; readonly alias: string; readonly query: QuerySpec }

/** A core's sources under their aliases, each named by the core's path, so the statement and the oracle agree. */
const placed = (c: CoreSpec, path: string, env: Env): Arr.NonEmptyReadonlyArray<PlacedSource> =>
	Arr.map(c.sources, (s, i): PlacedSource => {
		const alias = `${path}s${i}`
		switch (s.kind) {
			case "table":
				return { kind: "table", alias, rel: s.rel, equalities: s.equalities }
			case "derived":
				return { kind: "derived", alias, query: s.query }
			case "own":
				switch (s.own) {
					case "carrier":
						return { kind: "carrier", alias, carrier: s.at + 1 }
					case "cte": {
						const named = env[s.at % Math.max(env.length, 1)]
						return named === undefined
							? { kind: "plain", alias, own: "values" }
							: { kind: "cte", alias, name: named.name, path: named.path, query: named.query }
					}
					case "arrays":
					case "values":
					case "function":
						return { kind: "plain", alias, own: s.own }
				}
		}
	})

/** The own sources' aliases of a core, in source order: what an own equality's index names. */
const ownAliases = (sources: ReadonlyArray<PlacedSource>): ReadonlyArray<string> =>
	Arr.flatMap(sources, (s) => (s.kind === "table" ? [] : [s.alias]))

/** An equality's other side as its core reads it, an enclosing core's own source resolved in `scope`. */
type ResolvedOther =
	| { readonly kind: "param"; readonly slot: number }
	| { readonly kind: "own"; readonly alias: string }
	| { readonly kind: "table"; readonly alias: string }
	| { readonly kind: "literal" }
	| { readonly kind: "cast"; readonly slot: number }

const resolveOther = (
	o: Other,
	owns: ReadonlyArray<string>,
	tables: ReadonlyArray<string>,
	scope: ReadonlyArray<string>
): ResolvedOther => {
	switch (o.kind) {
		case "param":
		case "literal":
		case "cast":
			return o
		case "own":
			return { kind: "own", alias: Arr.getUnsafe(owns, o.at) }
		case "table":
			return { kind: "table", alias: Arr.getUnsafe(tables, o.at) }
		case "outer": {
			const at = scope[o.at % Math.max(scope.length, 1)]
			return at === undefined ? { kind: "param", slot: o.at + 1 } : { kind: "own", alias: at }
		}
	}
}

/** The expression of a resolved other side. */
const otherExpr = (o: ResolvedOther): Expr => {
	switch (o.kind) {
		case "param":
			return param(o.slot, types.integer)
		case "own":
			return col(o.alias, OWN_COLUMN)
		case "table":
			return col(o.alias, "c_b")
		case "literal":
			return lit.int(3, types.integer)
		case "cast":
			return cast(param(o.slot, types.integer), types.bigint)
	}
}

/** The text a binding names a resolved other side by, none for one that binds nothing. */
const bindingText = (o: ResolvedOther): string | undefined =>
	o.kind === "param" ? `$${o.slot}` : o.kind === "own" ? `${o.alias}.${OWN_COLUMN}` : undefined

/** The first column a core's first source delivers: a table's c_a, any other's v. */
const firstColumn = (sources: Arr.NonEmptyReadonlyArray<PlacedSource>): Expr => {
	const [first] = sources
	return col(first.alias, first.kind === "table" ? "c_a" : OWN_COLUMN)
}

/** The FROM source of a placed source. */
const fromSource = (p: PlacedSource, scope: ReadonlyArray<string>, env: Env): FromSource => {
	switch (p.kind) {
		case "table":
			return { kind: "table", table: TABLES[p.rel], alias: p.alias }
		case "carrier":
			return { kind: "table", table: carrierName(p.carrier), alias: p.alias }
		case "cte":
			return cteRefAs(p.name, p.alias)
		case "derived":
			return derived(buildOperand(p.query, `${p.alias}q`, scope, env), p.alias, [OWN_COLUMN], false)
		case "plain":
			switch (p.own) {
				case "arrays":
					return arrays(
						{
							kind: "columns",
							columns: [
								{
									definition: columnDefinition(OWN_COLUMN, types.integer),
									array: positionalValue(1)
								}
							],
							ordinal: undefined
						},
						p.alias
					)
				case "values":
					return {
						kind: "values",
						rows: [[lit.int(1, types.integer)]],
						alias: p.alias,
						columns: [OWN_COLUMN]
					}
				case "function":
					return {
						kind: "function",
						call: call("generate_series", [lit.int(1, types.integer), lit.int(2, types.integer)]),
						alias: p.alias,
						columns: [OWN_COLUMN],
						lateral: false
					}
			}
	}
}

/** A core's aggregate as its targets, GROUP BY and HAVING hold it. */
const aggregateParts = (
	a: Aggregate,
	column: Expr
): {
	readonly target: Expr
	readonly groupBy: ReadonlyArray<Expr>
	readonly having: Expr | undefined
} => {
	const one = lit.int(1, types.integer)
	const plain = (target: Expr) => ({ target, groupBy: [], having: undefined })
	switch (a.kind) {
		case "none":
			return plain(one)
		case "groupBy":
			return { target: column, groupBy: [column], having: undefined }
		case "having":
			return { target: one, groupBy: [], having: eq(one, one) }
		case "countStar":
			return plain(countStar())
		case "nested":
			return plain(firstNonNull([countStar(), lit.int(0, types.bigint)]))
		case "call":
			return plain(
				a.name === "string_agg"
					? call(a.name, [column, lit.text(",", types.text)])
					: call(a.name, [column])
			)
		case "orderedSet":
			return plain({
				...call(a.name, a.name === "mode" ? [] : [lit.float(0.5, types.double)]),
				withinGroup: [asc(column)]
			})
		case "window":
			return plain({ ...countStar(), over: windowOf([], []) })
		case "windowCall":
			return plain({
				...call(a.name, a.name === "lead" || a.name === "lag" ? [column] : []),
				over: windowOf([], [])
			})
	}
}

/** A filter's expression. */
const filterExpr = (
	f: Filter,
	path: string,
	scope: ReadonlyArray<string>,
	env: Env,
	column: Expr
): Expr => {
	switch (f.kind) {
		case "exists":
			return { kind: "exists", query: buildOperand(f.query, `${path}q`, scope, env), not: f.not }
		case "in":
			return {
				kind: "inQuery",
				expr: column,
				query: buildOperand(f.query, `${path}q`, scope, env),
				not: f.not
			}
		case "not":
			return not(filterExpr(f.inner, `${path}n`, scope, env, column))
		case "call":
			return qualifiedCall("app", f.readsNoTable ? NO_TABLE : READS_TABLES, [column])
	}
}

/** The conjuncts of a core's tables' equalities, each in its WHERE or in one of its join chain's ONs. */
const equalityConjuncts = (
	sources: Arr.NonEmptyReadonlyArray<PlacedSource>,
	scope: ReadonlyArray<string>
): { readonly where: ReadonlyArray<Expr>; readonly ons: ReadonlyArray<ReadonlyArray<Expr>> } => {
	const owns = ownAliases(sources)
	const tables = Arr.flatMap(sources, (s) => (s.kind === "table" ? [s.alias] : []))
	const where: Array<Expr> = []
	const ons: Array<Array<Expr>> = Arr.map(sources, () => [])
	const placedTables = Arr.flatMap(sources, (s) => (s.kind === "table" ? [s] : []))
	Arr.forEach(placedTables, (s, k) => {
		for (const e of s.equalities) {
			const mine = col(s.alias, e.column)
			const other = otherExpr(resolveOther(e.other, owns, tables, scope))
			const conjunct = e.flipped ? eq(other, mine) : eq(mine, other)
			if (sources.length > 1 && e.inJoin) {
				Arr.getUnsafe(ons, 1 + (k % (sources.length - 1))).push(conjunct)
			} else {
				where.push(conjunct)
			}
		}
	})
	return { where, ons }
}

/** A core: its sources' FROM, a join chain where it reads several, its conditions, its aggregate and projection. */
const buildCore = (
	c: CoreSpec,
	path: string,
	scope: ReadonlyArray<string>,
	env: Env
): OperandCore => {
	const sources = placed(c, path, env)
	const within = [...scope, ...ownAliases(sources)]
	const from = Arr.map(sources, (p) => fromSource(p, scope, env))
	const { where, ons } = equalityConjuncts(sources, scope)
	const filters = Arr.map(c.filters, (f, j) =>
		filterExpr(f, `${path}f${j}`, within, env, firstColumn(sources))
	)
	const [first, ...rest] = from
	const steps = Arr.map(rest, (source, i): JoinStep => {
		const on = Arr.getUnsafe(ons, i + 1)
		return Arr.isReadonlyArrayNonEmpty(on)
			? { kind: "on", source, on: and(on) }
			: { kind: "cross", source }
	})
	const items: ReadonlyArray<FromItem> = Arr.isReadonlyArrayNonEmpty(steps)
		? [{ kind: "joins", first, steps }]
		: [first]
	const parts = aggregateParts(c.aggregate, firstColumn(sources))
	const projected: ReadonlyArray<Target> = ((): ReadonlyArray<Target> => {
		const p = c.projection
		switch (p.kind) {
			case "plain":
				return []
			case "subquery":
				return [
					targetAs({ kind: "subquery", query: buildOperand(p.query, `${path}p`, within, env) }, "q")
				]
			case "array":
				return [
					targetAs({ kind: "array", query: buildSelect(p.query, `${path}p`, within, env) }, "q")
				]
			case "exists":
				return [targetAs(exists(buildOperand(p.query, `${path}p`, within, env)), "q")]
		}
	})()
	const conjuncts = [...where, ...filters]
	const [w0, ...wRest] = conjuncts
	const whereExpr =
		w0 === undefined
			? undefined
			: c.nested && Arr.isReadonlyArrayNonEmpty(wRest)
				? and([w0, and(wRest)])
				: and([w0, ...wRest])
	return {
		...core([targetAs(parts.target, OWN_COLUMN), ...projected], items, whereExpr),
		groupBy: parts.groupBy,
		having: parts.having
	}
}

const buildOperand = (
	q: QuerySpec,
	path: string,
	scope: ReadonlyArray<string>,
	env: Env
): OperandSelect =>
	operandSelect(
		setOp(
			q.op,
			Arr.map(q.cores, (c, k) => buildCore(c, `${path}c${k}`, scope, env))
		)
	)

const buildSelect = (
	q: QuerySpec,
	path: string,
	scope: ReadonlyArray<string>,
	env: Env
): Select => {
	const cores = Arr.map(q.cores, (c, k) =>
		proved("keyed", buildCore(c, `${path}c${k}`, scope, env))
	)
	const [first, second, ...rest] = cores
	const body: SelectBody =
		second === undefined ? first : setOperation(q.op, [first, second, ...rest])
	return select(body)
}

const tableOf = (t: TargetSpec): TableName => (t.kind === "table" ? TABLES[t.rel] : carrierName(9))

const one = lit.int(1, types.integer)

/** A MERGE's WHEN clause, its condition `t.c_a = $7`. */
const mergeWhen = (w: WhenSpec): MergeWhen => {
	const condition = w.condition ? eq(col("t", "c_a"), param(7, types.integer)) : undefined
	switch (w.match) {
		case "MATCHED":
		case "NOT MATCHED BY SOURCE":
			return {
				match: w.match,
				condition,
				action:
					w.action === "update"
						? { kind: "update", set: [{ column: "c_b", value: one }] }
						: w.action === "delete"
							? { kind: "delete" }
							: { kind: "doNothing" }
			}
		case "NOT MATCHED":
			return {
				match: w.match,
				condition,
				action:
					w.action === "insert"
						? { kind: "insert", overriding: undefined, row: [{ column: "c_id", value: one }] }
						: w.action === "insertDefault"
							? { kind: "insertDefault" }
							: { kind: "doNothing" }
			}
	}
}

/** A DML statement or CTE body, from its spec at `path`. */
const buildDml = (
	d: Dml,
	path: string,
	outer: With | undefined,
	env: Env
): Insert | Update | Delete | Merge => {
	switch (d.kind) {
		case "insert": {
			const conflict = d.conflict
			return {
				kind: "insert",
				with: outer,
				table: tableOf(d.target),
				alias: undefined,
				overriding: undefined,
				onConflict:
					conflict.kind === "none"
						? undefined
						: conflict.kind === "constraint"
							? { kind: "constraint", constraint: "w_pk", action: { kind: "doNothing" } }
							: {
									kind: "columns",
									columns: conflict.columns,
									action:
										conflict.action === "doNothing"
											? { kind: "doNothing" }
											: conflict.action === "doSelect"
												? { kind: "doSelect", where: undefined }
												: {
														kind: "doUpdate",
														set: [{ column: "c_a", value: one }],
														where: undefined
													}
								},
				returning: [],
				...(d.source === undefined
					? { columns: ["c_id"], source: { kind: "values", rows: [[one]] } }
					: {
							columns: ["c_id"],
							source: { kind: "query", query: buildSelect(d.source, `${path}i`, [], env) }
						})
			}
		}
		case "update": {
			const c = buildCore(d.from, `${path}u`, [], env)
			return {
				kind: "update",
				with: outer,
				table: TABLES[d.rel],
				alias: "t",
				set: [{ column: "c_a", value: one }],
				from: c.from,
				where: keyedWhere(c.where, d.keyed),
				returning: []
			}
		}
		case "delete": {
			const c = buildCore(d.using, `${path}d`, [], env)
			return {
				kind: "delete",
				with: outer,
				table: tableOf(d.target),
				alias: "t",
				using: c.from,
				where: keyedWhere(c.where, d.keyed),
				returning: []
			}
		}
		case "merge":
			return {
				kind: "merge",
				with: outer,
				table: TABLES[d.rel],
				alias: "t",
				using: derived(buildOperand(d.using, `${path}m`, [], env), "m", [OWN_COLUMN], false),
				on: eq(col("t", "c_id"), col("m", OWN_COLUMN)),
				whens: Arr.map(d.whens, mergeWhen),
				returning: []
			}
	}
}

/** An UPDATE's or a DELETE's WHERE, its target's `keyed` column bound to `$8` before its FROM's conditions. */
const keyedWhere = (where: Expr | undefined, keyed: Column | undefined): Expr | undefined => {
	const key = keyed === undefined ? [] : [eq(col("t", keyed), param(8, types.integer))]
	const rest = where === undefined ? [] : [where]
	const all = [...key, ...rest]
	return Arr.isReadonlyArrayNonEmpty(all) ? and(all) : undefined
}

/** A statement's query CTEs, which its sources may name: none where it defines none. */
const envOf = (ctes: ReadonlyArray<CteSpec>): Env =>
	Arr.flatMap(ctes, (c, i) =>
		c.kind === "query" ? [{ name: `c${i}`, path: `c${i}q`, query: c.query }] : []
	)

const buildStatement = (s: StatementSpec): SqlStatement => {
	switch (s.kind) {
		case "analyze":
			return { kind: "analyze", carriers: [carrierName(1)] }
		case "refresh":
			return { kind: "refresh", view: objectName("app", "v"), concurrently: false }
		case "schema":
			return { kind: "createSchema", name: "app", authorization: undefined }
		case "select":
		case "dml": {
			const env = envOf(s.ctes)
			const ctes = Arr.map(s.ctes, (c, i): Cte => ({
				name: `c${i}`,
				columns: [],
				materialized: undefined,
				query:
					c.kind === "query"
						? buildOperand(c.query, `c${i}q`, [], [])
						: buildDml(c.dml, `c${i}`, undefined, [])
			}))
			const outer: With | undefined = Arr.isReadonlyArrayNonEmpty(ctes)
				? { recursive: false, ctes }
				: undefined
			return s.kind === "select"
				? { ...buildSelect(s.query, "q", [], env), with: outer }
				: buildDml(s.dml, "", outer, env)
		}
	}
}

type Mode = "positive" | "negated" | "counted" | "arbiter"
type Polarity = "positive" | "negated" | "both"

/** A read as the oracle expects it, ReadFact's fields, and the writes its rows feed. */
interface Expected {
	readonly relation: string
	readonly mode: Mode
	readonly own: boolean
	readonly group: ReadonlyArray<string> | undefined
	readonly binding: string | undefined
}

/** Where a read stands: its polarity, whether a count stands over it, whether it is a probe's, the writes its rows
 * feed, and the own sources' aliases it sees. */
interface Place {
	readonly polarity: Polarity
	readonly counted: boolean
	readonly probe: boolean
	readonly feeds: ReadonlyArray<number>
	readonly scope: ReadonlyArray<string>
}

const topPlace: Place = { polarity: "positive", counted: false, probe: false, feeds: [], scope: [] }

const flip = (p: Polarity): Polarity =>
	p === "positive" ? "negated" : p === "negated" ? "positive" : "both"

/** What the oracle saw of a case, the shapes a coverage requirement names. */
type Shape =
	| "a positive read"
	| "a negated read"
	| "a counted read"
	| "an arbiter read"
	| "a read either way"
	| "a carrier read"
	| "a read no relation names"
	| "a group bound by a placeholder"
	| "a group bound by an own column"
	| "a group bound by an enclosing core's column"
	| "a law column dropped from a group"
	| "a write's positive reads"
	| "a MERGE"
	| "a MERGE's NOT MATCHED arbiter"
	| "a CTE read where it is named"
	| "a CTE's write"
	| "an EXCEPT arm"
	| "NOT flipped back"
	| "an aggregate inside COALESCE"
	| "a HAVING"
	| "an ordered-set aggregate"
	| "a window call"
	| "a function that may read tables"
	| "an ON CONFLICT arbiter over its conflict columns"
	| "a DO UPDATE"
	| "a target bound by its WHERE"
	| "a statement no member sends"

/** A column of a table read with what its conditions equate it with. */
interface Bound {
	readonly column: Column
	readonly other: ResolvedOther
}

/** Whether an aggregate makes its core count: every kind but none, a window call's among them. */
const counts = (a: Aggregate): boolean => a.kind !== "none"

/** One statement's expected facts, built by restating the contract over its spec. */
class Expect {
	readonly reads: Array<Expected & { readonly feeds: ReadonlyArray<number> }> = []
	readonly tail: Array<Expected> = []
	readonly writes: Array<{
		readonly relation: string
		readonly op: "insert" | "update" | "delete"
	}> = []
	readonly shapes = new Set<Shape>()
	readonly written: ReadonlySet<string>

	constructor(written: ReadonlySet<string>) {
		this.written = written
	}

	mode(place: Place, relation: string, probeable: boolean): Mode {
		if (probeable && place.probe && this.written.has(relation)) {
			return "arbiter"
		}
		if (place.polarity !== "positive") {
			return "negated"
		}
		return place.counted ? "counted" : "positive"
	}

	read(fact: Expected, feeds: ReadonlyArray<number>, place: Place): void {
		this.reads.push({ ...fact, feeds })
		this.shapes.add(
			fact.mode === "positive"
				? "a positive read"
				: fact.mode === "negated"
					? "a negated read"
					: fact.mode === "counted"
						? "a counted read"
						: "an arbiter read"
		)
		if (place.polarity === "both") {
			this.shapes.add("a read either way")
		}
	}

	/** A table read under its conditions' bindings: each field bound by a placeholder or an own column, sorted. */
	table(rel: Rel, place: Place, bound: ReadonlyArray<Bound>): void {
		const relation = relationOf(rel)
		if (rel === "X") {
			this.shapes.add("a read no relation names")
		}
		const fields = Arr.flatMap(bound, (b) => {
			const text = bindingText(b.other)
			const field = FIELDS.get(b.column)
			if (text !== undefined && field === undefined) {
				this.shapes.add("a law column dropped from a group")
			}
			return text === undefined || field === undefined || rel === "X" ? [] : [{ field, text }]
		})
		const sorted = Arr.sort(
			fields,
			Order.mapInput(Order.String, (b: { readonly field: string }) => b.field)
		)
		this.read(
			{
				relation,
				mode: this.mode(place, relation, true),
				own: false,
				group: Arr.isReadonlyArrayNonEmpty(sorted) ? Arr.map(sorted, (b) => b.field) : undefined,
				binding: Arr.isReadonlyArrayNonEmpty(sorted)
					? Arr.join(
							Arr.map(sorted, (b) => b.text),
							","
						)
					: undefined
			},
			place.feeds,
			place
		)
	}

	opaque(relation: string, place: Place): void {
		this.read(
			{ relation, mode: "negated", own: false, group: undefined, binding: undefined },
			[],
			place
		)
	}

	write(relation: string | undefined, op: "insert" | "update" | "delete"): ReadonlyArray<number> {
		if (relation === undefined) {
			return []
		}
		this.writes.push({ relation, op })
		return [this.writes.length - 1]
	}

	query(q: QuerySpec, path: string, place: Place, env: Env): void {
		Arr.forEach(q.cores, (c, k) => {
			const arm = q.op === "EXCEPT" && k > 0 ? { ...place, polarity: flip(place.polarity) } : place
			if (q.op === "EXCEPT" && k > 0) {
				this.shapes.add("an EXCEPT arm")
			}
			this.core(c, `${path}c${k}`, arm, env)
		})
	}

	core(c: CoreSpec, path: string, place: Place, env: Env): void {
		const here: Place = { ...place, counted: place.counted || counts(c.aggregate) }
		const sources = placed(c, path, env)
		const owns = ownAliases(sources)
		const tables = Arr.flatMap(sources, (s) => (s.kind === "table" ? [s.alias] : []))
		const within = [...place.scope, ...owns]
		const beneath: Place = { ...here, probe: false }
		this.aggregateShapes(c.aggregate)
		for (const s of sources) {
			switch (s.kind) {
				case "table":
					this.table(
						s.rel,
						here,
						Arr.map(s.equalities, (e) => ({
							column: e.column,
							other: resolveOther(e.other, owns, tables, place.scope)
						}))
					)
					for (const e of s.equalities) {
						const o = resolveOther(e.other, owns, tables, place.scope)
						if (o.kind === "param" && FIELDS.has(e.column) && s.rel !== "X") {
							this.shapes.add("a group bound by a placeholder")
						}
						if (o.kind === "own" && FIELDS.has(e.column) && s.rel !== "X") {
							this.shapes.add(
								owns.includes(o.alias)
									? "a group bound by an own column"
									: "a group bound by an enclosing core's column"
							)
						}
					}
					break
				case "carrier": {
					this.shapes.add("a carrier read")
					const relation = `carrier:${carrierName(s.carrier)}`
					this.read(
						{
							relation,
							mode: this.mode(here, relation, false),
							own: true,
							group: undefined,
							binding: undefined
						},
						here.feeds,
						here
					)
					break
				}
				case "cte":
					this.shapes.add("a CTE read where it is named")
					this.query(s.query, s.path, { ...beneath, scope: [] }, [])
					break
				case "derived":
					this.query(s.query, `${s.alias}q`, { ...beneath, scope: place.scope }, env)
					break
				case "plain":
					break
			}
		}
		const condition: Place = { ...beneath, scope: within }
		Arr.forEach(c.filters, (f, j) => {
			this.filter(f, `${path}f${j}`, condition, env)
		})
		const value: Place = { ...beneath, scope: within }
		const p = c.projection
		switch (p.kind) {
			case "plain":
				break
			case "subquery":
			case "array":
				this.query(p.query, `${path}p`, { ...value, counted: true }, env)
				break
			case "exists":
				this.query(p.query, `${path}p`, { ...value, probe: true, polarity: "both" }, env)
				break
		}
	}

	aggregateShapes(a: Aggregate): void {
		switch (a.kind) {
			case "having":
				this.shapes.add("a HAVING")
				return
			case "nested":
				this.shapes.add("an aggregate inside COALESCE")
				return
			case "orderedSet":
				this.shapes.add("an ordered-set aggregate")
				return
			case "window":
			case "windowCall":
				this.shapes.add("a window call")
				return
			case "none":
			case "groupBy":
			case "countStar":
			case "call":
				return
		}
	}

	/** A filter in a condition: EXISTS probes and keeps its polarity, NOT EXISTS flips it, IN keeps it and NOT IN flips
	 * it, NOT flips it, and a schema function the names do not clear is a read either way. */
	filter(f: Filter, path: string, place: Place, env: Env): void {
		switch (f.kind) {
			case "exists":
				this.query(
					f.query,
					`${path}q`,
					{ ...place, probe: true, polarity: f.not ? flip(place.polarity) : place.polarity },
					env
				)
				return
			case "in":
				this.query(
					f.query,
					`${path}q`,
					{ ...place, probe: false, polarity: f.not ? flip(place.polarity) : place.polarity },
					env
				)
				return
			case "not":
				if (place.polarity === "negated") {
					this.shapes.add("NOT flipped back")
				}
				this.filter(f.inner, `${path}n`, { ...place, polarity: flip(place.polarity) }, env)
				return
			case "call":
				if (!f.readsNoTable) {
					this.shapes.add("a function that may read tables")
					this.opaque(`?function:app.${READS_TABLES}`, place)
				}
				return
		}
	}

	dml(d: Dml, path: string, env: Env): void {
		switch (d.kind) {
			case "insert": {
				const target = d.target.kind === "table" ? relationOf(d.target.rel) : undefined
				const conflict = d.conflict
				const at = [
					...this.write(target, "insert"),
					...(conflict.kind === "columns" && conflict.action === "doUpdate"
						? this.write(target, "update")
						: [])
				]
				if (conflict.kind === "columns" && conflict.action === "doUpdate" && target !== undefined) {
					this.shapes.add("a DO UPDATE")
				}
				if (d.source !== undefined) {
					this.query(d.source, `${path}i`, { ...topPlace, feeds: at }, env)
				}
				if (conflict.kind !== "none" && target !== undefined && d.target.kind === "table") {
					const rel = d.target.rel
					const fields =
						conflict.kind === "columns" && rel !== "X"
							? Arr.flatMap(conflict.columns, (column) => {
									const field = FIELDS.get(column)
									return field === undefined ? [] : [{ field, text: `excluded.${column}` }]
								})
							: []
					if (Arr.isReadonlyArrayNonEmpty(fields)) {
						this.shapes.add("an ON CONFLICT arbiter over its conflict columns")
					}
					const sorted = Arr.sort(
						fields,
						Order.mapInput(Order.String, (b: { readonly field: string }) => b.field)
					)
					this.tail.push({
						relation: target,
						mode: "arbiter",
						own: false,
						group: Arr.isReadonlyArrayNonEmpty(sorted)
							? Arr.map(sorted, (b) => b.field)
							: undefined,
						binding: Arr.isReadonlyArrayNonEmpty(sorted)
							? Arr.join(
									Arr.map(sorted, (b) => b.text),
									","
								)
							: undefined
					})
				}
				return
			}
			case "update":
			case "delete": {
				const target: TargetSpec = d.kind === "update" ? { kind: "table", rel: d.rel } : d.target
				const at = this.write(target.kind === "table" ? relationOf(target.rel) : undefined, d.kind)
				const place: Place = { ...topPlace, feeds: at }
				if (target.kind === "table") {
					if (d.keyed !== undefined && FIELDS.has(d.keyed) && target.rel !== "X") {
						this.shapes.add("a target bound by its WHERE")
					}
					this.table(
						target.rel,
						place,
						d.keyed === undefined ? [] : [{ column: d.keyed, other: { kind: "param", slot: 8 } }]
					)
				} else {
					this.shapes.add("a carrier read")
					const relation = `carrier:${carrierName(9)}`
					this.read(
						{ relation, mode: "positive", own: true, group: undefined, binding: undefined },
						at,
						place
					)
				}
				this.core(
					d.kind === "update" ? d.from : d.using,
					`${path}${d.kind === "update" ? "u" : "d"}`,
					place,
					env
				)
				return
			}
			case "merge": {
				this.shapes.add("a MERGE")
				const relation = relationOf(d.rel)
				const at = Arr.flatMap(d.whens, (w) =>
					w.action === "doNothing"
						? []
						: this.write(relation, w.action === "insertDefault" ? "insert" : w.action)
				)
				const bySource = Arr.some(d.whens, (w) => w.match === "NOT MATCHED BY SOURCE")
				const place: Place = { ...topPlace, feeds: at }
				this.query(d.using, `${path}m`, bySource ? { ...place, polarity: "both" } : place, env)
				const on: Bound = { column: "c_id", other: { kind: "own", alias: "m" } }
				const conditioned: Bound = { column: "c_a", other: { kind: "param", slot: 7 } }
				for (const w of d.whens) {
					const condition = w.condition ? [conditioned] : []
					if (w.match === "NOT MATCHED") {
						if (this.written.has(relation)) {
							this.shapes.add("a MERGE's NOT MATCHED arbiter")
						}
						this.table(d.rel, { ...place, polarity: "negated", probe: true }, [on])
					} else {
						this.table(d.rel, place, w.match === "MATCHED" ? [on, ...condition] : condition)
					}
				}
				return
			}
		}
	}
}

/** The relation a DML writes, none for a carrier's or a MERGE whose every clause does nothing. */
const writtenBy = (d: Dml): string | undefined => {
	switch (d.kind) {
		case "insert":
		case "delete":
			return d.target.kind === "table" ? relationOf(d.target.rel) : undefined
		case "update":
			return relationOf(d.rel)
		case "merge":
			return Arr.some(d.whens, (w) => w.action !== "doNothing") ? relationOf(d.rel) : undefined
	}
}

/** The relations a statement writes, at its top and in its CTEs: what makes a probe of one an arbiter read. */
const writtenIn = (s: StatementSpec): ReadonlySet<string> => {
	if (s.kind !== "dml" && s.kind !== "select") {
		return new Set()
	}
	const dmls = [
		...(s.kind === "dml" ? [s.dml] : []),
		...Arr.flatMap(s.ctes, (c) => (c.kind === "dml" ? [c.dml] : []))
	]
	return new Set(
		Arr.flatMap(dmls, (d) => {
			const relation = writtenBy(d)
			return relation === undefined ? [] : [relation]
		})
	)
}

/** A statement's expected facts: its writing CTEs run once at their definition, its query CTEs read where named. */
const expected = (s: StatementSpec): Expect => {
	const x = new Expect(writtenIn(s))
	switch (s.kind) {
		case "analyze":
			return x
		case "refresh":
			x.shapes.add("a statement no member sends")
			x.opaque("?refresh:app.v", topPlace)
			return x
		case "schema":
			x.shapes.add("a statement no member sends")
			x.opaque("?statement:createSchema", topPlace)
			return x
		case "select":
		case "dml": {
			Arr.forEach(s.ctes, (c, i) => {
				if (c.kind === "dml") {
					x.shapes.add("a CTE's write")
					x.dml(c.dml, `c${i}`, [])
				}
			})
			const env = envOf(s.ctes)
			if (s.kind === "select") {
				x.query(s.query, "q", topPlace, env)
			} else {
				x.dml(s.dml, "", env)
			}
			return x
		}
	}
}

/** A read as the comparison keys it: every field, a group's in order. */
const readKey = (r: Expected): string =>
	Arr.join(
		[
			r.relation,
			r.mode,
			`${r.own}`,
			r.group === undefined ? "-" : Arr.join(r.group, ","),
			r.binding ?? "-"
		],
		"|"
	)

const sortedKeys = (reads: ReadonlyArray<Expected>): ReadonlyArray<string> =>
	Arr.sort(Arr.map(reads, readKey), Order.String)

/** A write as the comparison keys it: its relation, its operation and the reads its `from` names, as a multiset. */
const writeKey = (relation: string, op: string, from: ReadonlyArray<Expected>): string =>
	`${relation}|${op}|${Arr.join(sortedKeys(from), ";")}`

describe("a change member's facts", () => {
	it.effect(
		"name every read by its mode, its own, its group and its binding, and every write by the positive reads that feed it, as the contract restated over the drawn statements says",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/program/isolation/extract",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the extractor's contract restated over the drawn statements: each read's mode from its place, its group and binding from its conditions, each write's positive reads"
						},
						coverage: required<Shape>(
							[
								"a positive read",
								"a negated read",
								"a counted read",
								"an arbiter read",
								"a read either way",
								"a carrier read",
								"a read no relation names",
								"a group bound by a placeholder",
								"a group bound by an own column",
								"a group bound by an enclosing core's column",
								"a law column dropped from a group",
								"a write's positive reads",
								"a MERGE",
								"a MERGE's NOT MATCHED arbiter",
								"a CTE read where it is named",
								"a CTE's write",
								"an EXCEPT arm",
								"NOT flipped back",
								"an aggregate inside COALESCE",
								"a HAVING",
								"an ordered-set aggregate",
								"a window call",
								"a function that may read tables",
								"an ON CONFLICT arbiter over its conflict columns",
								"a DO UPDATE",
								"a target bound by its WHERE",
								"a statement no member sends"
							],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const facts = memberFacts("member", Arr.map(c.statements, buildStatement), NAMES)
							assert.equal(facts.name, "member", "the member's name")
							assert.equal(
								facts.statements.length,
								c.statements.length,
								"one statement's facts per statement"
							)
							Arr.forEach(c.statements, (spec, i) => {
								const got = Arr.getUnsafe(facts.statements, i)
								const x = expected(spec)
								for (const shape of x.shapes) {
									k.note(shape)
								}
								assert.deepEqual(
									sortedKeys(got.reads),
									sortedKeys([...x.reads, ...x.tail]),
									`statement ${i}'s reads`
								)
								assert.deepEqual(
									sortedKeys(Arr.takeRight(got.reads, x.tail.length)),
									sortedKeys(x.tail),
									`statement ${i}'s ON CONFLICT arbitrations follow every other read`
								)
								const gotWrites = Arr.map(got.writes, (w) =>
									writeKey(
										w.relation,
										w.op,
										Arr.map(w.from, (at) => {
											const read = Arr.getUnsafe(got.reads, at)
											assert.equal(
												read.mode,
												"positive",
												`statement ${i}'s write of ${w.relation} names a positive read`
											)
											return read
										})
									)
								)
								const wantWrites = Arr.map(x.writes, (w, at) =>
									writeKey(
										w.relation,
										w.op,
										Arr.filter(x.reads, (r) => r.mode === "positive" && r.feeds.includes(at))
									)
								)
								assert.deepEqual(
									Arr.sort(gotWrites, Order.String),
									Arr.sort(wantWrites, Order.String),
									`statement ${i}'s writes`
								)
								if (
									Arr.some(x.writes, (_, at) =>
										Arr.some(x.reads, (r) => r.mode === "positive" && r.feeds.includes(at))
									)
								) {
									k.note("a write's positive reads")
								}
							})
						})
				)
			)
	)
})
