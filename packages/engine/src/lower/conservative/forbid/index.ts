import type { Lowerers, NodeLowerer } from "#compiler/lower/conservative/context.ts"

/**
 * Forbid: a law, whose violation query must be empty.
 *
 * The conservative lowering of a law is its violation query, evaluated like any query: the oracle accepts a final
 * state exactly when every violation query is empty there ("Laws"). Native enforcement, and the migration's check of
 * a law over closed relations alone, are the law compiler's, never this lowering's.
 */
const lowerForbid: NodeLowerer<"Forbid"> = (node, cx, env) => cx.lower(node.violation, env)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const forbidLowering: Lowerers<"Forbid"> = { Forbid: lowerForbid }
