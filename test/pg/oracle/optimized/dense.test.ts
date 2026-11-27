/**
 * The optimized lowering against the conservative lowering on the generator's own population with dense facts
 * (test/pg/oracle/support.ts denseQueryCaseGen): three to six sketched rows for every relation slot, so joins, fanout,
 * groups and projected duplicates meet real rows, each case under a plan perturbation drawn with it
 * (test/support/oracle/perturb.ts). Each case runs under the optimized artifact compiled for the `snapshot` context
 * against the installation's own evidence catalog, against the conservative lowering (support.ts).
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Features: the population's required features (suite.ts and the file's own).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { Function } from "effect"
import {
	type OptimizedFeature,
	differentialProperty,
	optimizedSpace
} from "#test/pg/oracle/optimized/suite.ts"
import { denseQueryCaseGen } from "#test/pg/oracle/support.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"

/** The optimized lowering agrees with the conservative on generated cases with dense facts, raw text sets, no repeated row. */
export const dense = differentialProperty(
	optimizedSpace(denseQueryCaseGen(defaultGenConfig)),
	Function.identity,
	namedPlacement("dense"),
	{
		situations: ["nonempty"] satisfies ReadonlyArray<Reached<OptimizedFeature>>,
		/**
		 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
		 * (grizzle main, 2026-11-23).
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/dense.test.ts dense
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
		 * @result runs 1250 (pre-conversion): the dedup/place.ts kill fails floor case 0; runs 1: killed, its situation
		 *   reached on the floor, 2 cases in all where f1bf91a2f's gate ran 1,563
		 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run. steered stays its pre-conversion
		 *   1250: the phase stops once every required situation is reached, so a green run spends only its need, none here,
		 *   and the cap only bounds a run whose situation went unreached
		 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
		 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
		 *   survives
		 */
		budget: { runs: 1, steered: 1250 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/dedup/place.ts",
				original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
				replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
				why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
			}
		]
	}
)
