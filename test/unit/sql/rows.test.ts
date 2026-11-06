import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
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
	proved,
	provedCore,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { rowsViolations } from "#test/support/oracle/verify/rows.ts"

const read = (alias: string): Expr => col(alias, "c1")

/** A table's column c1 under `alias`, a set of rows only by a DISTINCT, and a plain read of it, whose rows may repeat. */
const distinctRead = (alias: string): SetCore =>
	distinctCore([targetAs(read(alias), "c1")], [table("w", "t", alias)], undefined)
const plainRead = (alias: string): OperandCore =>
	core([targetAs(read(alias), "c1")], [table("w", "t", alias)], undefined)

const sources = ["table", "set derived", "operand derived", "set cte", "operand cte"] as const
type Source = (typeof sources)[number]

/** Each source read under the alias r2, and the CTE it reads, if any. */
const sourceOf = (s: Source): { readonly from: FromSource; readonly cte: Cte | undefined } => {
	switch (s) {
		case "table":
			return { from: table("w", "t", "r2"), cte: undefined }
		case "set derived":
			return { from: derived(select(distinctRead("r3")), "r2", ["c1"], false), cte: undefined }
		case "operand derived":
			return { from: derived(operandSelect(plainRead("r3")), "r2", ["c1"], false), cte: undefined }
		case "set cte":
			return { from: cteRefAs("r4", "r2"), cte: cte("r4", ["c1"], select(distinctRead("r3"))) }
		case "operand cte":
			return { from: cteRefAs("r4", "r2"), cte: cte("r4", ["c1"], operandSelect(plainRead("r3"))) }
	}
}

const readers = [
	"keyed",
	"certified",
	"input",
	"distinct",
	"count per group",
	"min per group",
	"under EXISTS"
] as const
type Reader = (typeof readers)[number]

/** The statement's one core, reading `from`. */
const readerOf = (r: Reader, from: FromSource): SetCore => {
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

const statementOf = (body: SetCore, read: Cte | undefined): SqlStatement => ({
	...select(body),
	with: read === undefined ? undefined : { recursive: false, ctes: [read] }
})

/**
 * The oracle, written apart from the audit: a reader whose rows a repeat changes (a key claim, a certificate, an input
 * read, a count) needs a set; DISTINCT, a repeat-blind aggregate and EXISTS make what they read a set.
 */
const needsSet = (r: Reader): boolean =>
	r === "keyed" || r === "certified" || r === "input" || r === "count per group"
const repeats = (s: Source): boolean => s === "operand derived" || s === "operand cte"

const bodies = ["set", "operand"] as const
const bounds = ["none", "LIMIT 1", "LIMIT 2", "OFFSET 1"] as const
type Bound = (typeof bounds)[number]

const bounded = (q: OperandSelect, b: Bound): OperandSelect => {
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
	}
}

const oneRowCores = ["no FROM", "an aggregate", "a column"] as const

describe("the rows audit (oracle/verify/rows.ts)", () => {
	it.effect(
		"refuses exactly the derived tables and CTEs whose rows may repeat under a reader they change",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/sql/rows-readers",
						box: "seven readers of one column over a table, a derived table or a CTE, each a set or rows that may repeat",
						oracle: {
							kind: "second-implementation",
							name: "needsSet and repeats, the readers that count repeats over the sources that may hold them"
						},
						generator: (s) => ({
							reader: s.draw(element(readers)),
							source: s.draw(element(sources))
						}),
						literal: Formatter.format,
						limit: readers.length * sources.length,
						coverage: noCoverage,
						caseHang
					},
					({ reader, source }) =>
						Effect.sync(() => {
							const s = sourceOf(source)
							const violations = rowsViolations(statementOf(readerOf(reader, s.from), s.cte))
							assert.equal(
								violations.length,
								needsSet(reader) && repeats(source) ? 1 : 0,
								Arr.join(violations, "; ")
							)
						})
				)
			)
	)

	it.effect(
		"refuses a bound that counts repeated rows, LIMIT 1 alone keeping one of equal rows",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/sql/rows-bounds",
						box: "a set body and a body that may repeat rows, each unbounded, under LIMIT 1, LIMIT 2 and OFFSET 1",
						oracle: {
							kind: "specification",
							name: "a bound counts the rows it reads: only LIMIT 1 alone keeps one of equal rows"
						},
						generator: (s) => ({ body: s.draw(element(bodies)), bound: s.draw(element(bounds)) }),
						literal: Formatter.format,
						limit: bodies.length * bounds.length,
						coverage: noCoverage,
						caseHang
					},
					({ body, bound }) =>
						Effect.sync(() => {
							const query = operandSelect(body === "set" ? distinctRead("r3") : plainRead("r3"))
							const statement = select(
								distinctCore(
									[targetAs(read("r2"), "c1")],
									[derived(bounded(query, bound), "r2", ["c1"], false)],
									undefined
								)
							)
							const counted = body === "operand" && (bound === "LIMIT 2" || bound === "OFFSET 1")
							assert.equal(rowsViolations(statement).length, counted ? 1 : 0, `${body} ${bound}`)
						})
				)
			)
	)

	it.effect("holds a one-row claim to its shape or a LIMIT 1 over it", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/sql/rows-one-row",
					box: "a core of no FROM, of an aggregate over a table and of a column of a table, each under LIMIT 1 or none",
					oracle: {
						kind: "specification",
						name: "one row: no FROM, aggregates and no GROUP BY, or a LIMIT 1 over the core"
					},
					generator: (s) => ({
						shape: s.draw(element(oneRowCores)),
						limited: s.draw(element([false, true]))
					}),
					literal: Formatter.format,
					limit: oneRowCores.length * 2,
					coverage: noCoverage,
					caseHang
				},
				({ shape, limited }) =>
					Effect.sync(() => {
						const c =
							shape === "no FROM"
								? core([target(lit.int(1, types.integer))], [], undefined)
								: core(
										[targetAs(shape === "an aggregate" ? countStar() : read("r1"), "c1")],
										[table("w", "t", "r1")],
										undefined
									)
						const query = select(proved("oneRow", c))
						const statement = limited ? { ...query, limit: lit.int(1, types.integer) } : query
						assert.equal(
							rowsViolations(statement).length,
							shape === "a column" && !limited ? 1 : 0,
							`${shape} ${limited ? "under LIMIT 1" : "unbounded"}`
						)
					})
			)
		)
	)

	it("holds a groups claim to each GROUP BY expression being a target", () => {
		const from = [table("w", "t", "r1")]
		const byTarget = select({ ...proved("grouped", plainRead("r1")), groupBy: [read("r1")] })
		const byOther = select({
			...proved("grouped", core([targetAs(countStar(), "c1")], from, undefined)),
			groupBy: [read("r1")]
		})
		assert.deepEqual(rowsViolations(byTarget), [])
		assert.deepEqual(rowsViolations(byOther), [
			"a core claims its groups, and a GROUP BY expression is none of its targets"
		])
	})
})
