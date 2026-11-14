/**
 * Canonical cell keyed-set comparison (test/support/oracle/compare.ts), against models that read no spelling.
 *
 * - Row multisets: compareMultisets(left, right) names as missing exactly the rows left holds more often than right,
 *   each with how many more times, and as extra exactly those right holds more often, against a count-by-row model
 *   (a TupleMap of each row's count), compared as sets of rows with counts. The right side is the left one changed by
 *   a named kind, weighted explicitly: reordered, a row repeated, a row dropped, a cell changed, or drawn apart.
 * - Runs: two runs whose cells spell values in any of their output spellings (1.0 and 1.00, -0 and 0) agree exactly
 *   when each holds every value once and they hold one set of values, against a count of the value classes the cells
 *   spell, which reads no spelling; a run that repeats a value agrees with nothing, a run repeating it alike included.
 *   The right run is the left one respelled and reordered, with one value changed or one row repeated.
 *
 * Oracles: second implementations, the count-by-row model and the count of value classes. Features: each change kind,
 * and each verdict (equal, missing rows, extra rows, both; agreement across spellings, a value, a count or a repeat
 * told apart).
 *
 * Plants: ~/.cache/grizzle-release/BR07/plants/compare-single-excess.patch (an excess of one row left unreported) turns
 * the multiset property red; compare-first-cell-key.patch (a row keyed by its first cell alone) turns both red.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { indices } from "#compiler/core/array.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { anyNumeric } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { assert } from "#test/support/assert.ts"
import type { ValueIdentity } from "#test/support/kernel/identity.ts"
import { caseHang } from "#test/support/limits.ts"
import { compareMultisets, compareRuns, type Run } from "#test/support/oracle/compare.ts"
import type { RawRow } from "#test/support/oracle/install/capture.ts"
import { at } from "#test/support/oracle/pick.ts"

/** The cells a raw row is drawn from: spellings of one value, the empty text, and a word. */
const cells: Arr.NonEmptyReadonlyArray<string> = ["0", "1", "-0", "1.0", "", "x"]

const rowGen: Gen<RawRow> = array(element(cells), { min: 1, max: 2 })

/** How the right side of a multiset pair is made from the left. */
type Change = "reordered" | "a row repeated" | "a row dropped" | "a cell changed" | "drawn apart"

interface MultisetPair {
	readonly change: Change
	readonly left: ReadonlyArray<RawRow>
	readonly right: ReadonlyArray<RawRow>
}

/** The rows at `order`'s positions of `rows`. */
const permuted = <A>(rows: ReadonlyArray<A>, order: ReadonlyArray<number>): ReadonlyArray<A> =>
	Arr.map(order, (i) => at(rows, i))

/** A permutation of `n` positions, drawn whole. */
const permutationOf = (n: number): Gen<ReadonlyArray<number>> =>
	shuffled(indices(n), { min: n, max: n })

/** The left rows, then the right ones made from them by a change: a change that edits a row draws at least one. */
const multisetPairGen: Gen<MultisetPair> = weighted<MultisetPair>([
	[
		2,
		(s) => {
			const left = s.draw(array(rowGen, { min: 0, max: 6 }))
			return {
				change: "reordered",
				left,
				right: permuted(left, s.draw(permutationOf(left.length)))
			}
		}
	],
	[
		1,
		(s) => {
			const left = s.draw(array(rowGen, { min: 1, max: 6 }))
			const right = [...left, at(left, s.draw(int(0, left.length - 1)))]
			return {
				change: "a row repeated",
				left,
				right: permuted(right, s.draw(permutationOf(right.length)))
			}
		}
	],
	[
		1,
		(s) => {
			const left = s.draw(array(rowGen, { min: 1, max: 6 }))
			return {
				change: "a row dropped",
				left,
				right: Arr.remove(left, s.draw(int(0, left.length - 1)))
			}
		}
	],
	[
		1,
		(s) => {
			const left = s.draw(array(rowGen, { min: 1, max: 6 }))
			const row = s.draw(int(0, left.length - 1))
			const edited = at(left, row)
			const cell = s.draw(int(0, edited.length - 1))
			const others = Arr.filter(cells, (x) => x !== at(edited, cell))
			const value = s.draw(element([at(others, 0), ...others.slice(1)]))
			return {
				change: "a cell changed",
				left,
				right: Arr.map(left, (r, i) =>
					i === row ? Arr.map(r, (x, j) => (j === cell ? value : x)) : r
				)
			}
		}
	],
	[
		1,
		(s) => ({
			change: "drawn apart",
			left: s.draw(array(rowGen, { min: 0, max: 6 })),
			right: s.draw(array(rowGen, { min: 0, max: 6 }))
		})
	]
])

