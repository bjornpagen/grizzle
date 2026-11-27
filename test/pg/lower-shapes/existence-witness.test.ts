/**
 * An existence test reads its right side per left row where that side is more than a scan of one source and its join
 * columns restrict every relation it reads (lower/conservative/semi-join/exists.ts): a step correlated inside it, the
 * side's rows at the left row with the join's equalities inside the step, read apart by the one printer of a step
 * (lower/conservative/step fencedRead, OFFSET 0), a subplan PostgreSQL never pulls up, so a test reads the right side's
 * relations at the left side's keys alone, never the whole of them. In a bare NOT EXISTS, a fold stays a grouped derived
 * table PostgreSQL never restricts by the test's keys, so it folds every group the store holds for each read
 * (rule-aggregate's probe of a GROUP BY of Attempt, 980 rows read where 2 were expected); and a right side of several
 * sources is pulled up into the anti-join, whose parameterizations of every subset of its relations PostgreSQL plans
 * (edullm's ledger grade write: 17 s for one test, past 8.5 minutes for the statement).
 *
 * On PostgreSQL 19, over a store of 2,000 to 4,000 keys of one to four facts each, two to six asked keys: the asked keys
 * no fact of the right side matches, the right side a join of two stores by the key, a fold by the key, or a fold whose
 * count the test binds, every table in each pg_class state (test/support/advice.ts PgClassState), the read as a served
 * Db of the full world runs it, under the advice it carries.
 *
 * Oracle: the host's keys, and a bound: the read's scans of the store read at most the facts at the asked keys, and one
 * more for each witness's probe of a key it does not hold, where the right side is read per left row; and the whole fold
 * once, never once per asked key, where the test binds the fold's count, which restricts no relation it reads; and the
 * plan laws over the read's flight (test/support/advice.ts servedRun).
 *
 * Features: each shape; every table in each pg_class state.
 */
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	existenceWitnessTemplate,
	runWitness,
	type WitnessFeature,
	witnessGen
} from "#test/pg/lower-shapes/existence-witness.fixtures.ts"
import { pgClassStates } from "#test/support/advice.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A read that tests a join or a fold by the test's keys reads the store at the asked keys alone, whatever the store
 * holds beside them.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/lower-shapes/existence-witness.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/lower-shapes/existence-witness.test.ts` at its
 *   budget before, the runner's, runs 150 and steered 200, its kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in
 *   ~/.cache/grizzle-release/CULL-COMPUTE/kills-existence-witness.log; this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 06:00 to 07:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at e79913b8c with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload its kill applied alone and judged on the property's witnesses: its floor stream and its steered phase,
 *   which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations or kill, of its label (the floor stream's seed), or of the runner's
 *   floor rule
 */
export const aReadThatTestsAJoinOrAFoldByTheTestsKeysReadsTheStoreAtTheAskedKeysAloneWhateverTheStoreHoldsBesideThem =
	property.explore(witnessGen, {
		needs: { stored: Substrate.rolledBack(existenceWitnessTemplate) },
		situations: [
			"the join by the key",
			"the fold by the key",
			"the fold by its count",
			...Arr.map(pgClassStates, (s) => `with every table ${s}` as const)
		] satisfies ReadonlyArray<WitnessFeature>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.flatMap(stored, (clone) => runWitness(clone, drawn, c)),
		oracle: {
			kind: "universal",
			name: "the host's asked keys the right side does not match, and bound: the read's scans of the store read at most the facts at the asked keys where the right side is read per left row, and the whole fold once where its count is bound"
		},
		budget: { runs: 1, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\treadsStored(node.right) &&\n",
				replacement: "\t\tfalse &&\n",
				why: "Every right side stays in a bare NOT EXISTS, as before: the fold by the key is a grouped derived table PostgreSQL never restricts by the test's keys, so the read folds every key the store holds, past the bound."
			}
		]
	})
