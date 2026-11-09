import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { closedPass } from "#compiler/lower/optimize/closed/index.ts"
import { eliminatePass } from "#compiler/lower/optimize/eliminate/index.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { lateFetchPass } from "#compiler/lower/optimize/late-fetch/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { pushdownPass } from "#compiler/lower/optimize/pushdown/index.ts"
import { semiPushdownPass } from "#compiler/lower/optimize/pushdown/semi.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"

/**
 * Passes run in order over one context, the first failure ending the sequence.
 *
 * The rewrite phases of the optimized pipeline, in their fixed order (lower/optimize/pipeline.ts):
 *
 * - simplify, "semantic simplification": literal and finite folding, equality propagation and branch removal, then
 *   R01 fusion, then the same simplifications over the fused regions, whose projections now compose;
 * - rewrites, "relational rewrites": demand pruning (so a dead witness is an existential, which R03, R07 and R02
 *   need), R03 elimination, R07 closed membership (before R02, so a closed relation's facts become a read of its
 *   installed key set rather than an EXISTS over VALUES), R02 semi-joins, legal predicate movement, semi-join movement
 *   onto the occurrence and below the group whose keys it restricts, a simplification of the filters the movement
 *   leaves adjacent, pruning again over the narrowed graph, and R06 late payload fetch.
 *
 * The demanded columns and physical evidence are recomputed by every rewrite that reads them ("recompute evidence after
 * changes"): demand analysis and the physical analysis are pure functions of the current DAG.
 * The CTE policy (../cte-policy) runs at emission, over the DAG dedup placement leaves.
 */
export const sequence = (
	name: string,
	passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>
): Pass<LogicalQuery, LogicalQuery> => ({
	name,
	run: (query, ctx) => {
		let current: Result.Result<LogicalQuery, CompileError> = Result.ok(query)
		for (const pass of passes) {
			current = Result.flatMap(current, (q) => pass.run(q, ctx))
		}
		return current
	}
})

export const semanticSimplification: Pass<LogicalQuery, LogicalQuery> = sequence("simplify", [
	simplifyPass,
	fusePass,
	simplifyPass
])

/** The "relational rewrites" pass, under the compilation's catalog (PassContext). */
export const relationalRewrites: Pass<LogicalQuery, LogicalQuery> = sequence("rewrites", [
	prunePass,
	eliminatePass,
	closedPass,
	existencePass,
	pushdownPass,
	semiPushdownPass,
	simplifyPass,
	prunePass,
	lateFetchPass
])
