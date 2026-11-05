import * as Result from "#compiler/core/result.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { rewritePass, traversalPass } from "#compiler/lower/optimize/demand/frame.ts"
import {
	allenNormalForm,
	simplificationPotential,
	simplificationRules
} from "#compiler/lower/optimize/simplify/rules.ts"

const allen = traversalPass({ name: "simplify", step: allenNormalForm })

const rewrites = rewritePass({
	name: "simplify",
	rules: simplificationRules,
	potential: simplificationPotential
})

/**
 * Semantic simplification: the Allen normal form of span predicates, once over every filter, then literal and finite
 * folding, equality propagation, branch removal, and the filter and projection normalizations, as one bounded-worklist
 * pass. Fusion (R01, ../fuse) is the other half of the semantic simplification pass and runs beside it.
 */
export const simplifyPass: Pass<LogicalQuery, LogicalQuery> = {
	name: "simplify",
	measure: rewrites.measure,
	run: (input, ctx) => Result.flatMap(allen.run(input, ctx), (normal) => rewrites.run(normal, ctx))
}
