import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	caseOfSketch,
	shapes,
	type SiteFeature,
	sketchGen
} from "#test/pg/recursion/graph/seed-sites.fixtures.ts"
import { isGraphRule, optimizedLoweringWith } from "#test/pg/recursion/graph/support.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Graph.seedPushdown at the constant and region sites against the reference each site's certificate fires and its artifact agrees with the reference and the conservative lowering. */
export const graphSeedPushdownAtTheConstantAndRegionSitesAgainstTheReferenceEachSitesCertificateFiresAndItsArtifactAgreesWithTheReferenceAndTheConservativeLowering =
	property.explore(sketchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: Arr.map(
			shapes,
			(shape): SiteFeature => `${shape} agreed with rows`
		) satisfies ReadonlyArray<Reached<SiteFeature>>,
		/**
		 * Its search budget: 9 runs of its rotating stream, so a floor of 3 (a quarter of the runs, rounded up), and no
		 * steered case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed
		 * reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/graph/seed-sites.test.ts's property, its search
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
		 * @workload this property at { runs, steered } of { 12, 24 }, its pre-conversion budget (seed-sites.test.ts at
		 *   4fbc3e95), then { 1, 2000 }, { 5, 2000 }
		 * @result At { 12, 24 }, 15 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (18 cases, 16 steered); { 5, 2000 } (23
		 *   cases, 16 steered); and at { 9, 0 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 9 and steered 0, the fewest cases measured: a floor of 3 reaches every situation with no steered
		 *   case, where floors of 1 and 2 need 16 steered cases; its kill is red on floor case 0 at every budget measured.
		 *   The steered phase stops once every situation is reached, so its cap costs no case beyond those it runs. No
		 *   headroom: a run that reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 9, steered: 0 },
		check:
			({ tx }, c: Case<SiteFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const schema = yield* seat.schema("seedsites")
							return yield* Effect.forEach(
								shapes,
								(shape) =>
									Effect.gen(function* () {
										const [labelled, rule] = caseOfSketch(shape, k)
										const fired: Array<string> = []
										const optimized = optimizedLoweringWith((features) => {
											appendAll(fired, Arr.filter(features, isGraphRule))
										}, "snapshot")
										const withReference = yield* runLabelledOracle(labelled, optimized, reference, {
											...defaultRunOptions,
											schema: { kind: "named", name: schema }
										})
										assert.equal(withReference.comparison.equal, true, printOutcome(withReference))
										const withConservative = yield* runLabelledOracle(
											labelled,
											optimized,
											conservative,
											{
												...defaultRunOptions,
												schema: { kind: "named", name: schema }
											}
										)
										assert.equal(
											withConservative.comparison.equal,
											true,
											printOutcome(withConservative)
										)
										assert.ok(
											fired.includes(rule),
											`${shape} fired ${Arr.join(Arr.dedupe(fired), ", ")}, not ${rule}`
										)
										c.note(
											defined(withReference.left.run.statements[0], "the statement").rows.length > 0
												? `${shape} agreed with rows`
												: `${shape} agreed with none`
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
			name: "the reference evaluator and the conservative lowering over the same facts, raw text sets with no repeated row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/graph/index.ts",
				original: "\trules: [seedPushdown],",
				replacement: "\trules: [],",
				why: "The graph pass holds no seed pushdown rule, so no predicate over a recursion's carried columns reaches its seed."
			}
		]
	})
