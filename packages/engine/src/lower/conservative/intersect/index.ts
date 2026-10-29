import type { Lowerers, NodeLowerer } from "#compiler/lower/conservative/context.ts"
import { armCore, setOperation } from "#compiler/lower/conservative/union/arms.ts"

/**
 * Intersect: the set intersection of two inputs of one heading.
 *
 *   SELECT r2.c1 FROM (<left>) AS r2(c1) INTERSECT SELECT r3.c2 FROM (<right>) AS r3(c2)
 *
 * INTERSECT keeps its set form; the right arm is projected onto the left's
 * heading order.
 */
const lowerIntersect: NodeLowerer<"Intersect"> = (node, cx, env) =>
	setOperation("INTERSECT", [
		armCore(cx, node.left, node.heading, env),
		armCore(cx, node.right, node.heading, env)
	])

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const intersectLowering: Lowerers<"Intersect"> = { Intersect: lowerIntersect }
