import * as Result from "#compiler/core/result.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { rewritePass } from "#compiler/lower/optimize/demand/frame.ts"
import { seedPotential, seedPushdown, seedRules } from "#compiler/lower/optimize/graph/seed.ts"

const graphPassName = "graph"

const rewrites = rewritePass({
	name: graphPassName,
	rules: [seedPushdown],
	potential: () => seedPotential
})

const graphRules: ReadonlySet<CertificateRule> = new Set(Object.values(seedRules))

/**
 * Bounded traversal specialization.
 *
 * The pass runs in the specialized lowering stage of the optimized pipeline (../pipeline.ts), after the relational
 * rewrites and the compile-target catalog, and is a bounded-worklist rewrite pass (../demand/frame.ts) with one rule
 * family:
 *
 * - proved root pushdown (seed.ts): a predicate the consumer of a recursion applies to columns the step carries
 *   unchanged is placed in the recursion's seed, so the traversal explores only the roots the answer
 *   keeps; an endpoint filter, on the column the traversal advances, never moves.
 *
 * The rest of graph specialization lives where its mechanism does:
 *
 * - endpoint existence: an explicit vertex match is never removed or added here. Only relation elimination (R03,
 *   ../eliminate) removes a match, and only with existence evidence valid in the artifact's evidence context, so a
 *   transaction-context artifact keeps the endpoint test a deferred containment cannot prove;
 * - origin-carrying batched seeds: an attached recursion is seeded once from the delivered parents' key recordset,
 *   its state carrying the originating parent (shapes/attach-recursive, R37). An import bound to an outer variable
 *   of a rule stays correlated, one traversal per binding read LATERAL, so
 *   no root's traversal is ever merged with another's;
 * - adjacency indexes: a containment's reverse probe is the law model's request (physical/indexes), and a workload
 *   program's probes are the workload extraction's (physical/access).
 *
 * A recursion here keeps its WITH RECURSIVE feedback and its complete state, as its lowering does at every depth
 * (shapes/recursion). Where no rule applies the pass returns its input unchanged.
 */
export const graphPass: Pass<LogicalQuery, LogicalQuery> = {
	name: graphPassName,
	measure: rewrites.measure,
	run: (input, ctx) => {
		const before = ctx.certificates.all().filter((c) => graphRules.has(c.rule)).length
		return Result.map(rewrites.run(input, ctx), (output) =>
			ctx.certificates.all().filter((c) => graphRules.has(c.rule)).length === before
				? input
				: output
		)
	}
}
