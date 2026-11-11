/**
 * The optimized lowering against the conservative lowering on the optimizer's population with its scalar and relation
 * parameters named from the parameter-name dictionary (gen/case.ts paramNameGenConfig, kernel/dict.ts parameterNames): a
 * relation parameter named like a page's own input ("pageSize", "page:limit") or a reserved word meets every optimized
 * form, the VALUES transport included.
 *
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Plants: oracle-optimized-obligations-dropped (the dedup placement discharges no obligation, so a DISTINCT owed is
 * never placed and the optimized artifact repeats rows).
 *
 * Features: the population's required features (suite.ts and the file's own).
 */
import { layer } from "@effect/vitest"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Formatter } from "effect"
import {
	casesPerPopulation,
	differential,
	type OptimizedFeature,
	optimizedShrink,
	resolved
} from "#test/pg/oracle/optimized/suite.ts"
import { paramNameGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

layer(Substrate.layer)(
	"the optimized lowering against the conservative lowering, parameters named from the dictionary",
	(it) => {
		it.effect("agrees on cases whose parameters are named from the dictionary", (ctx) =>
			searched(
				ctx,
				differential(resolved(queryCaseGen(paramNameGenConfig)), namedPlacement("optp"), {
					suite: "optimized/param-names",
					oracle: {
						kind: "second-implementation",
						name: "the conservative lowering's raw text sets, no repeated row on the optimized side"
					},
					literal: Formatter.format,
					coverage: required<OptimizedFeature>(["relation parameter named from the dictionary"], {
						cases: casesPerPopulation,
						sense: notesOnly
					}),
					kept: [],
					runs: casesPerPopulation,
					shrink: optimizedShrink,
					perturb: "all"
				})
			)
		)
	}
)
