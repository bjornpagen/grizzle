/** What the properties of rows.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import type {
	Cte,
	Expr,
	FromSource,
	OperandCore,
	OperandSelect,
	SetCore,
	SqlStatement
} from "#compiler/sql/ast.ts"
import {
	call,
	col,
	core,
	countStar,
	cte,
	cteRefAs,
	derived,
	distinctCore,
	exists,
	grouped,
	lit,
	operandSelect,
	provedCore,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"

/** A table's column c1 under `alias`. */
export const read = (alias: string): Expr => col(alias, "c1")

/** A table's column c1 under `alias`, a set of rows only by a DISTINCT, and a plain read of it, whose rows may repeat. */
export const distinctRead = (alias: string): SetCore =>
	distinctCore([targetAs(read(alias), "c1")], [table("w", "t", alias)], undefined)

/** A plain read of a table's column c1 under `alias`, whose rows may repeat. */
export const plainRead = (alias: string): OperandCore =>
	core([targetAs(read(alias), "c1")], [table("w", "t", alias)], undefined)

/** The sources a reader reads: a table, a derived table or a CTE of a set or of an operand that may repeat rows. */
export const sources = [
	"table",
	"set derived",
	"operand derived",
	"set cte",
	"operand cte"
] as const

/** A source a reader reads. */
type Source = (typeof sources)[number]

/** Each source read under the alias r2, and the CTE it reads, if any. */
export const sourceOf = (
	s: Source
): { readonly from: FromSource; readonly cte: Cte | undefined } => {
	switch (s) {
		case "table":
			return { from: table("w", "t", "r2"), cte: undefined }
		case "set derived":
			return {
				from: derived(select(distinctRead("r3")), "r2", false),
				cte: undefined
			}
		case "operand derived":
			return {
				from: derived(operandSelect(plainRead("r3")), "r2", false),
				cte: undefined
			}
		case "set cte":
			return {
				from: cteRefAs("r4", "r2"),
				cte: cte("r4", select(distinctRead("r3")))
			}
		case "operand cte":
			return {
				from: cteRefAs("r4", "r2"),
				cte: cte("r4", operandSelect(plainRead("r3")))
			}
	}
}

/** The readers of a source: each way the statement's core reads it. */
export const readers = [
	"keyed",
	"certified",
	"input",
	"distinct",
	"count per group",
	"min per group",
	"under EXISTS"
] as const

/** A reader of a source. */
type Reader = (typeof readers)[number]

/** The statement's one core, reading `from`. */
export const readerOf = (r: Reader, from: FromSource): SetCore => {
	const c1 = [targetAs(read("r2"), "c1")] as const
	switch (r) {
		case "keyed":
		case "certified":
		case "input":
			return provedCore(r, c1, [from], undefined)
		case "distinct":
			return distinctCore(c1, [from], undefined)
		case "count per group":
			return grouped(core([...c1, targetAs(countStar(), "c2")], [from], undefined), [read("r2")])
		case "min per group":
			return grouped(core([...c1, targetAs(call("min", [read("r2")]), "c2")], [from], undefined), [
				read("r2")
			])
		case "under EXISTS":
			return provedCore(
				"oneRow",
				[
					targetAs(
						exists(operandSelect(core([target(lit.int(1, types.integer))], [from], undefined))),
						"c1"
					)
				],
				[],
				undefined
			)
	}
}

/** The statement of a core, with the CTE it reads, if any. */
export const statementOf = (body: SetCore, read: Cte | undefined): SqlStatement => ({
	...select(body),
	with: read === undefined ? undefined : { recursive: false, ctes: [read] }
})

/**
 * The oracle, written apart from the audit: a reader whose rows a repeat changes (a key claim, a certificate, an input
 * read, a count) needs a set; DISTINCT, a repeat-blind aggregate and EXISTS make what they read a set.
 */
export const needsSet = (r: Reader): boolean =>
	r === "keyed" || r === "certified" || r === "input" || r === "count per group"

/** Whether a source's rows may repeat: an operand's, derived or a CTE. */
export const repeats = (s: Source): boolean => s === "operand derived" || s === "operand cte"

/** A body's kinds: a set of rows, or an operand whose rows may repeat. */
export const bodies = ["set", "operand"] as const

/** The bounds a query may take: none, a LIMIT of one or two, an OFFSET past 0, or OFFSET 0, a fence. */
export const bounds = ["none", "LIMIT 1", "LIMIT 2", "OFFSET 1", "OFFSET 0"] as const

/** A bound a query takes. */
type Bound = (typeof bounds)[number]

/** A query under a bound. */
export const bounded = (q: OperandSelect, b: Bound): OperandSelect => {
	const one = lit.int(1, types.integer)
	switch (b) {
		case "none":
			return q
		case "LIMIT 1":
			return { ...q, limit: one }
		case "LIMIT 2":
			return { ...q, limit: lit.int(2, types.integer) }
		case "OFFSET 1":
			return { ...q, offset: one }
		case "OFFSET 0":
			return { ...q, offset: lit.int(0, types.integer) }
	}
}

/** The cores of one row: no FROM, an ungrouped aggregate, and a column of a one-row source. */
export const oneRowCores = ["no FROM", "an aggregate", "a column"] as const

/** The two columns a grouped core may read and group by. */
export const groupColumns = ["c1", "c2"] as const

/** A column a grouped core may read and group by. */
type GroupColumn = (typeof groupColumns)[number]

/** A column of the table under r1. */
export const groupColumn = (column: GroupColumn): Expr => col("r1", column)

/** A target a grouped core may select: one of the two columns, or a count of the group's rows. */
type GroupTarget =
	| { readonly kind: "column"; readonly column: GroupColumn }
	| { readonly kind: "count" }

/** The targets a grouped core may hold: each column, and count(*). */
export const groupTargets: ReadonlyArray<GroupTarget> = [
	...Arr.map(groupColumns, (column): GroupTarget => ({ kind: "column", column })),
	{ kind: "count" }
]

/** The expression a group target is. */
export const targetExpr = (t: GroupTarget): Expr =>
	t.kind === "column" ? groupColumn(t.column) : countStar()

/** The members of `items` a bit mask selects, bit i for the i-th. */
export const chosen = <A>(items: ReadonlyArray<A>, mask: number): ReadonlyArray<A> =>
	Arr.filter(items, (_, i) => (mask & (1 << i)) !== 0)

/** What a grouped core's GROUP BY was: every expression a target, or one that is none. */
export type GroupsFeature = "every GROUP BY expression a target" | "a GROUP BY expression no target"
