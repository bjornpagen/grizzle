/**
 * The optimized lowering against the conservative lowering on the generator's own population with dense facts
 * (test/pg/oracle/support.ts denseQueryCaseGen): three to six sketched rows for every relation slot, so joins, fanout,
 * groups and projected duplicates meet real rows, each case under a plan perturbation drawn with it
 * (test/support/oracle/perturb.ts). Each case runs under the optimized artifact compiled for the `snapshot` context
 * against the installation's own evidence catalog, in every per-execution form, against the conservative lowering
 * (support.ts).
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
import { denseQueryCaseGen } from "#test/pg/oracle/support.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

layer(Substrate.layer)(
	"the optimized lowering against the conservative lowering, dense facts",
	(it) => {
		it.effect(
			"agrees on generated cases with dense facts, raw text sets, with no repeated row",
			(ctx) =>
				searched(
					ctx,
					differential(resolved(denseQueryCaseGen(defaultGenConfig)), namedPlacement("dense"), {
						suite: "optimized/dense",
						oracle: {
							kind: "second-implementation",
							name: "the conservative lowering's raw text sets, no repeated row on the optimized side"
						},
						literal: Formatter.format,
						coverage: required<OptimizedFeature>(["nonempty"], {
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
