/**
 * The optimized lowering against the conservative lowering on the optimizer's population with the per-evaluation shapes
 * (gen/case.ts perEvaluationGenConfig): correlated takes, correlated variables and lateral constants reading an earlier
 * source, shared right sides, beside the nested attachment chains every attach root may draw, each level under its own
 * per-parent take, among them a child that reads its parent with an attachment of its own, whose key set reads children
 * keyed within one parent only. Its facts hold within one evaluation of a correlated subtree only. Each case runs under a plan
 * perturbation drawn with it (test/support/oracle/perturb.ts), under the optimized artifact compiled for the `snapshot`
 * context against the installation's own evidence catalog, against the conservative lowering (support.ts). Its escaped counterexamples are recorded beside its population and kept by their tokens
 * (per-evaluation.fixtures.ts escapedCounterexamples). No
 * generated term raises (every partial operation is guarded, gen/compute.ts), so an execution error of any form is a
 * defect.
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Features: the population's required features (suite.ts and the file's own), "a fold key correlated with two parent
 * columns" among them, which a case whose turn aims at it reaches by the case built to (suite.ts foldKeyTwiceGen).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { ReplayToken } from "@bjornpagen/testing/property"
import { Function } from "effect"
import {
	perEvaluationCases,
	perEvaluationRequired
} from "#test/pg/oracle/optimized/per-evaluation.fixtures.ts"
import { differentialProperty, type OptimizedFeature } from "#test/pg/oracle/optimized/suite.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"

/** The optimized lowering agrees with the conservative on the optimizer's population with per-evaluation shapes, raw text sets, with no repeated row. */
export const perEvaluation = differentialProperty(
	perEvaluationCases,
	Function.identity,
	namedPlacement("opte"),
	{
		situations: perEvaluationRequired satisfies ReadonlyArray<Reached<OptimizedFeature>>,
		/**
		 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
		 * (grizzle main, 2026-11-23).
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/per-evaluation.test.ts perEvaluation
		 * @unit cases
		 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
		 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
		 * @evidence `toolchain-test kills` and `toolchain-test run` of test/pg/oracle's test files at TEST_SEED=2219874524
		 *   (a property's witnesses, its kept cases, floor and steered phase, are fixed by its identity, the same on every
		 *   seed), each killed kill's failing witness printed by an uncommitted line in vendor/toolchain's
		 *   mutate/commands.ts; the logs kills0.log (the pre-conversion budgets), run1.log, kills2.log, run3.log,
		 *   kills4.log, v1at5.log, fs5.log, fs9.log, fs13.log and run5.log in ~/.cache/grizzle/CULL-ORACLE-out on
		 *   cassowary, uncommitted
		 * @observed 2026-11-23 03:12 to 04:36 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 130 to 410 from other
		 *   lanes; vendor/toolchain 2cc48172; the budgets measured on grizzle f87b2aaab with 47748474c's change and
		 *   verified on dff9200ef (run5.log, every property green and every kill killed); lane CULL-ORACLE's in-memory
		 *   family of two PostgreSQL 19 members
		 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 1250 and 1,
		 *   steered 1250
		 * @result runs 1250 (pre-conversion): the cte-policy kill fails its sixth kept case (seed 0x6e1e5955, case 469),
		 *   which runs at every budget; runs 1: killed, its situations reached with 16 steered cases, 24 cases in all where
		 *   5374a0575's record ran 1,569
		 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run. steered stays its pre-conversion
		 *   1250: the phase stops once every required situation is reached, so a green run spends only its need, 16 here,
		 *   and the cap only bounds a run whose situation went unreached
		 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
		 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
		 *   survives
		 */
		budget: { runs: 1, steered: 1250 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:1.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"an occurrence binding a variable another binds too, whose source the other's constant reads",
				since: "2026-11-04"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:2.0.0.0.0.0.0.0.0.1.0"
				),
				reason: "an occurrence binding nothing, whose source another occurrence's constant reads",
				since: "2026-11-04"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:3.0.0.0.0.0.0.0.0.1.0"
				),
				reason: "a semi-join of a group with itself on two of its grouping columns",
				since: "2026-11-04"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:4.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"page/generated-optimized, TEST_SEED=28094260: a nested key set over children keyed within one parent only",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:5.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"TEST_SEED=1951254937, case 107, shrunk by hand: a fold attached on two pairs that name one key of it",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:6.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"seed 0x6e1e5955, case 469, built by hand: a region another reads laterally, held where its reader reads it",
				since: "2026-11-21"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:7.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"built by hand beside key-sets' rotating 0x9368d051 case 35: a chain's take per parent correlated to a column of the closed relation it leads with that its key set holds no class of, read per row (lower/shapes/region atKeySet), where read at its key set the optimized lowering would refuse it",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/per-evaluation.test.ts#perEvaluation:-:8.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"built by hand from the sixth: its tested region read twice by one region beside R0, shared as a CTE of the statement, the first region held inside that CTE's body (cte-policy holderOf's first holder); the sixth reaches that branch no more, its tested region read once, inline, holding no CTE either way",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original: "\treturn unheld\n\t\t? undefined\n\t\t: (scope, at) =>",
				replacement: "\treturn (scope: Env, at: ReadonlyArray<Expr>): Env =>",
				why: "A source whose correlation reads a column of the region its key set holds no class of read at the key set all the same: the kept take's correlation reads the lead's p1 where only the key is in scope, and the optimized lowering refuses the query."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t\tif (read.size === 0) {\n\t\t\t\tbreak\n\t\t\t}\n",
				replacement: "",
				why: "A node that reads no outer value is held in the outermost region on its chain of dominators: the eighth kept case's first region is held in the root region's query while every read of it stands in the body of the CTE the statement shares its tested region as, out of its reach, which the printer refuses."
			}
		]
	}
)
