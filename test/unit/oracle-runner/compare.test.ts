/**
 * Raw text multiset comparison (test/support/oracle/compare.ts): compare raw text row multisets against a count-by-key
 * oracle, and runs with cells stated by value alone (a collapse across spellings) against the largest pairing of their
 * rows, found by trying every pairing, where a merged cell may be any spelling of its class and every other cell is
 * itself, a zero's sign included.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order } from "effect"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { assert } from "#test/support/assert.ts"
import {
	compareMultisets,
	compareRuns,
	type MergedCells,
	type Run
} from "#test/support/oracle/compare.ts"
import { indices, nonEmptyList } from "#test/support/oracle/pick.ts"

describe("raw text multisets", () => {
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
						features: noFeatures,
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
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

/**
 * A cell of a drawn run: a value class, one of its spellings, and whether the run states it by value alone (only a
 * class of several spellings can be merged).
 */
interface CellSketch {
	readonly cls: number
	readonly spelling: number
	readonly merged: boolean
}

/**
 * The value classes the cells draw from: a float zero of either sign, one numeric at three display scales, and two
 * values of one spelling each.
 */
const classes: ReadonlyArray<ReadonlyArray<string>> = [
	["0", "-0"],
	["1", "1.0", "1.00"],
	["2"],
	["x"]
]

const classAt = (cls: number): ReadonlyArray<string> => {
	const spellings = classes[cls]
	if (spellings === undefined) {
		throw new Error(`no value class ${cls}`)
	}
	return spellings
}

/** A drawn cell's text: its spelling pick among its class's spellings. */
const textOf = (c: CellSketch): string => {
	const spellings = classAt(c.cls)
	const text = spellings[c.spelling % spellings.length]
	if (text === undefined) {
		throw new Error(`no spelling ${c.spelling} of class ${c.cls}`)
	}
	return text
}

/** Whether a run states a drawn cell by value alone: it is marked, and its class holds several spellings. */
const isMerged = (c: CellSketch): boolean => c.merged && classAt(c.cls).length > 1

type MergedFeature =
	| "paired only up to a merged spelling"
	| "a zero's sign told apart in an unmerged cell"
	| "a pairing only an augmenting path finds"

/** A run of one statement over `width` columns: its rows' texts and the cells it states by value alone. */
const runOf = (
	name: string,
	width: number,
	rows: ReadonlyArray<ReadonlyArray<CellSketch>>
): Run => {
	const merged: MergedCells = new Map(
		Arr.flatMap(rows, (row, r) => {
			const cells = Arr.flatMap(row, (c, i) => (isMerged(c) ? [i] : []))
			return cells.length === 0 ? [] : [[r, new Set(cells)] as const]
		})
	)
	return {
		name,
		statements: [
			{
				label: "main",
				columns: Arr.map(indices(width), (i) => `c${i}`),
				types: Array.from({ length: width }, () => plainType("numeric")),
				unstated: merged.size === 0 ? { kind: "none" } : { kind: "merged", merged },
				rows: Arr.map(rows, (row) => Arr.map(row, textOf))
			}
		]
	}
}

/**
 * Whether two drawn rows may be one row: each cell's text as written, or a merged cell's class holding the other's
 * text (both merged: one class), and, for `loose`, a zero of either sign besides.
 */
const mayPair = (
	a: ReadonlyArray<CellSketch>,
	b: ReadonlyArray<CellSketch>,
	loose: boolean
): boolean =>
	Arr.every(a, (x, i) => {
		const y = b[i]
		if (y === undefined) {
			return false
		}
		const open = (c: CellSketch) => isMerged(c) || (loose && c.cls === 0)
		return open(x) || open(y) ? x.cls === y.cls : textOf(x) === textOf(y)
	})

/** The most rows of `left` paired one to one with rows of `right` they may be, by trying every pairing. */
const largestPairing = (
	left: ReadonlyArray<ReadonlyArray<CellSketch>>,
	right: ReadonlyArray<ReadonlyArray<CellSketch>>,
	loose: boolean
): number => {
	const best = (i: number, used: ReadonlySet<number>): number => {
		const row = left[i]
		if (row === undefined) {
			return 0
		}
		let most = best(i + 1, used)
		for (const [j, other] of right.entries()) {
			if (!used.has(j) && mayPair(row, other, loose)) {
				most = Math.max(most, 1 + best(i + 1, new Set([...used, j])))
			}
		}
		return most
	}
	return best(0, new Set())
}

