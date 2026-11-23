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
		/** Its pre-conversion budget: runs 1250, coverage cases 1250 (suite.ts casesPerPopulation at fe79ac6b2^). */
		budget: { runs: 1250, steered: 1250 },
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
