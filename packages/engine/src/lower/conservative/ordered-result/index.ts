import type { Lowerers, NodeLowerer } from "#compiler/lower/conservative/context.ts"

/**
 * OrderedResult: a set delivered under a completed total order.
 *
 * Order is a result operation, not a property of a relation: read inside a statement, an ordered result is
 * its input's set, and only take observes an order, through its own node. Delivered to the host, the statement that
 * reads it carries ORDER BY over the completed order (deliver.ts).
 */
const lowerOrderedResult: NodeLowerer<"OrderedResult"> = (node, cx, env) =>
	cx.lower(node.input, env)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const orderedResultLowering: Lowerers<"OrderedResult"> = {
	OrderedResult: lowerOrderedResult
}