/** Pairs each left row with the first free right row it may be, never undoing a choice. */
const greedyPairing = (
	left: ReadonlyArray<ReadonlyArray<CellSketch>>,
	right: ReadonlyArray<ReadonlyArray<CellSketch>>
): number => {
	const used = new Set<number>()
	for (const row of left) {
		const j = Arr.findFirstIndex(right, (other, k) => !used.has(k) && mayPair(row, other, false))
		if (Option.isSome(j)) {
			used.add(j.value)
		}
	}
	return used.size
}

const cellGen: Gen<CellSketch> = (source) => ({
	cls: source.draw(int(0, classes.length - 1)),
	spelling: source.draw(int(0, 2)),
	merged: source.draw(boolean)
})

type MergedSketch = readonly [
	number,
	ReadonlyArray<ReadonlyArray<CellSketch>>,
	ReadonlyArray<ReadonlyArray<CellSketch>>
]

const mergedSketchGen: Gen<MergedSketch> = (source) => {
	const width = source.draw(int(1, 2))
	const rows = array(array(cellGen, { min: width, max: width }), { min: 0, max: 3 })
	return [width, source.draw(rows), source.draw(rows)] as const
}

const cell = (cls: number, spelling: number, merged: boolean): CellSketch => ({
	cls,
	spelling,
	merged
})

/** The value classes of several spellings, the only ones whose cells a run can state by value alone. */
const mergeable = nonEmptyList(
	Arr.filter(indices(classes.length), (cls) => classAt(cls).length > 1),
	"the value classes of several spellings"
)

/** Two different spellings of the class `cls`, in either order. */
const twoSpellings =
	(cls: number): Gen<readonly [number, number]> =>
	(source) => {
		const count = classAt(cls).length
		const first = source.draw(int(0, count - 1))
		return [first, (first + source.draw(int(1, count - 1))) % count] as const
	}

/** A cell that may be one row with `base` as written: its class and spelling, or its class merged in any spelling. */
const agreeing =
	(base: CellSketch): Gen<CellSketch> =>
	(source) => {
		const merged = source.draw(boolean)
		return { cls: base.cls, spelling: merged ? source.draw(int(0, 2)) : base.spelling, merged }
	}

/**
 * The columns of a constructed case: a base cell for each of one or two columns, and the column `at` whose cells decide
 * the situation. In every other column each row holds a cell agreeing with the column's base, so all rows agree there.
 */
interface Columns {
	readonly at: number
	readonly bases: ReadonlyArray<CellSketch>
}

const columnsGen: Gen<Columns> = (source) => {
	const bases = source.draw(array(cellGen, { min: 1, max: 2 }))
	return { at: source.draw(int(0, bases.length - 1)), bases }
}

/** A row over `columns`: `decides` at the deciding column, and a cell agreeing with the base in every other. */
const rowOf =
	(columns: Columns, decides: CellSketch): Gen<ReadonlyArray<CellSketch>> =>
	(source) =>
		Arr.map(columns.bases, (base, i) => (i === columns.at ? decides : source.draw(agreeing(base))))

/**
 * Two rows on each side that only an augmenting path pairs whole, which the population draws about one case in 6,000.
 * At the deciding column: the first left row a merged cell of a class of several spellings, the second the class in one
 * spelling as written, the first right row a cell agreeing with the second left row, and the second right row another
 * spelling as written. The first left row may be either right row and the second only the first, so pairing in order
 * strands the second left row.
 */
const augmentingGen: Gen<MergedSketch> = (source) => {
	const columns = source.draw(columnsGen)
	const cls = source.draw(element(mergeable))
	const [first, second] = source.draw(twoSpellings(cls))
	const written = cell(cls, first, false)
	const row = (decides: CellSketch) => source.draw(rowOf(columns, decides))
	return [
		columns.bases.length,
		[row(cell(cls, source.draw(int(0, 2)), true)), row(written)],
		[row(source.draw(agreeing(written))), row(cell(cls, second, false))]
	] as const
}

/**
 * A row on each side told apart only by the sign of a zero neither states by value alone, which the population draws
 * about one case in 130: at the deciding column a zero (the first class) of one sign against the other.
 */
const signGen: Gen<MergedSketch> = (source) => {
	const columns = source.draw(columnsGen)
	const [left, right] = source.draw(twoSpellings(0))
	return [
		columns.bases.length,
		[source.draw(rowOf(columns, cell(0, left, false)))],
		[source.draw(rowOf(columns, cell(0, right, false)))]
	] as const
}

