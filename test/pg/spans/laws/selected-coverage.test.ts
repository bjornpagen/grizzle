import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, map, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order } from "effect"
import { visits, visitsLaw } from "#test/pg/spans/laws/schemas.ts"
import { installSpans, witness, writerOf } from "#test/pg/spans/laws/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const int8Min = -(2n ** 63n)
const int8Max = 2n ** 63n - 1n

/** The points a cover is cut at and a visit ends at: the int8 limits, the points beside them, and a few inside. */
const points: ReadonlyArray<bigint> = [int8Min, int8Min + 1n, -1n, 0n, 1n, int8Max - 1n, int8Max]

/**
 * One drawn cover and visit: the indices into `points` of the cover's cuts, which pieces are dropped, and the visit's
 * two ends.
 */
interface CoverSketch {
	readonly cuts: ReadonlyArray<number>
	readonly dropped: ReadonlyArray<boolean>
	readonly visit: readonly [number, number]
}

/**
 * A cover's cuts are distinct points in the order drawn, and a visit's two ends distinct points, so every sketch drawn
 * plants a nonempty visit.
 */
const coverSketchGen: Gen<CoverSketch> = (source) => {
	const first = source.draw(int(0, points.length - 1))
	const other = source.draw(int(0, points.length - 2))
	return {
		cuts: source.draw(
			shuffled(
				Arr.map(points, (_, i) => i),
				{ min: 2, max: points.length }
			)
		),
		/** A piece dropped one time in four, a gap in the cover. */
		dropped: source.draw(
			array(
				map(int(0, 3), (n) => n === 0),
				{ min: points.length, max: points.length }
			)
		),
		visit: [first, other >= first ? other + 1 : other]
	}
}

interface Span {
	readonly start: bigint
	readonly end: bigint
}

const point = (i: number) => defined(points[i], `the point ${i}`)

/**
 * The shifts a sketch plants, the pieces between consecutive cuts it keeps, and its visit, a nonempty span; none when
 * its ends meet.
 */
const resolveCover = (
	sketch: CoverSketch
): { readonly shifts: ReadonlyArray<Span>; readonly visit: Span } | "no visit" => {
	const cuts = Arr.sort(Arr.map(sketch.cuts, point), Order.BigInt)
	const shifts = Arr.flatMap(cuts.slice(1), (end, i) => {
		const start = defined(cuts[i], `the cut ${i}`)
		return defined(sketch.dropped[i], `the drop of piece ${i}`) ? [] : [{ start, end }]
	})
	const [a, b] = [point(sketch.visit[0]), point(sketch.visit[1])]
	if (a === b) {
		return "no visit"
	}
	return { shifts, visit: a < b ? { start: a, end: b } : { start: b, end: a } }
}

/** Whether the union of `shifts`, disjoint and in order, contains `visit`. */
const covers = (shifts: ReadonlyArray<Span>, visit: Span): boolean => {
	let reached = visit.start
	for (const s of shifts) {
		if (s.start > reached) {
			break
		}
		if (s.end > reached) {
			reached = s.end
		}
		if (reached >= visit.end) {
			return true
		}
	}
	return reached >= visit.end
}

const literal = (s: Span): string => `'[${s.start},${s.end})'::int8range`

type CoverFeature =
	`${"covered" | "refused"} ${"from the lower limit" | "to the upper limit" | "inside the limits"}`

/**
 * Planted: a visit covered from the lower limit and one covered to the upper limit, each by one shift, which the drawn
 * covers reach a few times a run.
 */
const kept = (
	note: string,
	cuts: ReadonlyArray<number>,
	visit: readonly [number, number],
	reaches: CoverFeature
) => ({
	note,
	sketch: { cuts, dropped: Arr.map(points, () => false), visit },
	draws: "",
	reaches: [reaches] as const
})

const coverKept: ReadonlyArray<Kept<CoverSketch, CoverFeature>> = [
	kept("[min, 0) over one shift", [0, 3], [0, 3], "covered from the lower limit"),
	kept("[1, max) over one shift", [3, 6], [4, 6], "covered to the upper limit")
]

layer(Substrate.layer)("selected-source span coverage at the int8 limits", (it) => {
	it.effect(
		"a billable visit is accepted iff the union of its site's shifts contains it, at the int8 limits",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const install = yield* installSpans(visits({ mutable: false }), "covlimits")
					const w = yield* writerOf(install, "writer")
					const law = install.residual(visitsLaw)
					const shift = install.table("Shift")
					const visit = install.table("Visit")
					return yield* explore(
						{
							suite: "spans/selected-coverage-limits",
							draw: drawn(coverSketchGen),
							literal: Formatter.format,
							kept: coverKept,
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2),
							coverage: required<CoverFeature>(
								Arr.flatMap(["covered", "refused"] as const, (o) =>
									Arr.map(
										["from the lower limit", "to the upper limit", "inside the limits"] as const,
										(where): CoverFeature => `${o} ${where}`
									)
								),
								{ cases: 60, sense: notesOnly }
							)
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const resolved = resolveCover(sketch)
								if (resolved === "no visit") {
									return
								}
								const expected = covers(resolved.shifts, resolved.visit)
								const where =
									resolved.visit.start === int8Min
										? "from the lower limit"
										: resolved.visit.end === int8Max
											? "to the upper limit"
											: "inside the limits"
								c.note(`${expected ? "covered" : "refused"} ${where}`)
								yield* replaceRows(
									s.admin,
									install.group,
									resolved.shifts.length === 0
										? []
										: [
												{
													sql: `INSERT INTO ${shift} VALUES ${Arr.join(
														Arr.map(resolved.shifts, (x, i) => `(1, ${literal(x)}, ${i})`),
														", "
													)}`,
													params: []
												}
											]
								)
								const insert = w.query(
									`INSERT INTO ${visit} VALUES (1, 1, ${literal(resolved.visit)}, true)`,
									[]
								)
								if (expected) {
									yield* insert
								} else {
									const refused = yield* expectSqlstate(insert, "23000")
									assert.equal(refused.constraint, visitsLaw)
									assert.deepEqual(witness(law, refused.detail), ["1"])
								}
							})
					)
				})
			)
	)
})
