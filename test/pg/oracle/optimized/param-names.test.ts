/**
 * The optimized lowering against the conservative lowering on the optimizer's population with its scalar and relation
 * parameters named from the parameter-name dictionary (gen/case.ts paramNameGenConfig, kernel/dict.ts parameterNames): a
 * relation parameter named like a page's own input ("pageSize", "page:limit") or a reserved word meets every optimized
 * form, the VALUES transport included.
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Features: the population's required features (suite.ts and the file's own).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { ReplayToken } from "@bjornpagen/testing/property"
import { Function } from "effect"
import {
	type OptimizedFeature,
	differentialProperty,
	optimizedSpace
} from "#test/pg/oracle/optimized/suite.ts"
import { paramNameGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"

/** The optimized lowering agrees with the conservative on cases whose parameters are named from the dictionary. */
export const paramNames = differentialProperty(
	optimizedSpace(queryCaseGen(paramNameGenConfig)),
	Function.identity,
	namedPlacement("optp"),
	{
		situations: ["relation parameter named from the dictionary"] satisfies ReadonlyArray<
			Reached<OptimizedFeature>
		>,
		/**
		 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
		 * (grizzle main, 2026-11-23).
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/param-names.test.ts paramNames
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
		 * @workload its witnesses with each of its kills applied, every kill on workers of its own, and its full run, at
		 *   runs 1250, 25 and 21, steered 1250
		 * @result runs 1250 (pre-conversion): the dedup/place.ts kill fails floor case 6, the share.ts kill its kept case;
		 *   runs 25 (a floor of seven): both killed, its situations reached on the floor, 32 cases in all where f1bf91a2f's
		 *   gate ran 1,704; runs 21 (a floor of six): the dedup/place.ts kill survives
		 * @decision runs 25, the fewest whose floor holds case 6. steered stays its pre-conversion 1250: the phase stops
		 *   once every required situation is reached, so a green run spends only its need, none here, and the cap only
		 *   bounds a run whose situation went unreached
		 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
		 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
		 *   survives
		 */
		budget: { runs: 25, steered: 1250 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/param-names.test.ts#paramNames:-:1.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.2.0.2.2.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.f.3.2.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"f1bf91a2f's gate, rotating 0x09df2452, case 677: the sharing rewrite's split of a guarded remainder made (0::numeric) % (0::numeric) in a CASE arm no row reaches, which PostgreSQL's planner folds and raises at, 22012 (e0596ebe6)",
				since: "2026-11-22"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t\t\t(!this.#raisesAsPlanned(split) || this.#raisesAsPlanned(unsplit))\n",
				replacement: "\t\t\t\t\ttrue\n",
				why: "The sharing rewrite takes a split that makes an operation over constants that raises (lower/conservative/expr/share.ts #raisesAsPlanned), as before e0596ebe6: the planner folds (0::numeric) % (0::numeric) in a CASE arm no row reaches, and the conservative statement raises 22012."
			},
			{
				file: "packages/engine/src/lower/optimize/dedup/place.ts",
				original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
				replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
				why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
			}
		]
	}
)
