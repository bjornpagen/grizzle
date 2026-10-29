import type { Lowerers, NodeLowerer } from "#compiler/lower/conservative/context.ts"

/**
 * Attach: the nest operator, a set of child facts per parent fact; the parent set is unchanged.
 *
 * An Attach exists only on its root's delivery spine (dag.ts deliverySpine; a valid DAG holds one nowhere else), so
 * the rows a statement reads through it are its parent's rows under the parent's heading: the attached sets are not
 * part of that heading, and an attachment never filters, multiplies or reorders parents. Lowering it inside a
 * statement is lowering its parent. The children are delivered by a statement of their own in the parent's flight and
 * snapshot, which computes the parent's rows again and selects each parent row's children (deliver.ts), and the
 * library stitches them onto the parents. A padded outer join is never a lowering.
 */
const lowerAttach: NodeLowerer<"Attach"> = (node, cx, env) => cx.lower(node.parent, env)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const attachLowering: Lowerers<"Attach"> = { Attach: lowerAttach }
