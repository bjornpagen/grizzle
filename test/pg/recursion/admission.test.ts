import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type AgreedFeature,
	caseOfSketch,
	recursions,
	sketchGen
} from "#test/pg/recursion/admission.fixtures.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Admitted recursions on PostgreSQL 19 agree with the reference evaluator as raw text sets, with no repeated row. */
export const admittedRecursionsOnPostgreSQL19AgreeWithTheReferenceEvaluatorAsRawTextSetsWithNoRepeatedRow =
	property.explore(sketchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: Arr.map(
			recursions,
			(r): AgreedFeature => `${r} agreed with rows`
		) satisfies ReadonlyArray<Reached<AgreedFeature>>,
		/**
		 * Its search budget: 5 runs of its rotating stream, so a floor of 2 (a quarter of the runs, rounded up), and no
		 * steered case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed
		 * reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/admission.test.ts's property, its search
		 * @unit cases: the rotating stream's runs, and the steered phase's most
		 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
		 *   stream
		 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
		 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
		 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
		 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged
		 *   after its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under
		 *   a verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
		 * @observed 2026-11-23 03:27 to 04:39 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
		 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
		 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
		 * @workload this property at { runs, steered } of { 12, 24 }, its pre-conversion budget (admission.test.ts at
		 *   4fbc3e95), then { 1, 2000 }, { 5, 2000 }
		 * @result At { 12, 24 }, 15 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (18 cases, 16 steered); { 5, 2000 } (7
		 *   cases, 0 steered); and at { 5, 0 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 5 and steered 0, the fewest cases of the budgets measured: a floor of 2 reaches every situation with
		 *   no steered case, where a floor of 1 needs 16; its kill is red on floor case 0 at every budget measured. The
		 *   steered phase stops once every situation is reached, so its cap costs no case beyond those it runs. No headroom:
		 *   a run that reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 5, steered: 0 },
		check:
			({ tx }, c: Case<AgreedFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const name = yield* seat.schema("admission")
							return yield* Effect.forEach(
								recursions,
								(recursion) =>
									Effect.gen(function* () {
										const outcome = yield* runLabelledOracle(
											caseOfSketch(recursion, k),
											conservative,
											reference,
											{
												...defaultRunOptions,
												schema: { kind: "named", name: name }
											}
										)
										assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
										c.note(
											Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)
												? `${recursion} agreed with rows`
												: `${recursion} agreed with none`
										)
									}),
								{ discard: true }
							)
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator over the same facts, raw text sets with no repeated row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/recursive/index.ts",
				original:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION", arms: [base, step] })',
				replacement:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] })',
				why: "The conservative lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
			}
		]
	})
