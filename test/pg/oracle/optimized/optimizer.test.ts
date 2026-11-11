/**
 * The optimized lowering against the conservative lowering on the optimizer's population (gen/case.ts
 * optimizerGenConfig), each case under a plan perturbation drawn with it (test/support/oracle/perturb.ts), so joins,
 * fanout, groups, projected duplicates, unions and closures meet real rows.
 *
 * The population is the conservative suite's: one to four relations with composite and candidate keys, closed rosters,
 * pure sets, containments and mutable relations, small-domain facts including NaN, -0, numeric display scales and
 * supplementary-plane text, and queries over match, filter, project, semi- and anti-join, union, intersection,
 * difference, group, take, attach and recursion, at the root as a plain set, with attachments, or as a heterogeneous
 * union, with scalar and relation parameters; and it draws what each rewrite family needs besides: containments to read
 * through, wide payload under takes with stated orders, total computed terms, equations, filters read through regions
 * and rooted closures. Each case runs under the optimized artifact compiled for the `snapshot` context against the
 * installation's own evidence catalog, in every per-execution form, against the conservative lowering (support.ts), and
 * the population must reach every rewrite family (its required features). No generated term raises (every partial
 * operation is guarded, gen/compute.ts), so an execution error of any form is a defect.
 */
import { layer } from "@effect/vitest"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Formatter } from "effect"
import {
	casesPerPopulation,
	differential,
	generatedRules,
	type OptimizedFeature,
	optimizedShrink,
	resolved,
	rewriteFamilies
} from "#test/pg/oracle/optimized/suite.ts"
import { optimizerGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The features the optimizer's population must reach, beyond the rules: pipelined attachments and heading groups run
 * (no attachment over exact parents fuses; the one that fuses, over approximate parents, is variants.test.ts's),
 * relation parameters also travel by VALUES, computed terms are evaluated, and cases deliver rows.
 */
const situations = [
	...generatedRules,
	...rewriteFamilies,
	"pipelined attachment",
	"heading groups",
	"computed term",
	"nested attachment",
	"per-parent take over an attachment",
	"nonempty"
] as const satisfies ReadonlyArray<OptimizedFeature>

layer(Substrate.layer)(
	"the optimized lowering against the conservative lowering, the optimizer's population",
	(it) => {
		it.effect("agrees on the optimizer's population, raw text sets, with no repeated row", (ctx) =>
			searched(
				ctx,
				differential(resolved(queryCaseGen(optimizerGenConfig)), namedPlacement("opt"), {
					suite: "optimized/optimizer",
					oracle: {
						kind: "second-implementation",
						name: "the conservative lowering's raw text sets, no repeated row on the optimized side"
					},
					literal: Formatter.format,
					coverage: required<OptimizedFeature>(situations, {
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
