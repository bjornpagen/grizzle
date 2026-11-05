/**
 * Coverage's model (fin.md §7), the specification turned into a checker, shared by the substrate's proof of the
 * lowering (temporal.test.ts) and grizzle's lowering's (test/pg/laws/coverage.test.ts): spans are half-open integer
 * intervals over the box's points, a target key refuses an empty span and two spans of one key that overlap, and a
 * source row is covered when its span is NULL, or non-empty and inside the union of its key's target spans.
 */
import { Array as Arr, Option } from "effect"
import { indices } from "#compiler/core/array.ts"
import { nonEmpty } from "#test/support/assert.ts"

/** A row's span: an interval [lo, hi) of the box's points, empty where lo = hi, or NULL outside φ. */
export type Span =
	| { readonly kind: "null" }
	| { readonly kind: "span"; readonly lo: number; readonly hi: number }

/** The box's points. */
const points = [0, 1, 2, 3] as const

/** Every non-empty interval over the box's points. */
export const INTERVALS: Arr.NonEmptyReadonlyArray<Span> = nonEmpty(
	Arr.flatMap(points, (lo) =>
		Arr.map(
			Arr.filter(points, (hi) => hi > lo),
			(hi): Span => ({ kind: "span", lo, hi })
		)
	)
)

/** Every span a row of the box may hold: the intervals, an empty one, and NULL. */
export const SPANS: Arr.NonEmptyReadonlyArray<Span> = [
	...INTERVALS,
	{ kind: "span", lo: 1, hi: 1 },
	{ kind: "null" }
]

export const isEmpty = (s: Span): boolean => s.kind === "span" && s.lo === s.hi

export const overlaps = (a: Span, b: Span): boolean =>
	a.kind === "span" && b.kind === "span" && a.lo < b.hi && b.lo < a.hi && !isEmpty(a) && !isEmpty(b)

/** A row of either table: its key and its span. */
export interface Row {
	readonly k: number
	readonly span: Span
}

/** Whether a source row is covered by the target rows: NULL, or non-empty and inside its key's union. */
export const covered = (targets: ReadonlyArray<Row>, source: Row): boolean => {
	if (source.span.kind === "null") {
		return true
	}
	const { lo, hi } = source.span
	return (
		lo < hi &&
		Arr.every(
			Arr.filter(indices(hi), (p) => p >= lo),
			(p) =>
				Arr.some(
					targets,
					(t) => t.k === source.k && t.span.kind === "span" && t.span.lo <= p && p < t.span.hi
				)
		)
	)
}

/**
 * What the target key does with rows inserted in order: the first row whose span is empty (23514, which PostgreSQL
 * raises with no constraint named: executor/execIndexing.c), or that overlaps an earlier row of its key (23P01, the
 * key's exclusion), or none.
 */
export const keyRefusal = (rows: ReadonlyArray<Row>): Option.Option<"23514" | "23P01"> => {
	for (const [i, row] of rows.entries()) {
		if (row.span.kind === "span" && isEmpty(row.span)) {
			return Option.some("23514")
		}
		if (
			Arr.some(
				rows.slice(0, i),
				(earlier) => earlier.k === row.k && overlaps(earlier.span, row.span)
			)
		) {
			return Option.some("23P01")
		}
	}
	return Option.none()
}