/** Each distinct row of `rows` with its count. */
const countsOf = (rows: ReadonlyArray<RawRow>): TupleMap<RawRow, number> =>
	Arr.reduce(rows, new TupleMap<RawRow, number>(), (m, row) => m.set(row, (m.get(row) ?? 0) + 1))

/** The rows `a` holds more often than `b`, each with how many more times. */
const excessOf = (
	a: TupleMap<RawRow, number>,
	b: TupleMap<RawRow, number>
): TupleMap<RawRow, number> =>
	Arr.reduce([...a], new TupleMap<RawRow, number>(), (out, [row, n]) => {
		const more = n - (b.get(row) ?? 0)
		return more > 0 ? out.set(row, more) : out
	})

/** That a reported list of rows with counts is exactly the model's, as sets of rows with counts. */
const sameExcess = (
	reported: ReadonlyArray<{ readonly row: RawRow; readonly count: number }>,
	model: TupleMap<RawRow, number>,
	what: string
): void => {
	const read = Arr.reduce(reported, new TupleMap<RawRow, number>(), (m, e) =>
		m.set(e.row, (m.get(e.row) ?? 0) + e.count)
	)
	assert.equal(read.size, reported.length, `${what} names a row twice`)
	assert.equal(read.size, model.size, `${what}: how many rows`)
	for (const [row, n] of model) {
		assert.equal(read.get(row), n, `${what}: ${Formatter.format(row)}`)
	}
}

type MultisetFeature = Change | "equal" | "missing only" | "extra only" | "missing and extra"

describe("row multisets", () => {
	it.effect(
		"name exactly the rows each side holds more often, against a count-by-row model",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a count of each row, compared as multisets"
						},
						suite: "unit/oracle-runner/compare-multisets",
						draw: drawn(multisetPairGen),
						literal: Formatter.format,
						coverage: required<MultisetFeature>(
							[
								"reordered",
								"a row repeated",
								"a row dropped",
								"a cell changed",
								"drawn apart",
								"equal",
								"missing only",
								"extra only",
								"missing and extra"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ change, left, right }, c) =>
						Effect.sync(() => {
							const l = countsOf(left)
							const r = countsOf(right)
							const missing = excessOf(l, r)
							const extra = excessOf(r, l)
							const compared = compareMultisets(left, right)
							sameExcess(compared.missing, missing, "the missing rows")
							sameExcess(compared.extra, extra, "the extra rows")
							c.note(change)
							c.note(
								missing.size === 0
									? extra.size === 0
										? "equal"
										: "extra only"
									: extra.size === 0
										? "missing only"
										: "missing and extra"
							)
						})
				)
			)
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
type RunChange = "respelled" | "a value changed" | "a row repeated"

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
const canonicalRowGen: Gen<Row> = (source) => [source.draw(cellGen), source.draw(cellGen)]

/** The right run from the left by a drawn change, each row respelled and the rows drawn in a new order. */
const runPairGen: Gen<RunPair> = (source) => {
	const left = source.draw(array(canonicalRowGen, { min: 1, max: 6 }))
	const change = source.draw(
		weighted<RunChange>([
			[2, constant("respelled")],
			[1, constant("a value changed")],
			[1, constant("a row repeated")]
		])
	)
	const respelled = Arr.map(left, (row): Row => [
		{ cls: row[0].cls, sp: source.draw(int(0, 2)) },
		{ cls: row[1].cls, sp: source.draw(int(0, 2)) }
	])
	const reordered = permuted(respelled, source.draw(permutationOf(respelled.length)))
	const changed = source.draw(int(0, reordered.length - 1))
	switch (change) {
		case "respelled":
			return { left, right: reordered }
		case "a value changed":
			return {
				left,
				right: Arr.map(reordered, (row, i): Row =>
					i === changed ? [{ cls: (row[0].cls + 1) % numericClasses.length, sp: 0 }, row[1]] : row
				)
			}
		case "a row repeated":
			return { left, right: [...reordered, at(reordered, changed)] }
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
const valueKey = (row: Row): ValueIdentity => [row[0].cls, row[1].cls]

describe("canonical cell keyed sets", () => {
	it.effect(
		"agree exactly when each run's cells spell a set of values and the two sets are one, whatever the spellings",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a count of the value classes each run's cells spell"
						},
						suite: "unit/oracle-runner/compare-canonical",
						draw: drawn(runPairGen),
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
								Arr.reduce(rows, new TupleMap<ValueIdentity, number>(), (m, row) =>
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
