/** What the properties of selected-coverage.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import {
	type CalendarDate,
	dateOfDayNumber,
	dayNumber,
	firstCalendarDate,
	lastCalendarDate
} from "#compiler/ir/date.ts"
import { visits, type VisitsEndpoint } from "#test/pg/spans/laws/schemas.ts"
import { spanLawsTemplate } from "#test/pg/spans/laws/support.ts"

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
export const endpoints: {
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

export const endpointKinds: Arr.NonEmptyReadonlyArray<VisitsEndpoint> = ["bigint", "date"]

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
export const coverSketchGen: Gen<CoverSketch> = (source) => {
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
export const resolveCover = (
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
export const covers = (shifts: ReadonlyArray<Span>, visit: Span): boolean => {
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
export const literal = (endpoint: VisitsEndpoint, s: Span): string => {
	const { range, text } = endpoints[endpoint]
	return `'[${text(s.start)},${text(s.end)})'::${range}`
}

export type Where = "from the lower limit" | "to the upper limit" | "inside the limits"

export type CoverFeature = `${VisitsEndpoint} ${"covered" | "refused"} ${Where}`

export const runs = 60

/**
 * Each endpoint's visits schema installed once per member (support.ts spanLawsTemplate), where the search installed
 * both once before its cases: a case seats the one its sketch draws.
 */
export const coverageTemplates = {
	bigint: spanLawsTemplate(
		import.meta,
		visits({ mutable: false, endpoint: "bigint" }),
		"covbigint"
	),
	date: spanLawsTemplate(import.meta, visits({ mutable: false, endpoint: "date" }), "covdate")
} as const
