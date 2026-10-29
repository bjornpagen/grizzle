import {
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"

/**
 * OrderedSetAggregate: an internal lowering node of the R29-R31 rewrites.
 *
 * Percentiles and the mode exist as ordered-set aggregates only as the product of a rewrite of their count
 * compositions. The conservative lowering uses no rewrite certificate: it lowers the
 * composition itself, so an OrderedSetAggregate node in its input is refused.
 */
const lowerOrderedSetAggregate: NodeLowerer<"OrderedSetAggregate"> = (node) =>
	refuse(
		"UnsupportedOperation",
		nodeLabel(node),
		`a public composition, not the ${node.rule} rewrite's ordered-set aggregate; the conservative lowering applies no rewrite`
	)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const orderedSetAggregateLowering: Lowerers<"OrderedSetAggregate"> = {
	OrderedSetAggregate: lowerOrderedSetAggregate
}
