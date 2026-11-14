/**
 * Selected-source span coverage at the limits of a span's stored domain, over bigint and over date endpoints, native: a
 * billable visit is accepted exactly when the union of its site's shifts contains its span, and refused otherwise with
 * 23503 on the PERIOD foreign key from the visit's range law column into Shift's WITHOUT OVERLAPS key (fin.md §7), at
 * its statement.
 *
 * The oracle is a second implementation: `covers`, a sweep over the disjoint shifts in order, over the endpoint's
 * values as bigints (a date as its day number, the order of dates). The box is an endpoint, bigint or date, a cover cut
 * at distinct points of its `points` (pointsAround: the domain's limits and the points beside them, and an inside value
 * and the points beside it: int8's limits and zero, a date's 0001-01-01, 9999-12-31 and leap day), each piece dropped
 * one time in four, and a nonempty visit between two of the points, required to reach, over each endpoint, a
 * covered and a refused visit from the lower limit, to the upper limit and inside them.
 *
 * These edges stay a suite of their own rather than kept cases of the span-coverage box (test/support/laws/boxes.ts
 * spanCoverage): that harness's host model spells a span's ends as JavaScript numbers
 * (test/support/laws/model.ts Span), which hold no int8 limit exactly and no date, so the limits can be stated only
 * here, as int8range and daterange literals.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): period-fk-not-enforced.patch (every PERIOD foreign key installed NOT
 * ENFORCED, so a visit outside its site's shifts is accepted).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, map, shuffled } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import {
	type CalendarDate,
	dateOfDayNumber,
	dayNumber,
	firstCalendarDate,
	lastCalendarDate
} from "#compiler/ir/date.ts"
import { type VisitsEndpoint, visits, visitsLaw } from "#test/pg/spans/laws/schemas.ts"
import { installSpans, writerOf } from "#test/pg/spans/laws/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const int8Min = -(2n ** 63n)
const int8Max = 2n ** 63n - 1n

/** A date's day number, as a bigint. */
const day = (date: CalendarDate): bigint => BigInt(dayNumber(date))

/**
 * The points a cover is cut at and a visit ends at, in order: the domain's least value and the one after it, the
 * values within one of an inside value it branches on, and the one before its greatest value and that value.
 */
const pointsAround = (
	least: bigint,
	inside: bigint,
	greatest: bigint
): Arr.NonEmptyReadonlyArray<bigint> => [
	least,
	least + 1n,
	inside - 1n,
	inside,
	inside + 1n,
	greatest - 1n,
	greatest
]

/**
 * Each endpoint's points, around its domain's limits and an inside value: int8's limits and zero, and a date's
 * 0001-01-01 and 9999-12-31 and the leap day 2024-02-29, as day numbers. Its range type, and the text of a point as the
 * range's input reads it.
 */
const endpoints: {
	readonly [E in VisitsEndpoint]: {
		readonly points: Arr.NonEmptyReadonlyArray<bigint>
		readonly range: string
		readonly text: (point: bigint) => string
	}
} = {
	bigint: { points: pointsAround(int8Min, 0n, int8Max), range: "int8range", text: String },
	date: {
		points: pointsAround(day(firstCalendarDate), day("2024-02-29"), day(lastCalendarDate)),
		range: "daterange",
		text: dateOfDayNumber
	}
}

const endpointKinds: Arr.NonEmptyReadonlyArray<VisitsEndpoint> = ["bigint", "date"]

/**
 * One drawn cover and visit: its endpoint, the indices into the endpoint's `points` of the cover's cuts, which pieces
 * are dropped, and the visit's two ends.
 */
interface CoverSketch {
	readonly endpoint: VisitsEndpoint
	readonly cuts: ReadonlyArray<number>
	readonly dropped: ReadonlyArray<boolean>
	readonly visit: readonly [number, number]
}

/**
 * A cover's cuts are distinct points in the order drawn, and a visit's two ends distinct points, so every sketch drawn
 * plants a nonempty visit.
 */
