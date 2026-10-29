import {
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"

/**
 * Window: an internal lowering node of the R26-R28 and R41 rewrites.
 *
 * A Window exists only as the product of a rewrite that recognizes a count, successor or running-aggregate
 * composition; it is not constructible from the public surface. The conservative lowering uses no rewrite certificate:
 * it lowers the composition itself, never a rewrite's product, so a Window node in its input is refused.
 */
const lowerWindow: NodeLowerer<"Window"> = (node) =>
	refuse(
		"UnsupportedOperation",
		nodeLabel(node),
		`a public composition, not the ${node.rule} rewrite's window node; the conservative lowering applies no rewrite`
	)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const windowLowering: Lowerers<"Window"> = { Window: lowerWindow }
