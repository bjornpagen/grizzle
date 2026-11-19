import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
/**
 * Endpoint spellings of span relations on PostgreSQL 19: the optimized artifact's normal form of a predicate over
 * spans' endpoints (lower, upper, a computed span, the window parameter) selects exactly what PostgreSQL selects for the
 * predicate as spelled.
 *
 * - Exhausted: every endpoint predicate over a pair of spans, its negation, and every two of them joined, on each range
 *   type, over facts at the window and at the type's limits.
 * - Searched: generated trees of span predicates, Allen formulas beside endpoint predicates over the same pair, the
 *   window parameter, comparisons within one span, predicates over no span, negations, and two pairs alike but for
 *   their computed span.
 *
 * The oracle is PostgreSQL evaluating the predicate as spelled, over the same facts and parameters.
 *
 * Features: each type rewritten, and selecting every fact, none and some; each tree shape above.
 */
import { Effect, Formatter, Array as Arr } from "effect"
import {
	pairsTemplate,
	runCase,
	type GeneratedFeature,
	caseGen,
	generatedFeatures,
	exhaustiveCases,
	pairsIn,
	selection,
	type ExhaustiveFeature
} from "#test/pg/spans/allen/endpoints.fixtures.ts"
import { rangeTypes } from "#test/support/oracle/allen.ts"
import { seatedOracleProperty } from "#test/support/oracle/runner.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Endpoint spellings of span relations on PostgreSQL 19 select in the optimized artifact exactly what PostgreSQL
 * selects for generated trees of span predicates, each case on the worker's seat of the filled pair template.
 *
 * Its pre-conversion budget: runs 300, coverage cases 300 (test/pg/spans/allen/endpoints.test.ts at f2a727cba).
 */
export const endpointSpellingsOfSpanRelationsOnPostgreSQL19SelectInTheOptimizedArtifactExactlyWhatPostgreSQLSelectsForGeneratedTreesOfSpanPredicates =
	seatedOracleProperty({ pairs: pairsTemplate }, () => "pairs", caseGen, {
		situations: [
			"rewritten",
			"an endpoint predicate beside an Allen formula over its pair",
			"a pair with the parameter",
			"a comparison within one span",
			"a predicate over no span",
			"under a negation",
			"two pairs alike but for their computed span"
		],
		perturb: "none",
		oracle: {
			kind: "postgresql",
			name: "the predicate as spelled, evaluated by PostgreSQL over the same facts"
		},
		budget: { runs: 300, steered: 300 },
		kept: [],
		kills: [],
		show: Formatter.format,
		check: (k, installed) => (c) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const db = yield* s.session({ ...ownerSession(), label: "owner" })
				return yield* Effect.map(runCase(installed, db, c), (ran) => {
					const reached = new Set<GeneratedFeature>()
					generatedFeatures(c.pred, false, reached)
					if (ran.rewritten) {
						reached.add("rewritten")
					}
					k.noteAll(reached)
				})
			})
	})

/**
 * Endpoint spellings of span relations on PostgreSQL 19 select in the optimized artifact exactly what PostgreSQL
 * selects for the spelling, for every endpoint predicate over a pair, its negation and every two of them joined, each
 * case on the worker's seat of the filled pair template.
 */
export const endpointSpellingsOfSpanRelationsOnPostgreSQL19SelectInTheOptimizedArtifactExactlyWhatPostgreSQLSelectsForTheSpellingForEveryEndpointPredicateOverAPairItsNegationAndEveryTwoOfThemJoined =
	property.exhaust(finite(exhaustiveCases), {
		box: "every endpoint predicate over a pair, its negation and every two of them joined, on each range type",
		needs: { pairs: Substrate.seat(pairsTemplate) },
		situations: Arr.flatMap(rangeTypes, (carrier): Arr.NonEmptyReadonlyArray<ExhaustiveFeature> => [
			`${carrier} rewritten`,
			`${carrier} every fact`,
			`${carrier} no fact`,
			`${carrier} some facts`
		]),
		check:
			({ pairs }, k: Case<ExhaustiveFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.gen(function* () {
						const { installed, db } = yield* Effect.flatMap(pairs, pairsIn)
						return yield* Effect.map(runCase(installed, db, c), (ran) => {
							k.note(`${c.carrier} ${selection(c.carrier, ran.selected)}`)
							if (ran.rewritten) {
								k.note(`${c.carrier} rewritten`)
							}
						})
					})
				),
		oracle: {
			kind: "postgresql",
			name: "the predicate as spelled, evaluated by PostgreSQL over the same facts"
		},
		kept: [],
		kills: []
	})