const coverSketchGen: Gen<CoverSketch> = (source) => {
	const endpoint = source.draw(element(endpointKinds))
	const { points } = endpoints[endpoint]
	const first = source.draw(int(0, points.length - 1))
	const other = source.draw(int(0, points.length - 2))
	return {
		endpoint,
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

/**
 * The shifts a sketch plants, the pieces between consecutive cuts it keeps, and its visit, a nonempty span; none when
 * its ends meet.
 */
const resolveCover = (
	sketch: CoverSketch
): { readonly shifts: ReadonlyArray<Span>; readonly visit: Span } | "no visit" => {
	const { points } = endpoints[sketch.endpoint]
	const point = (i: number) => defined(points[i], `the point ${i}`)
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

/** A span's literal over its endpoint's range type. */
const literal = (endpoint: VisitsEndpoint, s: Span): string => {
	const { range, text } = endpoints[endpoint]
	return `'[${text(s.start)},${text(s.end)})'::${range}`
}

type Where = "from the lower limit" | "to the upper limit" | "inside the limits"
type CoverFeature = `${VisitsEndpoint} ${"covered" | "refused"} ${Where}`

const runs = 60

layer(Substrate.layer)(
	"selected-source span coverage at the limits of bigint and date spans",
	(it) => {
		it.effect(
			"a billable visit is accepted iff the union of its site's shifts contains it, at the limits of its endpoint",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const installOf = (endpoint: VisitsEndpoint) =>
							Effect.gen(function* () {
								const install = yield* installSpans(
									visits({ mutable: false, endpoint }),
									`cov${endpoint}`
								)
								return {
									install,
									writer: yield* writerOf(install, `writer ${endpoint}`),
									foreignKey: install.periodForeignKey(visitsLaw(endpoint))
								}
							})
						const installed = yield* Effect.all({
							bigint: installOf("bigint"),
							date: installOf("date")
						})
						return yield* explore(
							{
								oracle: {
									kind: "second-implementation",
									name: "a sweep over the disjoint shifts in order, over the endpoint's values"
								},
								suite: "spans/selected-coverage-limits",
								draw: drawn(coverSketchGen),
								literal: Formatter.format,
								kept: [],
								runs,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang,
								coverage: required<CoverFeature>(
									Arr.flatMap(endpointKinds, (endpoint) =>
										Arr.flatMap(["covered", "refused"] as const, (o) =>
											Arr.map(
												[
													"from the lower limit",
													"to the upper limit",
													"inside the limits"
												] as const,
												(where): CoverFeature => `${endpoint} ${o} ${where}`
											)
										)
									),
									{ cases: runs, sense: notesOnly }
								)
							},
							(sketch, c) =>
								Effect.gen(function* () {
									const resolved = resolveCover(sketch)
									if (resolved === "no visit") {
										return
									}
									const { points } = endpoints[sketch.endpoint]
									const { install, writer, foreignKey } = installed[sketch.endpoint]
									const expected = covers(resolved.shifts, resolved.visit)
									const where: Where =
										resolved.visit.start === Arr.headNonEmpty(points)
											? "from the lower limit"
											: resolved.visit.end === Arr.lastNonEmpty(points)
												? "to the upper limit"
												: "inside the limits"
									c.note(`${sketch.endpoint} ${expected ? "covered" : "refused"} ${where}`)
									yield* replaceRows(
										s.admin,
										install.group,
										resolved.shifts.length === 0
											? []
											: [
													{
														sql: `INSERT INTO ${install.table("Shift")} VALUES ${Arr.join(
															Arr.map(
																resolved.shifts,
																(x, i) => `(1, ${literal(sketch.endpoint, x)}, ${i})`
															),
															", "
														)}`,
														params: []
													}
												]
									)
									const insert = writer.query(
										`INSERT INTO ${install.table("Visit")} VALUES (1, 1, ${literal(sketch.endpoint, resolved.visit)}, true)`,
										[]
									)
									if (expected) {
										yield* insert
									} else {
										const refused = yield* expectSqlstate(insert, "23503")
										assert.equal(refused.constraint, foreignKey)
									}
								})
						)
					})
				)
		)
	}
)
