import type { Pass } from "#compiler/ir/pass.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"

/** A query's DAG: a Forbid root is an emptiness test and any other the public result. */
interface DedupInput {
	readonly dag: RelDag
}

const dedupPassName = "dedupPlacement"

/**
 * The deduplication placement pass (lower/optimize/dedup).
 *
 * It runs after specialized lowering, on the rewritten DAG, in the optimized lowering: the conservative artifact
 * deduplicates at every set boundary and runs no pass. Its evidence holds in the context the template is compiled for;
 * its certificates enter the compilation's certificate log, and its proofs resolve keys through the compilation's
 * catalog. The pass is a bounded worklist (place.ts).
 */
export const dedupPlacement: Pass<DedupInput, DedupPlan> = {
	name: dedupPassName,
	run: (input, ctx) => {
		const planned = placeDeduplication(input.dag, {
			context: ctx.evidenceContext,
			catalog: ctx.catalog,
			roots: "result"
		})
		if (!planned.ok) {
			return planned
		}
		for (const cert of planned.value.certificates) {
			ctx.certificates.record(cert)
		}
		return planned
	}
}
