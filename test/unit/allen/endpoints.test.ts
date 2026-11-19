/**
 * The endpoint view of the Allen relations (allen/mask.ts allenPlaces, allen/endpoints.ts), over every ordered pair of
 * spans of both verification universes (test/support/oracle/allen.ts), each classified into its one basic relation:
 *
 * - Places: each relation's places of A's endpoints among B's are where the pair's endpoints lie by arithmetic.
 * - Endpoint masks: every comparison of an endpoint of A with one of B, and every membership of an endpoint of A in B,
 *   holds of the pair exactly when its mask holds the pair's relation.
 *
 * Oracle: the specification, the endpoints compared as integers. Features, required in the space: every relation of
 * each type; every endpoint predicate held and failed.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { endpointMask, pointInMask } from "#compiler/allen/endpoints.ts"
import { allenPlaces } from "#compiler/allen/mask.ts"
import { allenRelations } from "#compiler/core/allen.ts"
import { rangeTypes, spanText } from "#test/support/oracle/allen.ts"
import {
	bound,
	compares,
	ends,
	holds,
	type PlaceFeature,
	pointPlaceOf,
	type PredicateFeature,
	predicates,
	predicateSituations,
	typedPairs
} from "#test/unit/allen/endpoints.fixtures.ts"

/** The relations' places are where every pair's endpoints lie among the other's, over every ordered pair of both universes. */
export const theRelationsPlacesAreWhereEveryPairsEndpointsLieAmongTheOthersOverEveryOrderedPairOfBothUniverses =
	property.exhaust(finite(typedPairs), {
		needs: {},
		situations: Arr.flatMap(rangeTypes, (type) =>
			Arr.map(allenRelations, (r): PlaceFeature => `${type} ${r}`)
		) satisfies ReadonlyArray<Reached<PlaceFeature>>,
		check:
			(_, c: Case<PlaceFeature>) =>
			({ type, pair }) =>
				Effect.sync(() => {
					c.note(`${type} ${pair.relation}`)
					const where = `${spanText(pair.a)} ${pair.relation} ${spanText(pair.b)}`
					assert.equal(
						allenPlaces[pair.relation].lower,
						pointPlaceOf(pair.a.lo, pair.b),
						`${where}: a0's place`
					)
					assert.equal(
						allenPlaces[pair.relation].upper,
						pointPlaceOf(pair.a.hi, pair.b),
						`${where}: a1's place`
					)
				}),
		oracle: {
			kind: "specification",
			name: "where each endpoint of A lies among B's bounds, by integer comparison"
		},
		box: "every ordered pair of spans of both verification universes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/allen/mask.ts",
				original: "\tmeets: { lower: 0, upper: 1 },",
				replacement: "\tmeets: { lower: 0, upper: 0 },",
				why: "meets places A's upper end before B (allen/mask.ts allenPlaces); the places property fails."
			}
		]
	})

/** The endpoint masks hold exactly for the pairs whose endpoints satisfy the predicate, over every ordered pair of both universes. */
export const theEndpointMasksHoldExactlyForThePairsWhoseEndpointsSatisfyThePredicateOverEveryOrderedPairOfBothUniverses =
	property.exhaust(finite(typedPairs), {
		needs: {},
		situations: predicateSituations satisfies ReadonlyArray<Reached<PredicateFeature>>,
		check:
			(_, c: Case<PredicateFeature>) =>
			({ pair }) =>
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
				}),
		oracle: {
			kind: "specification",
			name: "each endpoint predicate evaluated on the pair's bounds as integers"
		},
		box: "every ordered pair of spans of both verification universes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/allen/endpoints.ts",
				original: "\tle: (order) => order <= 0,",
				replacement: "\tle: (order) => order < 0,",
				why: "≤ read as < (allen/endpoints.ts); the endpoint masks property fails."
			}
		]
	})
