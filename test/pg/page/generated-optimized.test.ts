/**
 * The page runtime on generated ordered queries, through the optimized artifact, which the page compiler builds and the
 * runtime runs (generated.ts states the property).
 *
 * Oracle: the conservative lowering's complete sorted distinct result D, which the windows of each walk cut, each
 * window's attachments D's children of its delivered rows.
 *
 * Features: generated.ts's PageFeature, every required one.
 */
import { type Budget, ReplayToken } from "@bjornpagen/testing/property"
import { generatedProperty } from "#test/pg/page/generated.ts"

/**
 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and at most
 * 1,136 steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor and
 * the steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills alike.
 *
 * @limitKind measured
 * @owner test/pg/page/generated-optimized.test.ts's property, its search
 * @unit cases: the rotating stream's runs, and the steered phase's most
 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating stream
 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes, its first measurement: kills0.log, `toolchain-test kills
 *   test/pg/recursion test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red
 *   witness printed by a local line in the kills command's report, never committed; m1run.log and m2run.log with their
 *   run records m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill
 *   judged after its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget
 *   under a verdict cache of its own. ~/.cache/grizzle/PAGEORDER-notes, its revalidation once the generator drew every
 *   heterogeneous union keyed by its groups' shared fields and the pair of heading groups and several pages by
 *   position was required: red.log, the property red at 58fc1a9a2 on a keyless union's page, refused; run3-green.log and
 *   run3-green.json, `toolchain-test run` of the module at this budget; kills.log, `toolchain-test kills` of it, no kill
 *   answered by a cached verdict; never committed. Each run under TEST_SEED=2219874524, its budget rewritten for the
 *   run where @workload names another
 * @observed 2026-11-23 03:27 to 04:39 UTC; revalidated 2026-11-24 22:18 UTC to 2026-11-25 00:50 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
 *   load 390 to 550, and 380 to 640 at the revalidation); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec,
 *   two members settled by toolchain-pg settle, and lane PAGEORDER's family at the revalidation; grizzle f87b2aaab with
 *   test/pg/page's cull, revalidated on 58fc1a9a2 with lane PAGEORDER's generator; vendor/toolchain 2cc4817, then
 *   0f61f2e; Node 26.13.1
 * @workload this property at { runs, steered } of { 2000, 2000 }, its pre-conversion budget (test/pg/page/generated.ts
 *   at fa10bca50), then { 1, 2000 }, { 61, 2000 }; at the revalidation { 1, 1136 }
 * @result At { 2000, 2000 }, 2501 cases at f1bf91a2f's gate, two of its kills went red on its kept case and the third
 *   on floor case 487. Green, every required situation reached by a witness, and every kill killed at { 1, 2000 }
 *   (1,139 cases, 1,136 steered); { 61, 2000 } (1,213 cases, 1,136 steered); and at { 1, 1136 } again under a verdict
 *   cache of its own (final1). At the revalidation, { 1, 1136 }: green, every required situation reached by a witness,
 *   the pair among them (1,139 cases, 1,136 steered), and 3 of 3 kills killed. Worker CPU is a loaded machine's and not
 *   compared
 * @decision runs 1 and steered 1,136, the fewest cases measured: from a floor of 1 or 16 the steered phase reaches
 *   every situation in 1,136 cases, the pair within them; two kills are red on its kept case at every budget, and the
 *   third, the heterogeneous union's positioned window, within the witnesses at every budget measured, a witness of the
 *   pair paging such a union by position past its first page. The steered phase stops once every situation is reached,
 *   so its cap costs no case beyond those it runs. No headroom: a run that reaches fewer situations says which
 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
 *   random.ts and limits.ts)
 */
const budget: Budget = { runs: 1, steered: 1136 }

/**
 * The page runtime cuts generated ordered queries into windows through the optimized artifact at a drawn size per
 * direction, each case in its one rolled-back transaction on the worker's own clone (oracleProperty).
 */
export const thePageRuntimeCutsGeneratedOrderedQueriesIntoWindowsThroughTheOptimizedArtifact =
	generatedProperty(
		[
			{
				token: ReplayToken(
					"test/pg/page/generated-optimized.test.ts#thePageRuntimeCutsGeneratedOrderedQueriesIntoWindowsThroughTheOptimizedArtifact:-:1.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"page/generated-optimized, TEST_SEED=28094260: a nested key set over children keyed within one parent only, read without DISTINCT (generated.ts recordedPageCases)",
				since: "2026-11-11"
			}
		],
		[
			{
				file: "packages/engine/src/lower/shapes/page/rows.ts",
				original: '\t\toffset: start.kind === "offset" ? start.offset.value() : undefined',
				replacement: "\t\toffset: undefined",
				why: "A positioned window's statement skips no row, so every page is the first; the pages by position fail."
			},
			{
				file: "packages/grizzle/src/adapter/page/execute.ts",
				original: '\t\t\tcase "offset":\n\t\t\t\treturn countParam(position)',
				replacement: '\t\t\tcase "offset":\n\t\t\t\treturn countParam(position + 1)',
				why: "A positioned window binds its offset one past its position, each page one row late; the window at a position fails."
			},
			{
				file: "packages/engine/src/lower/shapes/page/rows.ts",
				original: "\t\toffset: spec.offset\n",
				replacement: "\t\toffset: undefined\n",
				why: "A heterogeneous union's positioned window keeps the union's first tuples, not its tuples at the position; its groups' pages by position fail."
			}
		],
		budget
	)
