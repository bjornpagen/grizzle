import { type CompileError, reportedAt } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { contextAdmits } from "#compiler/ir/evidence.ts"
import type { CompletedOrder, OrderKey, RelNode, Roots, ValidDag } from "#compiler/ir/rel.ts"
import {
	analyzeLogical,
	checkerEvidence,
	orderSubjectOf,
	withLogicalMeta
} from "#compiler/logical/annotate.ts"
import { completeOrder } from "#compiler/logical/order.ts"

/**
 * The order the user wrote for one ordered node (a take, an ordered result, an ordered attachment), where it was
 * written, and the node as its order is completed, which the checker records when it builds the node: the relation it
 * orders, the columns fixed per evaluation of it (a take's correlation, an attachment's correlated child columns), and
 * the node with a completed order in place of its own.
 */
export interface StatedOrder {
	readonly keys: ReadonlyArray<OrderKey>
	readonly at: SourceLoc
	readonly input: RelNode
	readonly fixed: ReadonlyArray<string>
	readonly withOrder: (order: CompletedOrder) => RelNode
}

/**
 * Completing every stated order of a checked DAG into the total order the query means.
 *
 * The checker records each orderBy the user wrote as stated, on the Take, OrderedResult or ordered Attach it orders,
 * and builds those nodes first with the conservative completion that needs no evidence: the stated fields, then the
 * rest of the heading. This pass replaces that placeholder with the total order completion. The stated fields keep
 * their sequence and directions; once they, with the columns fixed per evaluation, determine a tuple of the ordered
 * relation under its logical keys, the order is total and nothing more is appended (step 1). Otherwise a heterogeneous
 * union's discriminant follows them, then the narrowest proved retained key's other fields, ascending, or without one
 * the rest of the heading (steps 2 and 3, logical/order.ts). A union whose common fields hold no key is
 * refused with UnsupportedOperation.
 *
 * The keys are the logical keys of logical/annotate.ts: the immediate storage keys and the query's
 * own structure, relative to the parameters and outer variables. None rests on a deferred law, so the completion is the
 * same in every execution context, and every consumer of the checked query, both artifacts of a template, a page's
 * cursor comparators (lower/shapes/page/compile.ts pageOrderOf) and the workload access-path requests, reads one order.
 * A total order has no ties, so a shorter completed order selects exactly the same tuples in exactly
 * the same sequence as the conservative one.
 *
 * Every node then carries the analysis's logical metadata (logical/annotate.ts), so the relation an order
 * rests on records the key that makes it total, with its proof, here and after every rewrite that keeps a node's
 * metadata. Only the metadata is taken: node bodies, such as an
 * attachment's delivered type, stay the checker's. The claims are the analysis's own and are checked again wherever
 * they are read; the conservative lowering reads no metadata.
 *
 * Completion is part of what a checked order means, and every consumer of a checked query must read the same one. The
 * logical analysis it reads (logical/) sits below the checker: it imports only core, ir and scalar.
 *
 * `dag` with every stated order of a node its roots reach completed under the logical keys of the relation it orders,
 * in the order the orders were stated, or the first order that has no correct completion.
 */
export const completeStatedOrders = <R extends Roots>(
	dag: ValidDag<R>,
	stated: ReadonlyMap<RelNode, StatedOrder>
): Result.Result<ValidDag<R>, CompileError> => {
	if (stated.size === 0) {
		return Result.ok(dag)
	}
	const analysis = analyzeLogical(dag, checkerEvidence)
	if (!analysis.ok) {
		return Result.err(analysis.error)
	}
	const reachable = new Set<RelNode>(topoOrder(dag))
	/** Each ordered node with its completed order in place of its own, in the order the orders were stated. */
	const completed = new Map<RelNode, RelNode>()
	for (const [node, order] of stated) {
		if (!reachable.has(node)) {
			continue
		}
		const props = analysis.value.of(order.input).props
		const completion = completeOrder(
			orderSubjectOf(order.input, props, order.fixed, (k) =>
				contextAdmits("transaction", k.context)
			),
			order.keys
		)
		if (!completion.ok) {
			return Result.err(reportedAt(completion.error, order.at))
		}
		completed.set(node, order.withOrder(completion.value))
	}
	return Result.ok(withLogicalMeta(dag, analysis.value, (node) => completed.get(node) ?? node))
}
