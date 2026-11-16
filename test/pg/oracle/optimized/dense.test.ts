/**
 * The optimized lowering against the conservative lowering on the generator's own population with dense facts
 * (test/pg/oracle/support.ts denseQueryCaseGen): three to six sketched rows for every relation slot, so joins, fanout,
 * groups and projected duplicates meet real rows, each case under a plan perturbation drawn with it
 * (test/support/oracle/perturb.ts). Each case runs under the optimized artifact compiled for the `snapshot` context
 * against the installation's own evidence catalog, in every per-execution form, against the conservative lowering
 * (support.ts).
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
