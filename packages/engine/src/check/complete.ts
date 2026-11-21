import * as Result from "@bjornpagen/grizzle-text/base/result"
import { canonicalMerges, type StatedMerge } from "#compiler/check/merge.ts"
import { completedOrders, type StatedOrder } from "#compiler/check/order.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { DagBuilder } from "#compiler/ir/builder.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelNode, Roots, ValidDag } from "#compiler/ir/rel.ts"
import { analyzeLogical, checkerEvidence, withLogicalMeta } from "#compiler/logical/annotate.ts"

/**
 * A checked DAG completed: what the checker states as it builds a node and settles only under the logical analysis of
 * the whole DAG, the total order of each stated order (order.ts completedOrders) and the canonical zero of each float a
 * stated merge may take one of two zeros of (merge.ts canonicalMerges), under one analysis, which only a DAG stating
 * either runs.
 *
 * Every node then carries the analysis's logical metadata (logical/annotate.ts), so the relation an order rests on
 * records the key that makes it total, with its proof, here and after every rewrite that keeps a node's metadata. Only
 * the metadata is taken: node bodies, such as an attachment's delivered type, stay the checker's. The claims are the
 * analysis's own and are checked again wherever they are read; the conservative lowering reads no metadata. A float's
 * canonical zero changes no key: it delivers its column's value under PostgreSQL's equality (ir/injective.ts
 * comparedValue), so the analysis of the DAG as stated holds of the DAG as completed.
 *
 * `dag`, built by `b`, completed, or the first stated order that has no correct completion.
 */
export const completeStated = <R extends Roots>(
	dag: ValidDag<R>,
	b: DagBuilder,
	orders: ReadonlyMap<RelNode, StatedOrder>,
	merges: ReadonlyMap<RelNode, StatedMerge>,
	kept: ReadonlySet<RelNode>
): Result.Result<ValidDag<R>, CompileError> => {
	if (orders.size === 0 && merges.size === 0) {
		return Result.ok(dag)
	}
	const analysis = analyzeLogical(dag, checkerEvidence)
	if (!analysis.ok) {
		return Result.err(analysis.error)
	}
	const reachable = new Set<RelNode>(topoOrder(dag))
	const completed = completedOrders(analysis.value, reachable, orders)
	if (!completed.ok) {
		return Result.err(completed.error)
	}
	const merged = canonicalMerges(analysis.value, reachable, merges, b)
	return Result.ok(
		withLogicalMeta(
			dag,
			analysis.value,
			(node) => completed.value.get(node) ?? merged.get(node) ?? node,
			kept
		)
	)
}
