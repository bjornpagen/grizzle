/** What the properties of endpoints.test.ts read: its spaces, models and helpers. */

import { element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { type EndpointComparison } from "#compiler/allen/endpoints.ts"
import {
	type AllenMask,
	allenMaskOf,
	type AllenPlace,
	type SpanEndpoint
} from "#compiler/allen/mask.ts"
import { type AllenRelation } from "#compiler/core/allen.ts"
import { nonEmpty } from "#test/support/assert.ts"
import {
	type HalfOpen,
	type PairFacts,
	type RangeType,
	rangeTypes,
	universe,
	universePairs
} from "#test/support/oracle/allen.ts"

export const ends: Arr.NonEmptyReadonlyArray<SpanEndpoint> = ["lower", "upper"]

const comparisons: Arr.NonEmptyReadonlyArray<EndpointComparison> = [
	"eq",
	"ne",
	"lt",
	"le",
	"gt",
	"ge"
]

/** Every endpoint predicate: an endpoint of A, a comparison, an endpoint of B. */
export const predicates = Object.freeze(
	Arr.flatMap(ends, (x) =>
		Arr.flatMap(comparisons, (cmp) => Arr.map(ends, (y) => [x, cmp, y] as const))
	)
)

/** Every ordered pair of both universes, with its type. */
export const typedPairs: Gen<{ readonly type: RangeType; readonly pair: PairFacts }> = oneOf(
	Arr.map(rangeTypes, (type) =>
		map(element(nonEmpty(universePairs(universe(type)), `the ${type} pairs`)), (pair) => ({
			type,
			pair
		}))
	)
)

/** A span's endpoint, its bound as PostgreSQL's lower() and upper() return it for the stored half-open value. */
export const bound = (span: HalfOpen, endpoint: SpanEndpoint): bigint =>
	endpoint === "lower" ? span.lo : span.hi

export const compares: { readonly [C in EndpointComparison]: (x: bigint, y: bigint) => boolean } = {
	eq: (x, y) => x === y,
	ne: (x, y) => x !== y,
	lt: (x, y) => x < y,
	le: (x, y) => x <= y,
	gt: (x, y) => x > y,
	ge: (x, y) => x >= y
}

/** Where a point lies among a span's bounds, by arithmetic: before, at, inside, at the end of, or after [lo, hi). */
export const pointPlaceOf = (point: bigint, span: HalfOpen): AllenPlace =>
	point < span.lo ? 0 : point === span.lo ? 1 : point < span.hi ? 2 : point === span.hi ? 3 : 4

export const holds = (mask: AllenMask, relation: AllenRelation): boolean =>
	(mask & allenMaskOf([relation])) !== 0

export type PlaceFeature = `${RangeType} ${AllenRelation}`

export type PredicateFeature =
	| `${SpanEndpoint} ${EndpointComparison} ${SpanEndpoint} ${"held" | "failed"}`
	| `point ${SpanEndpoint} ${"held" | "failed"}`

/** Every endpoint predicate held and failed, and every endpoint's membership in B held and failed. */
export const predicateSituations: Arr.NonEmptyReadonlyArray<PredicateFeature> = [
	...Arr.flatMap(predicates, ([x, cmp, y]): Arr.NonEmptyReadonlyArray<PredicateFeature> => [
		`${x} ${cmp} ${y} held`,
		`${x} ${cmp} ${y} failed`
	]),
	...Arr.flatMap(ends, (x): ReadonlyArray<PredicateFeature> => [
		`point ${x} held`,
		`point ${x} failed`
	])
]
