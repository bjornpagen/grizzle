/**
 * The optimized lowering against the conservative lowering on the optimizer's population with the per-evaluation shapes
 * (gen/case.ts perEvaluationGenConfig): correlated takes, correlated variables and lateral constants reading an earlier
 * source, shared right sides, beside the nested attachment chains every attach root may draw, each level under its own
 * per-parent take, among them a child that reads its parent with an attachment of its own, whose key set reads children
 * keyed within one parent only. Its facts hold within one evaluation of a correlated subtree only. Each case runs under a plan
 * perturbation drawn with it (test/support/oracle/perturb.ts), under the optimized artifact compiled for the `snapshot`
 * context against the installation's own evidence catalog, in every per-execution form, against the conservative
 * lowering (support.ts). Its escaped counterexamples are recorded beside its population and kept by their tokens
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
		/** Its pre-conversion budget: runs 1250, coverage cases 1250 (suite.ts casesPerPopulation at 4d8f77263). */
		budget: { runs: 1250, steered: 1250 },
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
			}
		],
		kills: []
	}
)
