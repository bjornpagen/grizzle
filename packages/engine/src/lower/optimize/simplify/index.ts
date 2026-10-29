import { rewritePass } from "#compiler/lower/optimize/demand/frame.ts"
import {
	simplificationMeasure,
	simplificationRules
} from "#compiler/lower/optimize/simplify/rules.ts"

/**
 * Semantic simplification: literal and finite folding, equality propagation, branch removal, the Allen normal form of
 * span predicates, and the filter and projection normalizations, as one bounded-worklist pass. Fusion (R01, ../fuse) is the other half of the
 * semantic simplification pass and runs beside it.
 */
export const simplifyPass = rewritePass({
	name: "simplify",
	rules: simplificationRules,
	measure: simplificationMeasure
})
