/**
 * Canonical cell keyed-set comparison (test/support/oracle/compare.ts): row multisets against a count-by-key oracle,
 * and runs whose cells spell values in any of their output spellings (1.0 and 1.00, -0 and 0) against a count of the
 * values those cells spell, which reads no spelling: two runs agree exactly when each holds every value once and they
 * hold one set of values, so a run that repeats a value agrees with nothing, a run repeating it alike included.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { anyNumeric, plainType } from "#compiler/scalar/compute/types.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { compareMultisets, compareRuns, type Run } from "#test/support/oracle/compare.ts"
import { at } from "#test/support/oracle/pick.ts"

describe("row multisets", () => {
	it.effect("agree with a count-by-key oracle on random multisets", (ctx) =>
		Effect.gen(function* () {
			const rows = array(array(element(["0", "1", "-0", "1.0", "", "x"]), { min: 1, max: 2 }), {
				min: 0,
				max: 8
			})
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-runner/compare-1",
						draw: drawn((source) => [source.draw(rows), source.draw(rows)] as const),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([a, b]) =>
						Effect.sync(() => {
							/** Each distinct row with how often it occurs, rows compared cell by cell. */
							const sameRow = (x: ReadonlyArray<string>, y: ReadonlyArray<string>): boolean =>
								x.length === y.length && Arr.every(x, (v, i) => v === y[i])
							const counts = (rs: ReadonlyArray<ReadonlyArray<string>>) => {
								const out: Array<{ readonly row: ReadonlyArray<string>; count: number }> = []
								for (const r of rs) {
									const entry = Arr.findFirst(out, (e) => sameRow(e.row, r))
									if (Option.isNone(entry)) {
										out.push({ row: r, count: 1 })
									} else {
										entry.value.count++
									}
								}
								return out
							}
							const ca = counts(a)
							const cb = counts(b)
							const same =
								ca.length === cb.length &&
								Arr.every(ca, (e) =>
									Arr.some(cb, (f) => sameRow(e.row, f.row) && f.count === e.count)
								)
							const d = compareMultisets(a, b)
							assert.equal(d.missing.length === 0 && d.extra.length === 0, same)
							const excess =
								Arr.reduce(d.extra, 0, (n, e) => n + e.count) -
								Arr.reduce(d.missing, 0, (n, e) => n + e.count)
							assert.equal(excess, b.length - a.length)
						})
				)
			)
		})
	)
})

/** The values of a column of the canonical comparison: each value class with the output texts that spell it. */
const numericClasses: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = [
	["0", "0.0", "0.000000000000000000000000"],
	["1", "1.0", "1.00"],
	["-1.5", "-1.50", "-1.5000000000"],
	["NaN"],
	["0.1", "0.10"]
]

const floatClasses: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = [
	["0", "-0"],
	["1.5"],
	["NaN"],
	["1e-07"],
	["-Infinity"]
]

/** The columns of a drawn run: a numeric of no typmod and a double precision, each with its classes. */
const columns = [
	{ type: anyNumeric, classes: numericClasses },
	{ type: plainType("float8"), classes: floatClasses }
] as const

/** A cell: a value class of its column and one of its spellings. */
interface Cell {
	readonly cls: number
	readonly sp: number
}

type Row = readonly [Cell, Cell]

/** How the right run was made from the left: respelled and reordered, one value changed, or one row more. */
type Change = "respelled" | "a value changed" | "a row repeated"

interface RunPair {
	readonly left: ReadonlyArray<Row>
	readonly right: ReadonlyArray<Row>
}

type CanonicalFeature =
	| "agree across spellings"
	| "a value told apart"
	| "a count told apart"
	| "a repeat told apart"

const cellGen: Gen<Cell> = (source) => ({ cls: source.draw(int(0, 4)), sp: source.draw(int(0, 2)) })
const rowGen: Gen<Row> = (source) => [source.draw(cellGen), source.draw(cellGen)]

/** The right run from the left by a drawn change, each row respelled and the rows drawn in a new order. */
const pairGen: Gen<RunPair> = (source) => {
	const left = source.draw(array(rowGen, { min: 1, max: 6 }))
	const change = source.draw(
		weighted<Change>([
			[2, constant("respelled")],
			[1, constant("a value changed")],
			[1, constant("a row repeated")]
		])
	)
	const respelled = Arr.map(left, (row): Row => [
		{ cls: row[0].cls, sp: source.draw(int(0, 2)) },
		{ cls: row[1].cls, sp: source.draw(int(0, 2)) }
	])
	const order = Arr.sort(
		Arr.map(respelled, (row, i) => ({ row, r: source.draw(int(0, 1000)) + i / 10_000 })),
		Order.mapInput(Order.Number, (x: { readonly r: number }) => x.r)
	)
	const shuffled = Arr.map(order, (x) => x.row)
	const at = source.draw(int(0, shuffled.length - 1))
	switch (change) {
		case "respelled":
			return { left, right: shuffled }
		case "a value changed":
			return {
				left,
				right: Arr.map(shuffled, (row, i): Row =>
					i === at ? [{ cls: (row[0].cls + 1) % numericClasses.length, sp: 0 }, row[1]] : row
				)
			}
		case "a row repeated":
			return { left, right: [...shuffled, ...Arr.take(Arr.drop(shuffled, at), 1)] }
	}
}

const textOf = (row: Row): ReadonlyArray<string> =>
	Arr.map(row, (c, i) => at(at(columns[i === 0 ? 0 : 1].classes, c.cls), c.sp))

const runOf = (name: string, rows: ReadonlyArray<Row>): Run => ({
	name,
	statements: [
		{
			label: "main",
			columns: ["n", "f"],
			types: Arr.map(columns, (c) => c.type),
			unstated: { kind: "none" },
			rows: Arr.map(rows, textOf),
			codes: emptyCodebook
		}
	]
})

/** The oracle's identity of a row: its cells' value classes, which read no spelling. */
const valueKey = (row: Row): string =>
	`${row[0].cls % numericClasses.length}/${row[1].cls % floatClasses.length}`

describe("canonical cell multisets", () => {
	it.effect(
		"agree exactly when the runs' cells spell one multiset of values, whatever the spellings",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-runner/compare-canonical",
						draw: drawn(pairGen),
						literal: Formatter.format,
						coverage: required<CanonicalFeature>(
							[
								"agree across spellings",
								"a value told apart",
								"a count told apart",
								"a repeat told apart"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ left, right }, c) =>
						Effect.sync(() => {
							const count = (rows: ReadonlyArray<Row>) =>
								Arr.reduce(rows, new Map<string, number>(), (m, row) =>
									m.set(valueKey(row), (m.get(valueKey(row)) ?? 0) + 1)
								)
							const a = count(left)
							const b = count(right)
							const sameCounts = a.size === b.size && Arr.every([...a], ([k, n]) => b.get(k) === n)
							const sets = a.size === left.length && b.size === right.length
							const compared = compareRuns(runOf("left", left), runOf("right", right))
							assert.equal(compared.equal, sameCounts && sets)
							assert.equal(compared.repeated.length > 0, !sets)
							if (sameCounts && sets) {
								c.note("agree across spellings")
							} else if (sameCounts) {
								c.note("a repeat told apart")
							} else if (left.length === right.length) {
								c.note("a value told apart")
							} else {
								c.note("a count told apart")
							}
						})
				)
			)
	)
})
