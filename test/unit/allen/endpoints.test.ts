import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { type EndpointComparison, endpointMask, pointInMask } from "#compiler/allen/endpoints.ts"
import {
	type AllenMask,
	type AllenPlace,
	type AllenRelation,
	allenMaskOf,
	allenPlaces,
	allenRelations,
	type SpanEndpoint
} from "#compiler/allen/mask.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import {
	type HalfOpen,
	type PairFacts,
	type RangeType,
	spanText,
	universe,
	universePairs
} from "#test/support/oracle/allen.ts"

const types = ["int4range", "int8range"] as const satisfies ReadonlyArray<RangeType>
const ends: Arr.NonEmptyReadonlyArray<SpanEndpoint> = ["lower", "upper"]
const comparisons: Arr.NonEmptyReadonlyArray<EndpointComparison> = [
	"eq",
	"ne",
	"lt",
	"le",
	"gt",
	"ge"
]
/** Every endpoint predicate: an endpoint of A, a comparison, an endpoint of B. */
const predicates = Arr.flatMap(ends, (x) =>
	Arr.flatMap(comparisons, (cmp) => Arr.map(ends, (y) => [x, cmp, y] as const))
)

/** Every ordered pair of both universes, with its type. */
const typedPairs: Gen<{ readonly type: RangeType; readonly pair: PairFacts }> = oneOf(
	Arr.map(types, (type) =>
		map(element(nonEmpty(universePairs(universe(type)), `the ${type} pairs`)), (pair) => ({
			type,
			pair
		}))
	)
)
/** The pairs of both universes number some 17,000; the limit guards only against their growth. */
const pairLimit = 100_000

/** A span's endpoint, its bound as PostgreSQL's lower() and upper() return it for the stored half-open value. */
const bound = (span: HalfOpen, endpoint: SpanEndpoint): bigint =>
	endpoint === "lower" ? span.lo : span.hi

const compares: { readonly [C in EndpointComparison]: (x: bigint, y: bigint) => boolean } = {
	eq: (x, y) => x === y,
	ne: (x, y) => x !== y,
	lt: (x, y) => x < y,
	le: (x, y) => x <= y,
	gt: (x, y) => x > y,
	ge: (x, y) => x >= y
}

/** Where a point lies among a span's bounds, by arithmetic: before, at, inside, at the end of, or after [lo, hi). */
const placeOf = (point: bigint, span: HalfOpen): AllenPlace =>
	point < span.lo ? 0 : point === span.lo ? 1 : point < span.hi ? 2 : point === span.hi ? 3 : 4

const holds = (mask: AllenMask, relation: AllenRelation): boolean =>
	(mask & allenMaskOf([relation])) !== 0

type PlaceFeature = `${RangeType} ${AllenRelation}`
type PredicateFeature =
	| `${SpanEndpoint} ${EndpointComparison} ${SpanEndpoint} ${"held" | "failed"}`
	| `point ${SpanEndpoint} ${"held" | "failed"}`

describe("the relations' places", () => {
	it.effect(
		"are where every pair's endpoints lie among the other's, over every ordered pair of both universes",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/allen/places",
						generator: typedPairs,
						literal: Formatter.format,
						limit: pairLimit,
						coverage: requiredInSpace<PlaceFeature>(
							Arr.flatMap(types, (type) =>
								Arr.map(allenRelations, (r): PlaceFeature => `${type} ${r}`)
							)
						),
						caseHang: Duration.minutes(2)
					},
					({ type, pair }, c) =>
						Effect.sync(() => {
							c.note(`${type} ${pair.relation}`)
							const where = `${spanText(pair.a)} ${pair.relation} ${spanText(pair.b)}`
							assert.equal(
								allenPlaces[pair.relation].lower,
								placeOf(pair.a.lo, pair.b),
								`${where}: a0's place`
							)
							assert.equal(
								allenPlaces[pair.relation].upper,
								placeOf(pair.a.hi, pair.b),
								`${where}: a1's place`
							)
						})
				)
			)
	)
})

describe("the endpoint masks", () => {
	it.effect(
		"hold exactly for the pairs whose endpoints satisfy the predicate, over every ordered pair of both universes",
		(ctx) => {
			const situations: Arr.NonEmptyReadonlyArray<PredicateFeature> = [
				...Arr.flatMap(predicates, ([x, cmp, y]): Arr.NonEmptyReadonlyArray<PredicateFeature> => [
					`${x} ${cmp} ${y} held`,
					`${x} ${cmp} ${y} failed`
				]),
				...Arr.flatMap(ends, (x): ReadonlyArray<PredicateFeature> => [
					`point ${x} held`,
					`point ${x} failed`
				])
			]
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/allen/endpoint-masks",
						generator: typedPairs,
						literal: Formatter.format,
						limit: pairLimit,
						coverage: requiredInSpace<PredicateFeature>(situations),
						caseHang: Duration.minutes(2)
					},
					({ pair }, c) =>
						Effect.sync(() => {
							const where = `${spanText(pair.a)} ${pair.relation} ${spanText(pair.b)}`
							for (const [x, cmp, y] of predicates) {
								const truth = compares[cmp](bound(pair.a, x), bound(pair.b, y))
								c.note(`${x} ${cmp} ${y} ${truth ? "held" : "failed"}`)
								assert.equal(
									holds(endpointMask(x, cmp, y), pair.relation),
									truth,
									`${where}: ${x} ${cmp} ${y}`
								)
							}
							for (const x of ends) {
								const p = bound(pair.a, x)
								const truth = pair.b.lo <= p && p < pair.b.hi
								c.note(`point ${x} ${truth ? "held" : "failed"}`)
								assert.equal(holds(pointInMask(x), pair.relation), truth, `${where}: ${x}(A) in B`)
							}
						})
				)
			)
		}
	)
})
