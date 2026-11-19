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