/** The population, and beside it, each one case in 22, the two situations it draws too rarely for a run's cases. */
const mergedDrawGen: Gen<MergedSketch> = weighted([
	[20, mergedSketchGen],
	[1, augmentingGen],
	[1, signGen]
])

/**
 * Planted: a sign lost and a sign invented in an unmerged cell, alone and beside a merged cell, a merged zero against
 * the other sign, and two merged rows of which the first agrees with both rows of the other run, so pairing it first
 * with the wrong one strands the second.
 */
const mergedKept: ReadonlyArray<Kept<MergedSketch, MergedFeature>> = [
	{
		note: "an unmerged -0 against 0",
		sketch: [1, [[cell(0, 1, false)]], [[cell(0, 0, false)]]],
		draws: "",
		reaches: ["a zero's sign told apart in an unmerged cell"]
	},
	{
		note: "an unmerged 0 against -0",
		sketch: [1, [[cell(0, 0, false)]], [[cell(0, 1, false)]]],
		draws: "",
		reaches: ["a zero's sign told apart in an unmerged cell"]
	},
	{
		note: "(merged 1, -0) against (1.0, 0)",
		sketch: [2, [[cell(1, 0, true), cell(0, 1, false)]], [[cell(1, 1, false), cell(0, 0, false)]]],
		draws: "",
		reaches: ["a zero's sign told apart in an unmerged cell"]
	},
	{
		note: "(merged 1, 0) against (1.0, -0)",
		sketch: [2, [[cell(1, 0, true), cell(0, 0, false)]], [[cell(1, 1, false), cell(0, 1, false)]]],
		draws: "",
		reaches: ["a zero's sign told apart in an unmerged cell"]
	},
	{
		note: "a merged 0 against -0",
		sketch: [1, [[cell(0, 0, true)]], [[cell(0, 1, false)]]],
		draws: "",
		reaches: ["paired only up to a merged spelling"]
	},
	{
		note: "(merged 1, 1.0) and (1.0, merged 1) against (1.0, 1.0) and (1.00, 1.0)",
		sketch: [
			2,
			[
				[cell(1, 0, true), cell(1, 1, false)],
				[cell(1, 1, false), cell(1, 0, true)]
			],
			[
				[cell(1, 1, false), cell(1, 1, false)],
				[cell(1, 2, false), cell(1, 1, false)]
			]
		],
		draws: "",
		reaches: ["paired only up to a merged spelling", "a pairing only an augmenting path finds"]
	}
]

const texts = (run: Run) =>
	Arr.sort(
		Arr.flatMap(run.statements, (s) => Arr.map(s.rows, (r) => Arr.join(r, "\u0000"))),
		Order.String
	)

describe("raw text runs with merged cells", () => {
	it.effect(
		"pair rows one to one where they agree, a merged cell up to its spelling and every other cell as written",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-runner/compare-merged",
						draw: sketched(mergedDrawGen, (s) => s),
						literal: Formatter.format,
						features: features<MergedFeature>([
							"paired only up to a merged spelling",
							"a zero's sign told apart in an unmerged cell",
							"a pairing only an augmenting path finds"
						]),
						kept: mergedKept,
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([width, left, right], c) =>
						Effect.sync(() => {
							const comparison = compareRuns(
								runOf("left", width, left),
								runOf("right", width, right)
							)
							const paired = largestPairing(left, right, false)
							const missing = Arr.reduce(
								comparison.diffs,
								0,
								(n, d) => n + Arr.reduce(d.missing, 0, (m, e) => m + e.count)
							)
							const extra = Arr.reduce(
								comparison.diffs,
								0,
								(n, d) => n + Arr.reduce(d.extra, 0, (m, e) => m + e.count)
							)
							assert.deepEqual(comparison.structural, [])
							assert.equal(comparison.equal, paired === left.length && paired === right.length)
							assert.equal(missing, left.length - paired)
							assert.equal(extra, right.length - paired)
							if (
								comparison.equal &&
								Arr.join(texts(runOf("left", width, left)), "\u0001") !==
									Arr.join(texts(runOf("right", width, right)), "\u0001")
							) {
								c.note("paired only up to a merged spelling")
							}
							if (largestPairing(left, right, true) > paired) {
								c.note("a zero's sign told apart in an unmerged cell")
							}
							if (greedyPairing(left, right) < paired) {
								c.note("a pairing only an augmenting path finds")
							}
						})
				)
			)
	)
})
