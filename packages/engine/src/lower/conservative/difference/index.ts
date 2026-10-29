import type { Lowerers, NodeLowerer } from "#compiler/lower/conservative/context.ts"
import { armCore, setOperation } from "#compiler/lower/conservative/union/arms.ts"

/**
 * Difference: the left input's tuples absent from the right.
 *
 *   SELECT r2.c1 FROM (<left>) AS r2(c1) EXCEPT SELECT r3.c2 FROM (<right>) AS r3(c2)
 *
 * EXCEPT keeps its set form; the right arm is projected onto the left's
 * heading order.
 */
const lowerDifference: NodeLowerer<"Difference"> = (node, cx, env) =>
	setOperation("EXCEPT", [
		armCore(cx, node.left, node.heading, env),
		armCore(cx, node.right, node.heading, env)
	])

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const differenceLowering: Lowerers<"Difference"> = { Difference: lowerDifference }
