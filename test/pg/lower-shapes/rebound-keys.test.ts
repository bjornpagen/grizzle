/**
 * A fold a read reaches at a variable bound to columns of two refinements is computed at that variable's keys, so a
 * read of one learner's sitting reads that learner's rows alone however many learners the store holds beside it
 * (check/checker.ts RuleCheck `#equated`, the pair one class of its region, which the key analysis's crossing reads,
 * lower/shapes/share/keys.ts KeyAnalysis). metis's submit, before: its sitting's learner, bound first at the
 * signed-in person's refinement, was equated with the ledger's learner by a filter, which joined no class, and its
 * reads of each item's presentations and the sitting's moments were keyed at the item and the stage alone: every
 * learner's moments of the stage, once per item, 403k pages a call at 41,227 sittings.
 *
 * On PostgreSQL 19, a ledger in small (rebound-keys.fixtures.ts): learners' claims of their sittings, at another
 * refinement than the ledger's learner, each sitting's presentations of its test's items and its moments, a few dozen
 * learners and then a few hundred, each load standing every table in a drawn pg_class state (test/support/advice.ts
 * PgClassState: never vacuumed, counted empty, analyzed, skewed, large); the read of one claimed sitting's items' last
 * span ends, metis's ItemDuration over presentedSpans, run under the advice it carries.
 *
 * Oracle: a bound, the read's scans read at most three times the sitting's own rows however many learners stand beside
 * it, in every pg_class state: stored relations' rows and CTE scans' with what their filters removed.
 *
 * Features: each pg_class state, beside a few learners and beside many.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type DurationsFeature,
	durationsGen,
	durationsTemplate,
	runDurations
} from "#test/pg/lower-shapes/rebound-keys.fixtures.ts"
import { pgClassStates } from "#test/support/advice.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A read of one learner's sitting, its learner first bound at another refinement than the ledger's, reads that
 * sitting's rows alone however many learners the store holds beside it, in every pg_class state.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aReadOfOneLearnersSittingBoundAtAnotherRefinementReadsItsOwnRowsAlone =
	property.explore(durationsGen, {
		needs: { stored: Substrate.rolledBack(durationsTemplate) },
		situations: [
			"beside a few learners",
			"beside many learners",
			...Arr.map(pgClassStates, (state) => `every table ${state}` as const)
		] satisfies ReadonlyArray<Reached<DurationsFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runDurations(value.installed, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "bound: the read's scans read at most three times the sitting's own rows, stored relations' and CTE scans' with what their filters removed, beside a few dozen learners and beside a few hundred, in every pg_class state"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tthis.#filters = [...this.#filters, ...owed]\n",
				replacement:
					"\t\tthis.#filters = [...this.#filters, ...joined, ...owed]\n\t\tthis.#equated.length = 0\n",
				why: "The learner's hidden twin is equated with it by the rule's filter, which joins no class: the folds are keyed at the item and the stage alone, and the read reads every learner's presentations and moments of the stage."
			}
		]
	})
