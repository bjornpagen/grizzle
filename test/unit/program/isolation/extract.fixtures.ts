/** What the properties of extract.test.ts read: its spaces, models and helpers. */

import { equalityClosure } from "@bjornpagen/grizzle-text/base/equality"
import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	subset,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { callGroup } from "#compiler/analysis/isolation/certify.ts"
import { bindingText, type ReadFact } from "#compiler/analysis/isolation/facts.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { type ExtractNames, type SlotFill } from "#compiler/program/isolation/extract.ts"
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
	baseCheck,
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
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { type FlatRowSource } from "#test/support/expanded.ts"
import { unitCarrierName } from "#test/support/sql.ts"

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
const relationOf = (rel: Rel): string => (rel === "X" ? '?"app"."x"' : rel)

/** The columns of every table: three fields' and a law column's, which no field is. */
const COLUMNS = ["c_id", "c_a", "c_b", "c_hidden"] as const

type Column = (typeof COLUMNS)[number]

/** Every column of a table as a driven read delivers it (sql/ast.ts DrivenColumn), each under its own name. */
const DRIVEN = Object.freeze(Arr.map(COLUMNS, (column) => ({ read: column, as: column })))

const FIELDS: ReadonlyMap<string, string> = new Map([
	["c_id", "id"],
	["c_a", "a"],
	["c_b", "b"]
])

/** A function the names know reads no table, as a refusal function reads none; any other schema function may read
 * relations in its body, as one the names state no body of (ExtractNames `bodyOf`) does. */
const NO_TABLE = "refuse"

const READS_TABLES = "filter_rows"

/** The objects an ON CONFLICT with no target arbitrates on each named relation's table, by their field columns: a key
 * of c_id, and a UNIQUE over c_a and the law column c_hidden, which no field is. */
const ARBITERS: ReadonlyArray<ReadonlyArray<Column>> = [["c_id"], ["c_a", "c_hidden"]]

export const NAMES: ExtractNames = {
	relationOf: (table) =>
		Option.getOrUndefined(
			Arr.findFirst(
				["W", "R", "S"] as const,
				(rel) => TABLES[rel].schema === table.schema && TABLES[rel].name === table.name
			)
		),
	fieldOf: (relation, column) =>
		relation === "W" || relation === "R" || relation === "S" ? FIELDS.get(column) : undefined,
	readsNoTable: (fn) => fn.schema === "app" && fn.name === NO_TABLE,
	bodyOf: () => undefined,
	policyOf: () => undefined,
	definitionOf: () => undefined,
	arbitersOf: (relation) =>
		relation === "W" || relation === "R" || relation === "S" ? ARBITERS : []
}

/**
 * A source of a core that is the call's own: a relation input's arrays, VALUES, a CTE, a carrier, a function, or the
 * session's context, whose one fact is one row of values the call holds once.
 */
type OwnKind = "arrays" | "values" | "cte" | "carrier" | "function" | "context"

