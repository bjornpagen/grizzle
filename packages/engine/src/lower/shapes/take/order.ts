import type { CompletedOrder, Heading, RelNode } from "#compiler/ir/rel.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"

/**
 * Whether `order` is physically total over the rows of `input`, so its ORDER BY items (conservative/take/order.ts
 * orderItemsOf) need no heading column after its keys.
 *
 * The IR's completed order is total over its input by a key the order completion proved (logical/order.ts). The
 * optimized lowering emits exactly those keys when the physical facts prove that the order's columns determine a key
 * of the input as realized, so an index on the order supplies the pathkey and no extra sort column is added
 * (R20). Without that proof, in a context where the key the order rested on is not evidence, the
 * remaining heading columns are appended ascending, as the conservative baseline does, so the bound is never an
 * arbitrary choice among ties.
 */
export const orderIsTotal = (
	facts: ShapeFacts,
	input: RelNode,
	order: CompletedOrder,
	heading: Heading
): boolean =>
	heading.length === 0 ||
	facts.keyedBy(
		input,
		order.keys.map((k) => k.column)
	) !== undefined
