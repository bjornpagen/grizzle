import { assert, lacks } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type AgreedFeature,
	caseOf,
	certifiedIn,
	dangles,
	optimizedIn,
	queries,
	queryNames,
	sketchGen
} from "#test/pg/recursion/graph/existence.fixtures.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Endpoint existence during deferred violations the transaction artifact of each query agrees with the reference over a violated deferred law. */
export const endpointExistenceDuringDeferredViolationsTheTransactionArtifactOfEachQueryAgreesWithTheReferenceOverAViolatedDeferredLaw =
	property.explore(sketchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: Arr.map(
			queryNames,
			(q): AgreedFeature => `${q} agreed over a dangling edge`
		) satisfies ReadonlyArray<Reached<AgreedFeature>>,
		/**
		 * Its search budget: 13 runs of its rotating stream, so a floor of 4 (a quarter of the runs, rounded up), and no
		 * steered case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed
		 * reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/graph/existence.test.ts's property, its search
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
		 * @workload this property at { runs, steered } of { 16, 32 }, its pre-conversion budget (existence.test.ts at
		 *   4fbc3e95), then { 5, 2000 }, { 9, 2000 }
		 * @result At { 16, 32 }, 20 cases at f1bf91a2f's gate, its kill went red on floor case 1. Green, every required
		 *   situation reached by a witness, and every kill killed at { 5, 2000 } (23 cases, 16 steered); { 9, 2000 } (28
		 *   cases, 16 steered); and at { 13, 0 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 13 and steered 0, the fewest cases measured: a floor of 4 reaches every situation with no steered
		 *   case, where floors of 2 and 3 need 16 steered cases; its kill needs a floor of 2 at least, and is killed at every
		 *   budget measured. The steered phase stops once every situation is reached, so its cap costs no case beyond those
		 *   it runs. No headroom: a run that reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 13, steered: 0 },
		check:
			({ tx }, c: Case<AgreedFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const schema = yield* seat.schema("deferred")

							const labelled = caseOf(k.query, queries[k.query], k.network, k.person)
							const outcome = yield* runLabelledOracle(
								labelled,
								optimizedIn("transaction"),
								reference,
								{
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								}
							)
							assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
							const agreed = yield* runLabelledOracle(
								labelled,
								optimizedIn("transaction"),
								conservative,
								{
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								}
							)
							assert.equal(agreed.comparison.equal, true, printOutcome(agreed))
							lacks(certifiedIn(labelled, "transaction"), "R03.elimination")
							c.note(
								`${k.query} agreed over ${dangles(k.network) ? "a dangling edge" : "a lawful state"}`
							)
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator and the conservative lowering over the same state, its deferred laws perhaps violated"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/evidence.ts",
				original: '\ttransaction: ["immediate", "queryLocal"]',
				replacement: '\ttransaction: ["immediate", "committedSnapshot", "queryLocal"]',
				why: "A transaction admits committed-snapshot evidence (ir/evidence.ts admits), so a deferred containment, which may be false before COMMIT, proves existence inside a transaction."
			}
		]
	})