const OWN_KINDS: Arr.NonEmptyReadonlyArray<OwnKind> = [
	"arrays",
	"values",
	"cte",
	"carrier",
	"function",
	"context"
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

/**
 * How a core reads a table: directly; through a derived table that only renames its columns, its i-th column the
 * table's ROTATED[i] (`plain`), which the extractor keys by the reading core's conditions through the renaming;
 * through one that also takes a LIMIT (`limited`), which no outside condition keys; or through a derived table that
 * renames such a projection's columns again under a WHERE equating some with placeholders (`stacked`), keyed by its own
 * conditions and, carried into it, the reading core's.
 */
type TableForm = "direct" | "plain" | "limited" | "stacked"

/** The table's column each of a projection's columns, named as COLUMNS, is: a rotation, so every name moves. */
const ROTATED: Readonly<Record<Column, Column>> = {
	c_id: "c_a",
	c_a: "c_b",
	c_b: "c_hidden",
	c_hidden: "c_id"
}

type Source =
	| {
			readonly kind: "table"
			readonly rel: Rel
			readonly form: TableForm
			readonly equalities: ReadonlyArray<Equality>
			/** A stacked form's WHERE: each of its columns equated with a placeholder. */
			readonly inner: ReadonlyArray<{ readonly column: Column; readonly slot: number }>
	  }
	| { readonly kind: "own"; readonly own: OwnKind; readonly at: number }
	| { readonly kind: "derived"; readonly query: QuerySpec }
	| {
			/** A write's read of a stored table driven by the core's rows, at a key, a group or a group's last row. */
			readonly kind: "probe"
			readonly rel: Rel
			readonly by: "key" | "group" | "last"
			readonly equalities: Arr.NonEmptyReadonlyArray<{
				readonly column: Column
				readonly other: Other
			}>
	  }
	| {
			/**
			 * An INSERT's met rows: the rows of the statement's query CTE `proposed` its writing CTE `insert` did not insert,
			 * each an index among the statement's CTEs of its kind.
			 */
			readonly kind: "metRows"
			readonly insert: number
			readonly proposed: number
	  }
	| {
			/**
			 * The row an arbitration met for the met rows `rows` names, an index among the own sources the core sees, its
			 * own first, at `columns`, each bound to the met rows' column.
			 */
			readonly kind: "met"
			readonly rel: Rel
			readonly rows: number
			readonly columns: Arr.NonEmptyReadonlyArray<Column>
	  }

/** A filter: EXISTS, IN, NOT, or a call of a schema function, one the names know reads no table, or one that may read
 * tables. */
type Filter =
	| { readonly kind: "exists"; readonly not: boolean; readonly query: QuerySpec }
	| { readonly kind: "in"; readonly not: boolean; readonly query: QuerySpec }
	| { readonly kind: "not"; readonly inner: Filter }
	| { readonly kind: "call"; readonly fn: "noTable" | "readsTables" }

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

/** An INSERT's ON CONFLICT: none, an action over conflict columns, DO NOTHING ON CONSTRAINT, or DO NOTHING with no
 * target, which every key and UNIQUE of the table arbitrates. */
type Conflict =
	| { readonly kind: "none" }
	| { readonly kind: "every" }
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
			/** Whether it proposes one of the statement's query CTEs alone, by its index among them, in place of `source`. */
			readonly proposes: number | undefined
			/** With no source query, whether its one VALUES row states every column by a placeholder, $1 to $3, or c_id by 1. */
			readonly params: boolean
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

/**
 * A statement's CTE: a query, a data-modifying statement, or a query CTE that holds an INSERT's met rows whole, MATERIALIZED,
 * as the insert protocol keeps them once (write/insert/protocol.ts classifyMet): the met rows of the `insert`-th writing
 * CTE over the `proposed`-th query CTE, each an index among the statement's CTEs of its kind.
 */
type CteSpec =
	| { readonly kind: "query"; readonly query: QuerySpec }
	| { readonly kind: "dml"; readonly dml: Dml }
	| { readonly kind: "held"; readonly insert: number; readonly proposed: number }

type StatementSpec =
	| { readonly kind: "dml"; readonly dml: Dml; readonly ctes: ReadonlyArray<CteSpec> }
	| { readonly kind: "select"; readonly query: QuerySpec; readonly ctes: ReadonlyArray<CteSpec> }
	| { readonly kind: "refresh" | "schema" }

/** A member's statements and the level they were compiled for, which a `met` source and an untargeted ON CONFLICT need. */
interface MemberCase {
	readonly level: Isolation
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

type SourceKind = "table" | "own" | "derived" | "fact" | "probe" | "metRows" | "met"

const derivedArm: Weighted<SourceKind> = [1, () => "derived"]

/**
 * A derived table over the context's fact, as a write's statements read a claim (the RC and SERIALIZABLE forms rename
 * and cast it through derived tables): one core over the context alone, or over such a derived table, `depth` deep at
 * most, filtering, counting and projecting nothing beyond its column; or one over the context and VALUES, whose rows
 * are many.
 */
const factGen =
	(depth: number): Gen<QuerySpec> =>
	(s) => {
		const context: Source = { kind: "own", own: "context", at: 0 }
		const stacked: ReadonlyArray<Weighted<Arr.NonEmptyReadonlyArray<Source>>> =
			depth > 0 ? [[2, (t) => [{ kind: "derived", query: t.draw(factGen(depth - 1)) }]]] : []
		const sources = s.draw(
			weighted<Arr.NonEmptyReadonlyArray<Source>>([
				[3, () => [context]],
				...stacked,
				[1, () => [context, { kind: "own", own: "values", at: 0 }]]
			])
		)
		return {
			cores: [
				{
					sources,
					filters: [],
					aggregate: { kind: "none" },
					projection: { kind: "plain" },
					nested: false
				}
			],
			op: "UNION"
		}
	}

/** A core's sources first, then each table's equalities over distinct columns of it. */
const coreGen =
	(depth: number): Gen<CoreSpec> =>
	(s) => {
		const shapes = nonEmpty(
			s.draw(
				array(
					weighted<SourceKind>([
						[4, () => "table"],
						[2, () => "own"],
						[1, () => "probe"],
						[1, () => "metRows"],
						[1, () => "met"],
						[1, () => "fact"],
						...(depth > 0 ? [derivedArm] : [])
					]),
					{ min: 1, max: 3 }
				)
			),
			"a core's sources"
		)
		const owns = Arr.filter(
			shapes,
			(k) => k === "own" || k === "derived" || k === "fact" || k === "metRows"
		).length
		const tables = Arr.filter(shapes, (k) => k === "table").length
		const sources = Arr.map(shapes, (kind, at): Source => {
			switch (kind) {
				case "table": {
					const self = Arr.filter(Arr.take(shapes, at), (k) => k === "table").length
					const columns = Arr.dedupe(s.draw(array(element(COLUMNS), { min: 0, max: 3 })))
					const form = s.draw(
						weighted<TableForm>([
							[4, () => "direct"],
							[2, () => "plain"],
							[1, () => "limited"],
							[2, () => "stacked"]
						])
					)
					const inner =
						form === "stacked"
							? Arr.map(
									Arr.dedupe(s.draw(array(element(COLUMNS), { min: 1, max: 2 }))),
									(column) => ({ column, slot: s.draw(int(1, 3)) })
								)
							: []
					return {
						kind: "table",
						rel: s.draw(element(RELS)),
						form,
						inner,
						equalities: Arr.map(columns, (column) => {
							const other = s.draw(otherGen(owns, tables, self))
							return {
								column,
								other:
									(form === "limited" || form === "stacked") && other.kind === "table"
										? { kind: "literal" }
										: other,
								flipped: s.draw(boolean),
								inJoin: s.draw(boolean)
							}
						})
					}
				}
				case "own":
					return { kind: "own", own: s.draw(element(OWN_KINDS)), at: s.draw(int(0, 2)) }
				case "derived":
					return { kind: "derived", query: s.draw(queryGen(depth - 1)) }
				case "fact":
					return { kind: "derived", query: s.draw(factGen(2)) }
				case "metRows":
					return { kind: "metRows", insert: s.draw(int(0, 1)), proposed: s.draw(int(0, 1)) }
				case "met":
					return {
						kind: "met",
						rel: s.draw(element(RELS)),
						rows: s.draw(int(0, 3)),
						columns: nonEmpty(
							Arr.dedupe(s.draw(array(element(COLUMNS), { min: 1, max: 2 }))),
							"the row met's key"
						)
					}
				case "probe":
					return {
						kind: "probe",
						rel: s.draw(element(RELS)),
						by: s.draw(element(["key", "group", "last"] as const)),
						equalities: nonEmpty(
							Arr.map(
								Arr.dedupe(s.draw(array(element(COLUMNS), { min: 1, max: 2 }))),
								(column) => ({
									column,
									other: s.draw(otherGen(owns, tables + 1, tables))
								})
							),
							"a probe's columns"
						)
					}
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
		[
			1,
			(s) => ({
				kind: "call",
				fn: s.draw(element(["noTable", "readsTables"] as const))
			})
		]
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
	[1, () => ({ kind: "constraint" })],
	[1, () => ({ kind: "every" })]
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
					[2, () => undefined]
				])
			),
			params: s.draw(boolean),
			proposes: s.draw(
				weighted<number | undefined>([
					[3, () => undefined],
					[2, (t) => t.draw(int(0, 1))]
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

/**
 * A statement shaped as the SERIALIZABLE insert protocol classifies its met rows, each condition of the row met's seal
 * drawn to hold or to fail: two query CTEs, an INSERT into a drawn relation that proposes one of them alone or reads a
 * drawn query, under DO NOTHING with no target or over a subset of the row met's key, DO SELECT or DO UPDATE over such
 * a subset, DO NOTHING over it and a column outside the key, ON CONSTRAINT or none, and a core reading that INSERT's
 * met rows, of either CTE, itself or through a CTE that holds them whole, beside the row met for
 * them in the INSERT's relation or another. It composes the spec pieces the other arms draw, so the generic oracle
 * judges it, and the pieces a seal needs meet in one case.
 */
const metStatementGen: Gen<StatementSpec> = (s) => {
	const rel = s.draw(element(RELS))
	const columns = nonEmpty(
		Arr.dedupe(s.draw(array(element(COLUMNS), { min: 1, max: 2 }))),
		"the row met's key"
	)
	const proposes = s.draw(int(0, 1))
	const within: Gen<Arr.NonEmptyReadonlyArray<Column>> = (t) =>
		nonEmpty(
			t.draw(subset(columns, { min: 1, max: columns.length })),
			"conflict columns of the key"
		)
	const outside = Arr.filter(COLUMNS, (c) => !columns.includes(c))
	const conflict = s.draw(
		weighted<Conflict>([
			[2, () => ({ kind: "every" })],
			[2, (t) => ({ kind: "columns", columns: t.draw(within), action: "doNothing" })],
			[
				1,
				(t) => ({
					kind: "columns",
					columns: t.draw(within),
					action: t.draw(element(["doSelect", "doUpdate"] as const))
				})
			],
			[
				1,
				(t) => ({
					kind: "columns",
					columns: Arr.appendAll(t.draw(within), Arr.take(outside, 1)),
					action: "doNothing"
				})
			],
			[1, (t) => t.draw(element([{ kind: "constraint" }, { kind: "none" }] as const))]
		])
	)
	const alone = s.draw(
		weighted<boolean>([
			[4, () => true],
			[1, () => false]
		])
	)
	const proposed = s.draw(
		weighted<number>([
			[3, () => proposes],
			[1, () => 1 - proposes]
		])
	)
	const held = s.draw(boolean)
	return {
		kind: "select",
		ctes: [
			{ kind: "query", query: s.draw(queryGen(1)) },
			{ kind: "query", query: s.draw(queryGen(1)) },
			{
				kind: "dml",
				dml: {
					kind: "insert",
					target: { kind: "table", rel },
					source: alone ? undefined : s.draw(queryGen(1)),
					params: false,
					proposes: alone ? proposes : undefined,
					conflict
				}
			},
			...(held ? [{ kind: "held", insert: 0, proposed } as const] : [])
		],
		query: {
			cores: [
				{
					sources: [
						held ? { kind: "own", own: "cte", at: 3 } : { kind: "metRows", insert: 0, proposed },
						{
							kind: "met",
							rel: s.draw(
								weighted<Rel>([
									[4, () => rel],
									[1, (t) => t.draw(element(RELS))]
								])
							),
							rows: 0,
							columns
						}
					],
					filters: [],
					aggregate: { kind: "none" },
					projection: { kind: "plain" },
					nested: false
				}
			],
			op: "UNION"
		}
	}
}

const statementGen: Gen<StatementSpec> = weighted<StatementSpec>([
	[
		6,
		(s) => ({ kind: "dml", dml: s.draw(dmlGen), ctes: s.draw(array(cteGen, { min: 0, max: 2 })) })
	],
	[1, metStatementGen],
	[
		2,
		(s) => ({
			kind: "select",
			query: s.draw(queryGen(2)),
			ctes: s.draw(array(cteGen, { min: 0, max: 2 }))
		})
	],
	[1, (s) => ({ kind: s.draw(element(["refresh", "schema"] as const)) })]
])

export const caseGen: Gen<MemberCase> = (s) => ({
	level: s.draw(element(["readCommitted", "serializable"] as const)),
	statements: nonEmpty(s.draw(array(statementGen, { min: 1, max: 3 })), "a member's statements")
})

/** The column every own and derived source delivers, which an IN and an aggregate read. */
const OWN_COLUMN = "v"

/**
 * The CTEs a statement's sources may name, by name, beside its WITH: a query CTE, read where it is named, and a writing
 * CTE, whose RETURNING rows are the call's own. A CTE's body and a writing CTE's source name none, so no CTE reads
 * another and none is read before it is defined.
 */
type Env = ReadonlyArray<
	| {
			readonly kind: "query"
			readonly name: string
			readonly path: string
			readonly query: QuerySpec
	  }
	| { readonly kind: "returning"; readonly name: string }
	| ({ readonly kind: "held"; readonly name: string; readonly path: string } & HeldRows)
>

/** The met rows a held CTE keeps: its INSERT's writing CTE, and the query CTE that INSERT proposes, by name and path. */
interface HeldRows {
	readonly insert: string
	readonly proposed: string
	readonly proposedPath: string
	readonly query: QuerySpec
}

/** A source as its core places it: under its alias, an own CTE source resolved to the CTE it names, or VALUES where the
 * statement defines none. */
type PlacedSource =
	| {
			readonly kind: "table"
			readonly alias: string
			readonly rel: Rel
			readonly form: TableForm
			readonly equalities: ReadonlyArray<Equality>
			readonly inner: ReadonlyArray<{ readonly column: Column; readonly slot: number }>
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
			readonly own: "arrays" | "values" | "function" | "context"
	  }
	| { readonly kind: "returning"; readonly alias: string; readonly name: string }
	| ({
			readonly kind: "held"
			readonly alias: string
			readonly name: string
			readonly path: string
	  } & HeldRows)
	| { readonly kind: "derived"; readonly alias: string; readonly query: QuerySpec }
	| {
			readonly kind: "probe"
			readonly alias: string
			readonly rel: Rel
			readonly by: "key" | "group" | "last"
			readonly equalities: Arr.NonEmptyReadonlyArray<{
				readonly column: Column
				readonly other: Other
			}>
	  }
	| {
			readonly kind: "metRows"
			readonly alias: string
			readonly insert: string
			readonly proposed: string
			readonly path: string
			readonly query: QuerySpec
	  }
	| {
			readonly kind: "met"
			readonly alias: string
			readonly rel: Rel
			readonly rows: number
			readonly columns: Arr.NonEmptyReadonlyArray<Column>
	  }

/**
 * Whether a derived table's query is one row of values the call holds once: one core over the context's fact or such
 * derived tables alone, filtering, counting and projecting nothing beyond the column it delivers, a column of its first
 * source (firstColumn).
 */
const oneRow = (q: QuerySpec): boolean => {
	const [only, ...more] = q.cores
	return (
		more.length === 0 &&
		only.filters.length === 0 &&
		only.aggregate.kind === "none" &&
		only.projection.kind === "plain" &&
		Arr.every(
			only.sources,
			(s) => (s.kind === "own" && s.own === "context") || (s.kind === "derived" && oneRow(s.query))
		)
	)
}

/** Whether a derived table's query reads the context's fact as factGen draws it, through any number of such. */
const factOver = (q: QuerySpec): boolean =>
	Arr.some(
		q.cores,
		(c) =>
			c.filters.length === 0 &&
			Arr.some(
				c.sources,
				(s) =>
					(s.kind === "own" && s.own === "context") || (s.kind === "derived" && factOver(s.query))
			)
	)

/** A core's sources under their aliases, each named by the core's path, so the statement and the oracle agree. */
const placed = (c: CoreSpec, path: string, env: Env): Arr.NonEmptyReadonlyArray<PlacedSource> =>
	Arr.map(c.sources, (s, i): PlacedSource => {
		const alias = `${path}s${i}`
		switch (s.kind) {
			case "table":
				return {
					kind: "table",
					alias,
					rel: s.rel,
					form: s.form,
					equalities: s.equalities,
					inner: s.inner
				}
			case "derived":
				return { kind: "derived", alias, query: s.query }
			case "probe":
				return { kind: "probe", alias, rel: s.rel, by: s.by, equalities: s.equalities }
			case "met":
				return { kind: "met", alias, rel: s.rel, rows: s.rows, columns: s.columns }
			case "metRows": {
				const writes = Arr.flatMap(env, (e) => (e.kind === "returning" ? [e.name] : []))
				const queries = Arr.flatMap(env, (e) => (e.kind === "query" ? [e] : []))
				const insert = writes[s.insert % Math.max(writes.length, 1)]
				const proposed = queries[s.proposed % Math.max(queries.length, 1)]
				return insert === undefined || proposed === undefined
					? { kind: "plain", alias, own: "values" }
					: {
							kind: "metRows",
							alias,
							insert,
							proposed: proposed.name,
							path: proposed.path,
							query: proposed.query
						}
			}
			case "own":
				switch (s.own) {
					case "carrier":
						return { kind: "carrier", alias, carrier: s.at + 1 }
					case "cte": {
						const named = env[s.at % Math.max(env.length, 1)]
						if (named === undefined) {
							return { kind: "plain", alias, own: "values" }
						}
						switch (named.kind) {
							case "returning":
								return { kind: "returning", alias, name: named.name }
							case "held":
								return { ...named, alias }
							case "query":
								return {
									kind: "cte",
									alias,
									name: named.name,
									path: named.path,
									query: named.query
								}
						}
					}
					case "arrays":
					case "values":
					case "function":
					case "context":
						return { kind: "plain", alias, own: s.own }
				}
		}
	})

/** The own sources' aliases of a core, in source order: what an own equality's index names. */
const ownAliases = (sources: ReadonlyArray<PlacedSource>): ReadonlyArray<string> =>
	Arr.flatMap(sources, (s) =>
		s.kind === "table" || s.kind === "probe" || s.kind === "met" ? [] : [s.alias]
	)

/** The met rows a `met` source names: the own source the core sees at its index, its own first; none where it sees none. */
const metRowsAlias = (
	p: Extract<PlacedSource, { readonly kind: "met" }>,
	owned: ReadonlyArray<string>,
	scope: ReadonlyArray<string>
): string | undefined => {
	const seen = [...owned, ...scope]
	return seen[p.rows % Math.max(seen.length, 1)]
}

/** The name a `met` source reads its met rows by where it sees no own source: a name nothing in scope defines. */
const NO_ROWS = "nowhere"

/** An equality's other side as its core reads it, an enclosing core's own source resolved in `scope`. */
type ResolvedOther =
	| { readonly kind: "param"; readonly slot: number }
	| { readonly kind: "own"; readonly alias: string }
	| { readonly kind: "table"; readonly alias: string }
	| { readonly kind: "limited"; readonly alias: string }
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
		case "limited":
			return col(o.alias, "c_b")
		case "literal":
			return lit.int(3, types.integer)
		case "cast":
			return cast(param(o.slot, types.integer), types.bigint)
	}
}

/** The declared parameters the drawn placeholders carry: $1 and $3 one, $2 another, every other its own, p<n>. */
const PARAM_NAMES: ReadonlyMap<number, string> = new Map([
	[1, "a"],
	[2, "b"],
	[3, "a"]
])

/** What fills each drawn placeholder: a declared scalar parameter, by its name (PARAM_NAMES). */
export const slotFill = (n: number): SlotFill => ({
	kind: "param",
	name: PARAM_NAMES.get(n) ?? `p${n}`
})

const paramText = (slot: number): string => `:${PARAM_NAMES.get(slot) ?? `p${slot}`}`

/** The text the context's one claim binds by (facts.ts bindingText): the Session context's field sub. */
const CONTEXT_TEXT = bindingText({ kind: "context", context: "Session", field: "sub" })

/** The text a binding names a resolved other side by, none for one that binds nothing. */
const otherText = (o: ResolvedOther): string | undefined => {
	switch (o.kind) {
		case "param":
			return paramText(o.slot)
		case "own":
			return `${o.alias}.${OWN_COLUMN}`
		case "limited":
			return `${o.alias}.c_b`
		case "table":
		case "literal":
		case "cast":
			return undefined
	}
}

/** The first column a core's first source delivers: a table's c_a, any other's v. */
const firstColumn = (sources: Arr.NonEmptyReadonlyArray<PlacedSource>): Expr => {
	const [first] = sources
	return col(first.alias, first.kind === "table" ? "c_a" : OWN_COLUMN)
}

/**
 * The value a stacked form's column holds for the call in every row: its WHERE's first equality of the middle
 * projection's column it reads (each output column c is the middle's ROTATED[c]) with a placeholder, none where none.
 */
const stackedFixed = (
	inner: ReadonlyArray<{ readonly column: Column; readonly slot: number }>,
	column: Column
): string | undefined =>
	Arr.findFirst(inner, (e) => e.column === ROTATED[column]).pipe(
		Option.map((at) => paramText(at.slot)),
		Option.getOrUndefined
	)

/** One side of a drawn equality as the closure reads it: a column by its source's alias and name, a placeholder's
 * value, or a literal, which is neither. */
type Side =
	| { readonly kind: "column"; readonly alias: string; readonly column: string }
	| { readonly kind: "value"; readonly text: string }
	| { readonly kind: "literal" }

/**
 * The value a drawn query's OWN_COLUMN holds for the call in every row it yields, by its text (the extractor's
 * Statement.fixedColumns restated over the shape): a core's target that is a column, which only a GROUP BY core
 * projects (aggregateParts), holding one itself, a fixed or one-row own source's, or equated with one through any chain
 * of its WHERE's and its inner joins' equalities, the WHERE's first in their order, each placeholder anchoring before a
 * column does; a set operation of several cores only where it is a UNION and every core fixes the same.
 */
const fixedOfQuery = (
	q: QuerySpec,
	path: string,
	scope: ReadonlyArray<string>,
	env: Env
): string | undefined => {
	const texts = Arr.map(q.cores, (c, k) => fixedOfCore(c, `${path}c${k}`, scope, env))
	const [first, ...rest] = texts
	if (rest.length === 0) {
		return first
	}
	return q.op === "UNION" && first !== undefined && Arr.every(rest, (t) => t === first)
		? first
		: undefined
}

const fixedOfCore = (
	c: CoreSpec,
	path: string,
	scope: ReadonlyArray<string>,
	env: Env
): string | undefined => {
	if (c.aggregate.kind !== "groupBy") {
		return undefined
	}
	const sources = placed(c, path, env)
	const owns = ownAliases(sources)
	const tables = Arr.flatMap(sources, (t) => (t.kind === "table" ? [t.alias] : []))
	/** What a column of one of the core's sources holds for the call in every row, where it holds one. */
	const heldAt = (alias: string, column: string): string | undefined => {
		const source = Arr.findFirst(sources, (t) => t.alias === alias).pipe(Option.getOrUndefined)
		if (source === undefined) {
			return undefined
		}
		switch (source.kind) {
			case "table":
				return source.form === "stacked" && Arr.contains(COLUMNS, column)
					? stackedFixed(
							source.inner,
							Arr.findFirst(COLUMNS, (cn) => cn === column).pipe(Option.getOrThrow)
						)
					: undefined
			case "derived":
				return column === OWN_COLUMN
					? (fixedOfQuery(source.query, `${alias}q`, scope, env) ??
							(oneRow(source.query) ? `${alias}.${OWN_COLUMN}` : undefined))
					: undefined
			case "cte":
				return column === OWN_COLUMN ? fixedOfQuery(source.query, source.path, [], []) : undefined
			case "plain":
				return source.own === "context" && column === OWN_COLUMN ? CONTEXT_TEXT : undefined
			case "carrier":
			case "held":
			case "met":
			case "metRows":
			case "probe":
			case "returning":
				return undefined
		}
	}
	const sideOf = (o: ResolvedOther): Side => {
		switch (o.kind) {
			case "param":
			case "cast":
				return { kind: "value", text: paramText(o.slot) }
			case "own":
				return { kind: "column", alias: o.alias, column: OWN_COLUMN }
			case "table":
			case "limited":
				return { kind: "column", alias: o.alias, column: "c_b" }
			case "literal":
				return { kind: "literal" }
		}
	}
	const where: Array<readonly [Side, Side]> = []
	const ons: Array<Array<readonly [Side, Side]>> = Arr.map(sources, () => [])
	const placedTables = Arr.flatMap(sources, (t) => (t.kind === "table" ? [t] : []))
	Arr.forEach(placedTables, (t, k) => {
		for (const e of t.equalities) {
			const mine: Side = { kind: "column", alias: t.alias, column: e.column }
			const other = sideOf(resolveOther(e.other, owns, tables, scope))
			const pair = e.flipped ? ([other, mine] as const) : ([mine, other] as const)
			if (sources.length > 1 && e.inJoin) {
				Arr.getUnsafe(ons, 1 + (k % (sources.length - 1))).push(pair)
			} else {
				where.push(pair)
			}
		}
	})
	const textOf = (side: Side): string | undefined =>
		side.kind === "value"
			? side.text
			: side.kind === "column"
				? heldAt(side.alias, side.column)
				: undefined
	const anchorOf = equalityClosure(
		[...where, ...Arr.flatten(ons)],
		(side) => (side.kind === "column" ? `${side.alias}|${side.column}` : undefined),
		(side) => textOf(side) !== undefined
	)
	const [first] = sources
	const target: Side = {
		kind: "column",
		alias: first.alias,
		column: first.kind === "table" ? "c_a" : OWN_COLUMN
	}
	const direct = textOf(target)
	if (direct !== undefined) {
		return direct
	}
	const anchor = anchorOf(`${target.alias}|${target.column}`)
	return anchor === undefined ? undefined : textOf(anchor)
}

/** A derived table's query over a table: every column of it, in the rotation's order, and a LIMIT where limited. */
const projectionOf = (
	rel: Rel,
	inner: string,
	form: Exclude<TableForm, "direct">
): OperandSelect => {
	const q = operandSelect(
		core(
			Arr.map(COLUMNS, (c) => targetAs(col(inner, ROTATED[c]), c)),
			[{ kind: "table", table: TABLES[rel], alias: inner }],
			undefined
		)
	)
	return form === "plain" ? q : { ...q, limit: lit.int(1, types.integer) }
}

/** A stacked form's query: a projection of the table renamed again, under its WHERE's equalities. */
const stackedOf = (
	rel: Rel,
	alias: string,
	inner: ReadonlyArray<{ readonly column: Column; readonly slot: number }>
): OperandSelect => {
	const middle = `${alias}m`
	const [first, ...rest] = Arr.map(inner, (e) =>
		eq(col(middle, e.column), param(e.slot, types.integer))
	)
	return operandSelect(
		core(
			Arr.map(COLUMNS, (c) => targetAs(col(middle, ROTATED[c]), c)),
			[derived(projectionOf(rel, `${alias}t`, "plain"), middle, COLUMNS, false)],
			first === undefined ? undefined : and([first, ...rest])
		)
	)
}

/** The met rows of the INSERT of writing CTE `insert` over query CTE `proposed`, under `alias`, keyed by OWN_COLUMN. */
const metRowsSource = (alias: string, insert: string, proposed: string): FromSource => ({
	kind: "metRows",
	insert,
	proposed,
	key: [{ column: OWN_COLUMN, from: OWN_COLUMN, schema: undefined }],
	columns: [{ column: OWN_COLUMN, returned: OWN_COLUMN }],
	scan: `${alias}m`,
	returned: `${alias}r`,
	sides: `${alias}s`,
	marker: `${alias}k`,
	marked: `${alias}w`,
	hit: `${alias}h`,
	alias
})

/** The FROM source of a placed source. */
const fromSource = (
	p: PlacedSource,
	scope: ReadonlyArray<string>,
	env: Env,
	valueOf: (o: Other) => Expr,
	owned: ReadonlyArray<string>
): FromSource => {
	switch (p.kind) {
		case "probe": {
			const columns = Arr.map(p.equalities, (e) => ({
				column: e.column,
				value: valueOf(e.other),
				schema: undefined
			}))
			return {
				kind: "probe",
				table: TABLES[p.rel],
				inner: `${p.alias}i`,
				by: p.by === "key" ? { kind: "key", columns } : { kind: p.by, columns, order: ["c_id"] },
				filter: [],
				columns: DRIVEN,
				alias: p.alias
			}
		}
		case "met":
			return {
				kind: "met",
				table: TABLES[p.rel],
				inner: `${p.alias}i`,
				rows: metRowsAlias(p, owned, scope) ?? NO_ROWS,
				key: Arr.map(p.columns, (column) => ({ column, from: OWN_COLUMN, schema: undefined })),
				filter: [],
				columns: DRIVEN,
				alias: p.alias
			}
		case "metRows":
			return metRowsSource(p.alias, p.insert, p.proposed)
		case "table":
			switch (p.form) {
				case "direct":
					return { kind: "table", table: TABLES[p.rel], alias: p.alias }
				case "plain":
				case "limited":
					return derived(projectionOf(p.rel, `${p.alias}t`, p.form), p.alias, COLUMNS, false)
				case "stacked":
					return derived(stackedOf(p.rel, p.alias, p.inner), p.alias, COLUMNS, false)
			}
		case "carrier":
			return { kind: "table", table: unitCarrierName(p.carrier), alias: p.alias }
		case "cte":
		case "returning":
		case "held":
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
									array: positionalValue(1),
									check: baseCheck
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
						lateral: false,
						ordinality: false
					}
				case "context":
					return {
						kind: "context",
						context: "Session",
						columns: [
							{
								field: "sub",
								column: columnDefinition(OWN_COLUMN, types.integer),
								judged: types.integer
							}
						],
						refusal: { kind: "qualified", schema: "app", name: NO_TABLE },
						alias: p.alias
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
			return qualifiedCall("app", f.fn === "noTable" ? NO_TABLE : READS_TABLES, [column])
	}
}

/** A core's table source, as placed. */
type PlacedTable = Extract<PlacedSource, { readonly kind: "table" }>

/**
 * Where each of a core's tables' equalities stands, each with its table, in their order: in its WHERE (`on` none), or
 * in the ON of its join chain's source `on`, where it joins several sources and the equality is drawn there.
 */
interface EqualityPlace {
	readonly table: PlacedTable
	readonly e: Equality
	readonly on: number | undefined
}

const equalityPlaces = (
	sources: Arr.NonEmptyReadonlyArray<PlacedSource>
): ReadonlyArray<EqualityPlace> => {
	const tables = Arr.flatMap(sources, (s): ReadonlyArray<PlacedTable> =>
		s.kind === "table" ? [s] : []
	)
	return Arr.flatMap(tables, (table, k) =>
		Arr.map(table.equalities, (e): EqualityPlace => ({
			table,
			e,
			on: sources.length > 1 && e.inJoin ? 1 + (k % (sources.length - 1)) : undefined
		}))
	)
}

/** A core's tables' equalities in the order the extractor reads its conditions (Walk #core): its WHERE's, then each
 * ON's in its join chain's order. */
const conditionOrder = (
	sources: Arr.NonEmptyReadonlyArray<PlacedSource>
): ReadonlyArray<{ readonly table: PlacedTable; readonly e: Equality }> => {
	const places = equalityPlaces(sources)
	return [
		...Arr.filter(places, (p) => p.on === undefined),
		...Arr.flatMap(
			Array.from({ length: sources.length }, (_, i) => i),
			(i) => Arr.filter(places, (p) => p.on === i)
		)
	]
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
	for (const { table, e, on } of equalityPlaces(sources)) {
		const mine = col(table.alias, e.column)
		const other = otherExpr(resolveOther(e.other, owns, tables, scope))
		const conjunct = e.flipped ? eq(other, mine) : eq(mine, other)
		if (on === undefined) {
			where.push(conjunct)
		} else {
			Arr.getUnsafe(ons, on).push(conjunct)
		}
	}
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
	const owned = ownAliases(sources)
	const tabled = Arr.flatMap(sources, (t) => (t.kind === "table" ? [t.alias] : []))
	const from = Arr.map(sources, (p) =>
		fromSource(p, scope, env, (o) => otherExpr(resolveOther(o, owned, tabled, scope)), owned)
	)
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

const tableOf = (t: TargetSpec): TableName =>
	t.kind === "table" ? TABLES[t.rel] : unitCarrierName(9)

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
						? {
								kind: "update",
								set: assignments(ungenerated, "t", [{ column: "c_b", value: one }])
							}
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
						? { kind: "insert", row: [{ column: "c_id", value: one }] }
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
	env: Env,
	statement: Env
): Insert | Update | Delete | Merge => {
	switch (d.kind) {
		case "insert": {
			const conflict = d.conflict
			const proposal = proposalOf(d, statement)
			return {
				kind: "insert",
				with: outer,
				table: tableOf(d.target),
				alias: undefined,
				onConflict:
					conflict.kind === "none"
						? undefined
						: conflict.kind === "constraint"
							? { kind: "constraint", constraint: "w_pk", action: { kind: "doNothing" } }
							: conflict.kind === "every"
								? { kind: "every", action: { kind: "doNothing" } }
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
															set: assignments(ungenerated, "t", [{ column: "c_a", value: one }]),
															where: undefined
														}
									},
				returning: [],
				...(proposal !== undefined
					? {
							columns: ["c_id"],
							source: {
								kind: "query",
								query: buildSelect(proposal.query, `${path}i`, [], [proposal.cte])
							}
						}
					: d.source === undefined
						? d.params
							? {
									columns: COLUMNS,
									source: {
										kind: "values",
										rows: [
											[
												param(1, types.integer),
												param(2, types.integer),
												param(3, types.integer),
												one
											]
										]
									}
								}
							: { columns: ["c_id"], source: { kind: "values", rows: [[one]] } }
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
				set: assignments(ungenerated, "t", [{ column: "c_a", value: one }]),
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
				using: derived(buildOperand(d.using, `${path}m`, [], env), `${path}m`, [OWN_COLUMN], false),
				on: eq(col("t", "c_id"), col(`${path}m`, OWN_COLUMN)),
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

/**
 * The query CTE an INSERT proposes alone, by its index among the statement's query CTEs (Dml `proposes`), with the query
 * of one plain core over it alone that its source is, a CTE source the env holds at 0; none where it proposes none or
 * the statement defines no query CTE.
 */
const proposalOf = (
	d: Extract<Dml, { readonly kind: "insert" }>,
	statement: Env
): { readonly cte: Env[number]; readonly query: QuerySpec } | undefined => {
	const queries = Arr.filter(statement, (e) => e.kind === "query")
	const cte =
		d.proposes === undefined ? undefined : queries[d.proposes % Math.max(queries.length, 1)]
	return cte === undefined
		? undefined
		: {
				cte,
				query: {
					cores: [
						{
							sources: [{ kind: "own", own: "cte", at: 0 }],
							filters: [],
							aggregate: { kind: "none" },
							projection: { kind: "plain" },
							nested: false
						}
					],
					op: "UNION"
				}
			}
}

/**
 * A statement's CTEs as its sources may name them: none where it defines none. A held CTE names its writing CTE and its
 * query CTE by their places among those of their kind, VALUES-like nothing where the statement defines no such pair.
 */
const envOf = (ctes: ReadonlyArray<CteSpec>): Env => {
	const queries = Arr.flatMap(ctes, (c, i) =>
		c.kind === "query" ? [{ name: `c${i}`, path: `c${i}q`, query: c.query }] : []
	)
	const writes = Arr.flatMap(ctes, (c, i) => (c.kind === "dml" ? [`c${i}`] : []))
	return Arr.flatMap(ctes, (c, i): Env => {
		switch (c.kind) {
			case "query":
				return [{ kind: "query", name: `c${i}`, path: `c${i}q`, query: c.query }]
			case "dml":
				return [{ kind: "returning", name: `c${i}` }]
			case "held": {
				const insert = writes[c.insert % Math.max(writes.length, 1)]
				const proposed = queries[c.proposed % Math.max(queries.length, 1)]
				return insert === undefined || proposed === undefined
					? []
					: [
							{
								kind: "held",
								name: `c${i}`,
								path: `c${i}q`,
								insert,
								proposed: proposed.name,
								proposedPath: proposed.path,
								query: proposed.query
							}
						]
			}
		}
	})
}

export const buildStatement = (s: StatementSpec): SqlStatement => {
	switch (s.kind) {
		case "refresh":
			return { kind: "refresh", view: objectName("app", "v"), concurrently: false }
		case "schema":
			return { kind: "createSchema", name: "app" }
		case "select":
		case "dml": {
			const env = envOf(s.ctes)
			const ctes = Arr.flatMap(s.ctes, (c, i): ReadonlyArray<Cte> => {
				const name = `c${i}`
				switch (c.kind) {
					case "query":
						return [
							{
								name,
								columns: [],
								materialized: undefined,
								query: buildOperand(c.query, `${name}q`, [], [])
							}
						]
					case "dml":
						return [
							{
								name,
								columns: [],
								materialized: undefined,
								query: buildDml(c.dml, name, undefined, [], env)
							}
						]
					case "held": {
						const held = Arr.findFirst(env, (e) => e.name === name).pipe(Option.getOrUndefined)
						return held?.kind === "held"
							? [
									{
										name,
										columns: [OWN_COLUMN],
										materialized: "MATERIALIZED",
										query: operandSelect(
											core(
												[targetAs(col(`${name}x`, OWN_COLUMN), OWN_COLUMN)],
												[metRowsSource(`${name}x`, held.insert, held.proposed)],
												undefined
											)
										)
									}
								]
							: []
					}
				}
			})
			const outer: With | undefined = Arr.isReadonlyArrayNonEmpty(ctes)
				? { recursive: false, ctes }
				: undefined
			return s.kind === "select"
				? { ...buildSelect(s.query, "q", [], env), with: outer }
				: buildDml(s.dml, "", outer, env, env)
		}
	}
}

type Mode = "positive" | "negated" | "counted" | "arbiter"

type Polarity = "positive" | "negated" | "both"

/** A read as the oracle expects it, ReadFact's fields, and the writes its rows feed. */
export interface Expected {
	readonly relation: string
	readonly mode: Mode
	readonly own: boolean
	readonly group: ReadonlyArray<string> | undefined
	readonly binding: string | undefined
	readonly rows: "one" | "many" | undefined
}

/**
 * A fact as the comparison reads it, among the reads of its body (`body`): its group's fields, what they are bound to
 * in their order, a stored row's field by the relation of the read that finds it, and how many groups the call's own
 * bindings read (certify.ts callGroup), side by side.
 */
export const expectedOf = (r: ReadFact, body: ReadonlyArray<ReadFact>): Expected => ({
	relation: r.relation,
	mode: r.mode,
	own: r.own,
	group: r.group === undefined ? undefined : Arr.map(r.group.bound, (b) => b.field),
	binding:
		r.group === undefined
			? undefined
			: Arr.join(
					Arr.map(r.group.bound, ({ by }) =>
						by.kind === "stored"
							? `stored ${Arr.getUnsafe(body, by.read).relation}.${by.field}`
							: bindingText(by)
					),
					","
				),
	rows: callGroup(r)?.rows
})

/** How many groups a read's bindings but stored rows' read (certify.ts CallGroup `rows`), none where it binds none. */
const callRows = (
	bound: ReadonlyArray<{ readonly rows: "one" | "many" | "stored" }>
): "one" | "many" | undefined => {
	const call = Arr.filter(bound, (b) => b.rows !== "stored")
	return Arr.isReadonlyArrayNonEmpty(call)
		? Arr.every(call, (b) => b.rows === "one")
			? "one"
			: "many"
		: undefined
}

/** Where a read stands: its polarity, whether a count stands over it, whether it is a probe's, the writes its rows
 * feed, the own sources' aliases it sees, the probes above it, and the innermost core it stands in. */
interface Place {
	readonly polarity: Polarity
	readonly counted: boolean
	readonly probe: boolean
	readonly feeds: ReadonlyArray<number>
	readonly scope: ReadonlyArray<string>
	readonly probes: ReadonlyArray<number>
	readonly core: number | undefined
}

const topPlace: Place = {
	polarity: "positive",
	counted: false,
	probe: false,
	feeds: [],
	scope: [],
	probes: [],
	core: undefined
}

const flip = (p: Polarity): Polarity =>
	p === "positive" ? "negated" : p === "negated" ? "positive" : "both"

/** What the oracle saw of a case, the shapes a coverage requirement names. */
export type Shape =
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
	| "a projection keyed by the conditions of the core that reads it"
	| "a projection outside conditions do not key"
	| "an ON CONFLICT bound by the parameters its row carries"
	| "a group keyed through two derived tables"
	| "a grouped count judged by its own rows"
	| "an ungrouped count judged by the core its value lands in"
	| "a probed core reading a one-core derived table or CTE"
	| "a probed core reading a UNION"
	| "a probed core reading an INTERSECT or an EXCEPT"
	| "a probed core reading an aggregate with no GROUP BY"
	| "a probed core reading a probe"
	| "an ON CONFLICT with no target, arbitrating every key and UNIQUE"
	| "a probe at a key"
	| "a probe at a group"
	| "the row an arbitration met"
	| "the row an arbitration met, refused at READ COMMITTED"
	| "an ON CONFLICT with no target, refused at READ COMMITTED"
	| "a writing CTE's RETURNING read as the call's own rows"
	| "the row met through no met rows, read by its place"
	| "the row met through met rows of no INSERT proposing them alone with DO NOTHING over its key, read by its place"
	| "an INSERT's met rows"
	| "an INSERT proposing a query CTE alone"
	| "a probe at a group's last row"
	| "a group bound by the context's fact"
	| "a group bound by a column its own source's query fixes"
	| "a group bound by the row another table's read finds"
	| "an ON CONFLICT bound by the value its source query fixes"
	| "a CTE that holds an INSERT's met rows whole"
	| "the row an arbitration met, through a CTE that holds its met rows whole"
	| "a group bound by a derived table of the context's fact, one value"
	| "a group bound by a derived table of the context's fact and VALUES, one per row"

/** A column of a table read with what its conditions equate it with. */
interface Bound {
	readonly column: Column
	readonly other: ModelOther
}

/**
 * The other side of an equality as the model reads it: a resolved other side, or a column of another table of the
 * core (`incoming`), the side an equality that other table states reads this one by: its column `column`.
 */
type ModelOther =
	| ResolvedOther
	| { readonly kind: "incoming"; readonly alias: string; readonly column: Column }

/** What a side binds a column equal to it to: a value the call holds or its own rows carry (`call`), or the field of the
 * row another table's read finds (`stored`), its text none where that column is no field or its relation none. */
type Binds =
	| { readonly kind: "call"; readonly text: string; readonly rows: "one" | "many" }
	| { readonly kind: "stored"; readonly text: string | undefined }

/** Whether an aggregate makes its core count: every kind but none, a window call's among them. */
const counts = (a: Aggregate): boolean => a.kind !== "none"

/**
 * A row source of a core as the oracle states it (StatementFacts.cores): a read by its key and the probes above it, a
 * core by its number, or a UNION's arms.
 */
type Rows =
	| { readonly kind: "read"; readonly key: string; readonly probes: ReadonlyArray<number> }
	| { readonly kind: "core"; readonly core: number }
	| { readonly kind: "union"; readonly arms: ReadonlyArray<ReadonlyArray<Rows>> }

/** One statement's expected facts, built by restating the contract over its spec. */
class Expect {
	readonly reads: Array<Expected & { readonly feeds: ReadonlyArray<number> }> = []
	readonly tail: Array<Expected> = []
	readonly writes: Array<{
		readonly relation: string
		readonly op: "insert" | "update" | "delete"
	}> = []
	readonly shapes = new Set<Shape>()
	/** Every query CTE a source reads, by its path. */
	readonly ctes = new Set<string>()
	readonly written: ReadonlySet<string>
	readonly inserts: ReadonlyMap<string, WritingInsert>
	readonly level: Isolation
	/** Every met rows source placed so far, and every source of a held CTE, by its alias, which a `met` source names. */
	readonly metRows = new Map<string, { readonly insert: string; readonly proposed: string }>()
	/** Every source of a held CTE placed so far, by its alias. */
	readonly held = new Set<string>()
	/** Every own source placed so far that is one row of values the call holds once (oneRow), by its alias. */
	readonly oneRows = new Set<string>()
	/** Every own source placed so far whose query fixes its column (fixedOfQuery), with that value's text, by its alias. */
	readonly fixedOwn = new Map<string, string>()
	/** Every stacked table placed so far whose WHERE fixes the column an equality reads it by, c_b (stackedFixed), with
	 * that value's text, by its alias. */
	readonly fixedStacked = new Map<string, string>()

	/** Every context's fact placed so far, by its alias, whose one column binds by the context's claim (CONTEXT_TEXT). */
	readonly contexts = new Set<string>()
	/** Every direct or renaming table placed so far, by its alias, with its relation and form. */
	readonly tablesAt = new Map<string, { readonly rel: Rel; readonly form: "direct" | "plain" }>()

	/** The text a column of a direct or renaming table binds a column equal to it by: that field of the row its read
	 * finds, `stored <relation>.<field>`, a renaming's column its table's ROTATED one; none where it is no field or its
	 * relation none. */
	storedText(alias: string, column: Column): string | undefined {
		const at = this.tablesAt.get(alias)
		const field =
			at === undefined || at.rel === "X"
				? undefined
				: FIELDS.get(at.form === "plain" ? ROTATED[column] : column)
		return at === undefined || field === undefined
			? undefined
			: `stored ${relationOf(at.rel)}.${field}`
	}

	/** What a side binds a column equal to it to (Binds), none for one that binds nothing (otherText): a fixed own
	 * column's or stacked column's value once (fixedOwn, fixedStacked), the context's claim, another table's column. */
	bound(o: ModelOther): Binds | undefined {
		if (o.kind === "table") {
			return { kind: "stored", text: this.storedText(o.alias, "c_b") }
		}
		if (o.kind === "incoming") {
			return { kind: "stored", text: this.storedText(o.alias, o.column) }
		}
		const fixed =
			o.kind === "own"
				? (this.fixedOwn.get(o.alias) ?? (this.contexts.has(o.alias) ? CONTEXT_TEXT : undefined))
				: o.kind === "limited"
					? this.fixedStacked.get(o.alias)
					: undefined
		if (fixed !== undefined) {
			return { kind: "call", text: fixed, rows: "one" }
		}
		const text = otherText(o)
		if (text === undefined) {
			return undefined
		}
		return {
			kind: "call",
			text,
			rows: o.kind === "param" || (o.kind === "own" && this.oneRows.has(o.alias)) ? "one" : "many"
		}
	}
	/** Each read's key with its base mode and the count of probes above it, and each probe's gated writes. */
	readonly based: Array<string> = []
	readonly probes: Array<{
		readonly gates: ReadonlyArray<number>
		readonly core: number | undefined
		readonly chain: ReadonlyArray<number>
	}> = []
	/** Each core's row sources, by number, as the comparison renders them. */
	readonly cores: Array<ReadonlyArray<Rows>> = []

	constructor(
		written: ReadonlySet<string>,
		inserts: ReadonlyMap<string, WritingInsert>,
		level: Isolation
	) {
		this.written = written
		this.inserts = inserts
		this.level = level
	}

	/** The place `next`, entered from `place`: where it flips the polarity or starts a count, a probe of its own. */
	enter(place: Place, next: Place): Place {
		return this.opening(place, next, undefined)
	}

	/** `enter`, a grouped core's probe judged by that core's own rows (`own`), any other by the core it stands in. */
	opening(place: Place, next: Place, own: number | undefined): Place {
		if (next.polarity === place.polarity && (place.counted || !next.counted)) {
			return next
		}
		const id = this.probes.length
		this.probes.push(
			own === undefined
				? { gates: place.feeds, core: place.core, chain: place.probes }
				: { gates: place.feeds, core: own, chain: [...place.probes, id] }
		)
		return { ...next, probes: [...place.probes, id] }
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

	read(fact: Expected, feeds: ReadonlyArray<number>, place: Place): Rows {
		this.reads.push({ ...fact, feeds })
		const base: Mode = Arr.some(
			["?function:", "?refresh:", "?statement:", "?met:", "?every:"],
			(prefix) => Str.startsWith(prefix)(fact.relation)
		)
			? "negated"
			: fact.mode === "arbiter"
				? "arbiter"
				: "positive"
		this.based.push(`${readKey(fact)}|${base}|${place.probes.length}`)
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
		return { kind: "read", key: readKey(fact), probes: place.probes }
	}

	/**
	 * A table read under its conditions' bindings: each field bound by a placeholder or an own column, else by another
	 * table's column, the first such equality of each column, sorted; an arbitration wherever it stands where it reads
	 * the row its statement's arbitration met (`met`).
	 */
	table(rel: Rel, place: Place, all: ReadonlyArray<Bound>, met: boolean): Rows {
		const relation = relationOf(rel)
		if (rel === "X") {
			this.shapes.add("a read no relation names")
		}
		const bound = Arr.dedupeWith(
			[
				...Arr.filter(all, (b) => this.bound(b.other)?.kind === "call"),
				...Arr.filter(all, (b) => this.bound(b.other)?.kind === "stored")
			],
			(a: Bound, b: Bound) => a.column === b.column
		)
		const fields = Arr.flatMap(bound, (b) => {
			const at = this.bound(b.other)
			const field = FIELDS.get(b.column)
			if (at !== undefined && field === undefined) {
				this.shapes.add("a law column dropped from a group")
			}
			if (at?.kind === "stored" && at.text !== undefined && field !== undefined && rel !== "X") {
				this.shapes.add("a group bound by the row another table's read finds")
			}
			if (at?.kind === "call" && field !== undefined && rel !== "X" && at.rows === "one") {
				if (
					(b.other.kind === "own" && this.fixedOwn.has(b.other.alias)) ||
					(b.other.kind === "limited" && this.fixedStacked.has(b.other.alias))
				) {
					this.shapes.add("a group bound by a column its own source's query fixes")
				}
			}
			const text = at?.text
			return at === undefined || text === undefined || field === undefined || rel === "X"
				? []
				: [{ field, text, rows: at.kind === "call" ? at.rows : ("stored" as const) }]
		})
		const sorted = Arr.sort(
			fields,
			Order.mapInput(Order.String, (b: { readonly field: string }) => b.field)
		)
		return this.read(
			{
				relation,
				mode: met ? "arbiter" : this.mode(place, relation, true),
				own: false,
				group: Arr.isReadonlyArrayNonEmpty(sorted) ? Arr.map(sorted, (b) => b.field) : undefined,
				binding: Arr.isReadonlyArrayNonEmpty(sorted)
					? Arr.join(
							Arr.map(sorted, (b) => b.text),
							","
						)
					: undefined,
				rows: callRows(sorted)
			},
			place.feeds,
			place
		)
	}

	opaque(relation: string, place: Place): void {
		this.read(
			{
				relation,
				mode: "negated",
				own: false,
				group: undefined,
				binding: undefined,
				rows: undefined
			},
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

	/** A core of `sources` the walk allocates, as a row source: a derived table's that only reads a table. */
	wrapped(sources: ReadonlyArray<Rows>): Rows {
		this.cores.push(sources)
		return { kind: "core", core: this.cores.length - 1 }
	}

	/**
	 * A query in its place, with the sources every row of it comes through: its one core, or a UNION's arms, each one
	 * core; none for an INTERSECT or an EXCEPT.
	 */
	query(q: QuerySpec, path: string, place: Place, env: Env): ReadonlyArray<Rows> {
		const arms = Arr.map(q.cores, (c, k): ReadonlyArray<Rows> => {
			const arm =
				q.op === "EXCEPT" && k > 0
					? this.enter(place, { ...place, polarity: flip(place.polarity) })
					: place
			if (q.op === "EXCEPT" && k > 0) {
				this.shapes.add("an EXCEPT arm")
			}
			return [{ kind: "core", core: this.core(c, `${path}c${k}`, arm, env, () => []) }]
		})
		const [only, ...more] = arms
		if (!Arr.isReadonlyArrayNonEmpty(more)) {
			return only
		}
		return q.op === "UNION" ? [{ kind: "union", arms }] : []
	}

	/**
	 * A core in its place, by its number: every row of it comes through each of its sources, its target's first, unless
	 * it counts with no GROUP BY, which yields a row over no input.
	 */
	core(
		c: CoreSpec,
		path: string,
		place: Place,
		env: Env,
		target: (here: Place) => ReadonlyArray<Rows>
	): number {
		const id = this.cores.length
		this.cores.push([])
		const here: Place = this.opening(
			place,
			{
				...place,
				counted: place.counted || counts(c.aggregate),
				core: id
			},
			c.aggregate.kind === "groupBy" ? id : undefined
		)
		if (!place.counted && counts(c.aggregate)) {
			this.shapes.add(
				c.aggregate.kind === "groupBy"
					? "a grouped count judged by its own rows"
					: "an ungrouped count judged by the core its value lands in"
			)
		}
		const rows: Array<Rows> = [...target(here)]
		const sources = placed(c, path, env)
		for (const s of sources) {
			if (s.kind === "metRows" || s.kind === "held") {
				this.metRows.set(s.alias, s)
			}
			if (s.kind === "held") {
				this.held.add(s.alias)
			}
			if (
				(s.kind === "plain" && s.own === "context") ||
				(s.kind === "derived" && oneRow(s.query))
			) {
				this.oneRows.add(s.alias)
			}
			if (s.kind === "plain" && s.own === "context") {
				this.contexts.add(s.alias)
			}
			if (s.kind === "table" && (s.form === "direct" || s.form === "plain")) {
				this.tablesAt.set(s.alias, { rel: s.rel, form: s.form })
			}
			const fixed =
				s.kind === "derived"
					? fixedOfQuery(s.query, `${s.alias}q`, place.scope, env)
					: s.kind === "cte"
						? fixedOfQuery(s.query, s.path, [], [])
						: undefined
			if (fixed !== undefined) {
				this.fixedOwn.set(s.alias, fixed)
			}
			const stacked =
				s.kind === "table" && s.form === "stacked" ? stackedFixed(s.inner, "c_b") : undefined
			if (stacked !== undefined) {
				this.fixedStacked.set(s.alias, stacked)
			}
		}
		const owns = ownAliases(sources)
		const tables = Arr.flatMap(sources, (s) => (s.kind === "table" ? [s.alias] : []))
		const within = [...place.scope, ...owns]
		const beneath: Place = { ...here, probe: false }
		const limited = new Set(
			Arr.flatMap(sources, (s) =>
				s.kind === "table" && (s.form === "limited" || s.form === "stacked") ? [s.alias] : []
			)
		)
		const resolve = (o: Other): ResolvedOther => {
			const r = resolveOther(o, owns, tables, place.scope)
			return r.kind === "table" && limited.has(r.alias) ? { kind: "limited", alias: r.alias } : r
		}
		const ordered = conditionOrder(sources)
		/**
		 * The equalities of the core's conditions that read table `t`, in their order: each of its own, by its column, and
		 * each another table states with it, by its c_b, the other side that table's column (ModelOther `incoming`).
		 */
		const keyedBy = (t: PlacedTable): ReadonlyArray<Bound> =>
			Arr.flatMap(ordered, ({ table, e }): ReadonlyArray<Bound> => {
				if (table.alias === t.alias) {
					return [{ column: e.column, other: resolve(e.other) }]
				}
				const r = resolve(e.other)
				return (r.kind === "table" || r.kind === "limited") && r.alias === t.alias
					? [{ column: "c_b", other: { kind: "incoming", alias: table.alias, column: e.column } }]
					: []
			})
		this.aggregateShapes(c.aggregate)
		for (const s of sources) {
			switch (s.kind) {
				case "table":
					if (s.form === "stacked") {
						const outer = Arr.map(keyedBy(s), (b) => ({
							column: ROTATED[ROTATED[b.column]],
							other: b.other
						}))
						if (
							Arr.some(
								outer,
								(b) => FIELDS.has(b.column) && s.rel !== "X" && this.bound(b.other) !== undefined
							)
						) {
							this.shapes.add("a group keyed through two derived tables")
						}
						rows.push(
							this.wrapped([
								this.table(
									s.rel,
									{ ...beneath, scope: place.scope },
									[
										...Arr.map(s.inner, (e) => ({
											column: ROTATED[e.column],
											other: { kind: "param" as const, slot: e.slot }
										})),
										...outer
									],
									false
								)
							])
						)
						break
					}
					if (s.form === "limited") {
						if (s.equalities.length > 0) {
							this.shapes.add("a projection outside conditions do not key")
						}
						rows.push(
							this.wrapped([this.table(s.rel, { ...beneath, scope: place.scope }, [], false)])
						)
						break
					}
					rows.push(
						this.table(
							s.rel,
							here,
							Arr.map(keyedBy(s), (b) => ({
								column: s.form === "plain" ? ROTATED[b.column] : b.column,
								other: b.other
							})),
							false
						)
					)
					for (const e of s.equalities) {
						const o = resolve(e.other)
						if (
							s.form === "plain" &&
							FIELDS.has(ROTATED[e.column]) &&
							s.rel !== "X" &&
							otherText(o) !== undefined
						) {
							this.shapes.add("a projection keyed by the conditions of the core that reads it")
						}
						if (o.kind === "param" && FIELDS.has(e.column) && s.rel !== "X") {
							this.shapes.add("a group bound by a placeholder")
						}
						if (o.kind === "own" && FIELDS.has(e.column) && s.rel !== "X") {
							this.shapes.add(
								owns.includes(o.alias)
									? "a group bound by an own column"
									: "a group bound by an enclosing core's column"
							)
							const source = Arr.findFirst(sources, (p) => p.alias === o.alias).pipe(
								Option.getOrUndefined
							)
							if (source?.kind === "plain" && source.own === "context") {
								this.shapes.add("a group bound by the context's fact")
							}
							if (source?.kind === "derived" && factOver(source.query)) {
								this.shapes.add(
									oneRow(source.query)
										? "a group bound by a derived table of the context's fact, one value"
										: "a group bound by a derived table of the context's fact and VALUES, one per row"
								)
							}
						}
					}
					break
				case "carrier": {
					this.shapes.add("a carrier read")
					const relation = `carrier:${unitCarrierName(s.carrier)}`
					rows.push(
						this.read(
							{
								relation,
								mode: this.mode(here, relation, false),
								own: true,
								group: undefined,
								binding: undefined,
								rows: undefined
							},
							here.feeds,
							here
						)
					)
					break
				}
				case "cte":
					this.shapes.add("a CTE read where it is named")
					this.ctes.add(s.path)
					for (const r of this.query(s.query, s.path, { ...beneath, scope: [] }, [])) {
						rows.push(r)
					}
					break
				case "derived":
					for (const r of this.query(
						s.query,
						`${s.alias}q`,
						{ ...beneath, scope: place.scope },
						env
					)) {
						rows.push(r)
					}
					break
				case "probe":
					this.shapes.add(
						s.by === "key"
							? "a probe at a key"
							: s.by === "group"
								? "a probe at a group"
								: "a probe at a group's last row"
					)
					rows.push(
						this.table(
							s.rel,
							here,
							Arr.map(s.equalities, (e) => ({ column: e.column, other: resolve(e.other) })),
							false
						)
					)
					break
				case "metRows":
					this.shapes.add("an INSERT's met rows")
					this.ctes.add(s.path)
					for (const r of this.query(s.query, s.path, { ...beneath, scope: [] }, [])) {
						rows.push(r)
					}
					break
				case "held":
					this.shapes.add("a CTE that holds an INSERT's met rows whole")
					this.ctes.add(s.path)
					this.ctes.add(s.proposedPath)
					{
						/** The held CTE's own core, over its met rows alone, in which the proposed query's rows stand. */
						const held = this.cores.length
						this.cores.push([])
						this.cores[held] = this.query(
							s.query,
							s.proposedPath,
							{ ...beneath, scope: [], core: held },
							[]
						)
						rows.push({ kind: "core", core: held })
					}
					break
				case "met": {
					if (this.level === "readCommitted") {
						this.shapes.add("the row an arbitration met, refused at READ COMMITTED")
						this.opaque(`?met:"app"."${TABLES[s.rel].name}"`, here)
						break
					}
					const alias = metRowsAlias(s, owns, place.scope)
					const named = alias === undefined ? undefined : this.metRows.get(alias)
					const insert = named === undefined ? undefined : this.inserts.get(named.insert)
					const conflict = insert?.conflict
					const sealed =
						insert !== undefined &&
						named !== undefined &&
						insert.rel === s.rel &&
						insert.proposes === named.proposed &&
						(conflict?.kind === "every" ||
							(conflict?.kind === "columns" &&
								conflict.action === "doNothing" &&
								Arr.every(conflict.columns, (column) => s.columns.includes(column))))
					if (sealed && alias !== undefined && this.held.has(alias)) {
						this.shapes.add(
							"the row an arbitration met, through a CTE that holds its met rows whole"
						)
					}
					this.shapes.add(
						sealed
							? "the row an arbitration met"
							: named === undefined
								? "the row met through no met rows, read by its place"
								: "the row met through met rows of no INSERT proposing them alone with DO NOTHING over its key, read by its place"
					)
					this.table(
						s.rel,
						here,
						alias === undefined
							? []
							: Arr.map(s.columns, (column) => ({ column, other: { kind: "own", alias } })),
						sealed
					)
					break
				}
				case "returning":
					this.shapes.add("a writing CTE's RETURNING read as the call's own rows")
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
				this.query(p.query, `${path}p`, this.enter(value, { ...value, counted: true }), env)
				break
			case "exists":
				this.query(
					p.query,
					`${path}p`,
					this.enter(value, { ...value, probe: true, polarity: "both" }),
					env
				)
				break
		}
		this.cores[id] = c.aggregate.kind === "groupBy" || !counts(c.aggregate) ? rows : []
		if (Arr.some(this.probes, (probe) => probe.core === id)) {
			if (Arr.some(sources, (s) => s.kind === "probe")) {
				this.shapes.add("a probed core reading a probe")
			}
			for (const s of sources) {
				const q = s.kind === "cte" || s.kind === "derived" ? s.query : undefined
				const [only, ...more] = q?.cores ?? []
				if (q !== undefined && Arr.isReadonlyArrayNonEmpty(more)) {
					this.shapes.add(
						q.op === "UNION"
							? "a probed core reading a UNION"
							: "a probed core reading an INTERSECT or an EXCEPT"
					)
				} else if (
					only !== undefined &&
					only.aggregate.kind !== "groupBy" &&
					counts(only.aggregate)
				) {
					this.shapes.add("a probed core reading an aggregate with no GROUP BY")
				} else if (only !== undefined) {
					this.shapes.add("a probed core reading a one-core derived table or CTE")
				}
			}
		}
		return id
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
					this.enter(place, {
						...place,
						probe: true,
						polarity: f.not ? flip(place.polarity) : place.polarity
					}),
					env
				)
				return
			case "in":
				this.query(
					f.query,
					`${path}q`,
					this.enter(place, {
						...place,
						probe: false,
						polarity: f.not ? flip(place.polarity) : place.polarity
					}),
					env
				)
				return
			case "not":
				if (place.polarity === "negated") {
					this.shapes.add("NOT flipped back")
				}
				this.filter(
					f.inner,
					`${path}n`,
					this.enter(place, { ...place, polarity: flip(place.polarity) }),
					env
				)
				return
			case "call":
				switch (f.fn) {
					case "noTable":
						return
					case "readsTables":
						this.shapes.add("a function that may read tables")
						this.opaque(`?function:"app"."${READS_TABLES}"`, place)
						return
				}
		}
	}

	dml(d: Dml, path: string, env: Env, statement: Env): void {
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
				const proposal = proposalOf(d, statement)
				if (proposal !== undefined) {
					this.shapes.add("an INSERT proposing a query CTE alone")
					this.query(proposal.query, `${path}i`, { ...topPlace, feeds: at }, [proposal.cte])
				} else if (d.source !== undefined) {
					this.query(d.source, `${path}i`, { ...topPlace, feeds: at }, env)
				}
				if (
					conflict.kind === "every" &&
					this.level === "readCommitted" &&
					d.target.kind === "table"
				) {
					this.shapes.add("an ON CONFLICT with no target, refused at READ COMMITTED")
					this.opaque(`?every:"app"."${TABLES[d.target.rel].name}"`, topPlace)
				} else if (conflict.kind !== "none" && target !== undefined && d.target.kind === "table") {
					const rel = d.target.rel
					const stated = proposal === undefined && d.source === undefined && d.params
					/** The value the source query fixes its one column, c_id, to, where it fixes one (fixedOfQuery). */
					const sourced =
						proposal !== undefined
							? fixedOfQuery(proposal.query, `${path}i`, [], [proposal.cte])
							: d.source !== undefined
								? fixedOfQuery(d.source, `${path}i`, [], env)
								: undefined
					if (conflict.kind === "every") {
						this.shapes.add("an ON CONFLICT with no target, arbitrating every key and UNIQUE")
					}
					const arbitrated: ReadonlyArray<ReadonlyArray<Column>> =
						conflict.kind === "columns"
							? [conflict.columns]
							: conflict.kind === "every" && rel !== "X"
								? ARBITERS
								: [[]]
					for (const columns of arbitrated) {
						const fields =
							rel === "X"
								? []
								: Arr.flatMap(columns, (column) => {
										const field = FIELDS.get(column)
										const slot = Arr.findFirstIndex(COLUMNS, (c) => c === column)
										const carried =
											stated && Option.isSome(slot) && slot.value < 3
												? paramText(slot.value + 1)
												: column === "c_id"
													? sourced
													: undefined
										if (sourced !== undefined && column === "c_id") {
											this.shapes.add("an ON CONFLICT bound by the value its source query fixes")
										}
										return field === undefined
											? []
											: [
													{
														field,
														text: carried ?? `excluded.${column}`,
														rows: carried === undefined ? ("many" as const) : ("one" as const)
													}
												]
									})
						if (stated && Arr.isReadonlyArrayNonEmpty(fields)) {
							this.shapes.add("an ON CONFLICT bound by the parameters its row carries")
						}
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
								: undefined,
							rows: callRows(sorted)
						})
					}
				}
				return
			}
			case "update":
			case "delete": {
				const target: TargetSpec = d.kind === "update" ? { kind: "table", rel: d.rel } : d.target
				const at = this.write(target.kind === "table" ? relationOf(target.rel) : undefined, d.kind)
				const place: Place = { ...topPlace, feeds: at }
				this.core(
					d.kind === "update" ? d.from : d.using,
					`${path}${d.kind === "update" ? "u" : "d"}`,
					place,
					env,
					(here) => {
						if (target.kind === "table") {
							if (d.keyed !== undefined && FIELDS.has(d.keyed) && target.rel !== "X") {
								this.shapes.add("a target bound by its WHERE")
							}
							return [
								this.table(
									target.rel,
									here,
									d.keyed === undefined
										? []
										: [{ column: d.keyed, other: { kind: "param", slot: 8 } }],
									false
								)
							]
						}
						this.shapes.add("a carrier read")
						const relation = `carrier:${unitCarrierName(9)}`
						return [
							this.read(
								{
									relation,
									mode: "positive",
									own: true,
									group: undefined,
									binding: undefined,
									rows: undefined
								},
								at,
								here
							)
						]
					}
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
				this.query(
					d.using,
					`${path}m`,
					bySource ? this.enter(place, { ...place, polarity: "both" }) : place,
					env
				)
				/** The MERGE's source, one row of values the call holds once where its query is (oneRow). */
				const source = `${path}m`
				if (oneRow(d.using)) {
					this.oneRows.add(source)
				}
				const fixed = fixedOfQuery(d.using, source, [], env)
				if (fixed !== undefined) {
					this.fixedOwn.set(source, fixed)
				}
				const on: Bound = { column: "c_id", other: { kind: "own", alias: source } }
				const conditioned: Bound = { column: "c_a", other: { kind: "param", slot: 7 } }
				for (const w of d.whens) {
					const condition = w.condition ? [conditioned] : []
					if (w.match === "NOT MATCHED") {
						if (this.written.has(relation)) {
							this.shapes.add("a MERGE's NOT MATCHED arbiter")
						}
						this.table(
							d.rel,
							this.enter(place, { ...place, polarity: "negated", probe: true }),
							[on],
							false
						)
					} else {
						this.table(d.rel, place, w.match === "MATCHED" ? [on, ...condition] : condition, false)
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

/** A writing CTE's INSERT as a met row's seal reads it: its table, the query CTE it proposes alone, its ON CONFLICT. */
interface WritingInsert {
	readonly rel: Rel | undefined
	readonly proposes: string | undefined
	readonly conflict: Conflict
}

/** The INSERTs of a statement's writing CTEs, by the CTE's name: what a met rows source names. */
const insertsIn = (s: StatementSpec): ReadonlyMap<string, WritingInsert> => {
	if (s.kind !== "dml" && s.kind !== "select") {
		return new Map()
	}
	const env = envOf(s.ctes)
	return new Map(
		Arr.flatMap(s.ctes, (c, i): ReadonlyArray<readonly [string, WritingInsert]> =>
			c.kind === "dml" && c.dml.kind === "insert"
				? [
						[
							`c${i}`,
							{
								rel: c.dml.target.kind === "table" ? c.dml.target.rel : undefined,
								proposes: proposalOf(c.dml, env)?.cte.name,
								conflict: c.dml.conflict
							}
						]
					]
				: []
		)
	)
}

/** A statement's expected facts: its writing CTEs run once at their definition, its query CTEs read where named. */
export const expected = (s: StatementSpec, level: Isolation): Expect => {
	const x = new Expect(writtenIn(s), insertsIn(s), level)
	switch (s.kind) {
		case "refresh":
			x.shapes.add("a statement no member sends")
			x.opaque('?refresh:"app"."v"', topPlace)
			return x
		case "schema":
			x.shapes.add("a statement no member sends")
			x.opaque("?statement:createSchema", topPlace)
			return x
		case "select":
		case "dml": {
			const env = envOf(s.ctes)
			Arr.forEach(s.ctes, (c, i) => {
				if (c.kind === "dml") {
					x.shapes.add("a CTE's write")
					x.dml(c.dml, `c${i}`, [], env)
				}
			})
			if (s.kind === "select") {
				x.query(s.query, "q", topPlace, env)
			} else {
				x.dml(s.dml, "", env, env)
			}
			return x
		}
	}
}

/** A read as the comparison keys it: every field, a group's in order. */
export const readKey = (r: Expected): string =>
	Arr.join(
		[
			r.relation,
			r.mode,
			`${r.own}`,
			r.group === undefined ? "-" : Arr.join(r.group, ","),
			r.binding ?? "-",
			r.rows ?? "-"
		],
		"|"
	)

export const sortedKeys = (reads: ReadonlyArray<Expected>): ReadonlyArray<string> =>
	Arr.sort(Arr.map(reads, readKey), Order.String)

/** A write as the comparison keys it: its relation, its operation and the reads its `from` names, as a multiset. */
export const writeKey = (relation: string, op: string, from: ReadonlyArray<Expected>): string =>
	`${relation}|${op}|${Arr.join(sortedKeys(from), ";")}`

/** The extractor's row sources as the oracle states them, each read by its key (`expectedAt`, by its flat place) and
 * the probes above it. */
export const gotRows = (
	reads: ReadonlyArray<ReadFact>,
	expectedAt: (at: number) => Expected,
	sources: ReadonlyArray<FlatRowSource>
): ReadonlyArray<Rows> =>
	Arr.map(sources, (r): Rows => {
		switch (r.kind) {
			case "read": {
				const read = Arr.getUnsafe(reads, r.read)
				return { kind: "read", key: readKey(expectedAt(r.read)), probes: read.probes }
			}
			case "core":
				return r
			case "union":
				return {
					kind: "union",
					arms: Arr.map(r.arms, (arm) => gotRows(reads, expectedAt, arm))
				}
		}
	})

/**
 * Row sources as the comparison reads them, every core inlined: each read by its key, marked `~` where it stands
 * beneath other probes than `chain`, the probes of the core a probe judges.
 */
const renderedRows = (
	cores: ReadonlyArray<ReadonlyArray<Rows>>,
	sources: ReadonlyArray<Rows>,
	chain: ReadonlyArray<number>
): string =>
	`[${Arr.join(
		Arr.map(sources, (r) => {
			switch (r.kind) {
				case "read":
					return Arr.join(Arr.map(r.probes, String), ",") === Arr.join(Arr.map(chain, String), ",")
						? r.key
						: `~${r.key}`
				case "core":
					return `core${renderedRows(cores, Arr.getUnsafe(cores, r.core), chain)}`
				case "union":
					return `union(${Arr.join(
						Arr.map(r.arms, (arm) => renderedRows(cores, arm, chain)),
						" | "
					)})`
			}
		}),
		", "
	)}]`

/** A probe's core's row sources as the comparison reads them, or that it stands in no core. */
export const probeRows = (
	cores: ReadonlyArray<ReadonlyArray<Rows>>,
	core: number | undefined,
	chain: ReadonlyArray<number>
): string =>
	core === undefined ? "no core" : renderedRows(cores, Arr.getUnsafe(cores, core), chain)
