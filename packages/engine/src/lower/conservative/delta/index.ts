import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import {
	distinctSelect,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { col, target, unitTargets } from "#compiler/sql/build.ts"

/**
 * Delta: a read-back's netted delta.added(R) or delta.removed(R).
 *
 *   SELECT DISTINCT r2.c4, r2.c5 FROM __carrier_1 AS r2
 *
 * A delta is the write program's, computed by comparing the states before and after the change in the conservative
 * realization: the write compiler hands the lowering the transaction-scoped carrier that holds it, whose columns are
 * the delta's heading position by position. Outside a write
 * program there is no delta, and the node is UnsupportedOperation.
 */
const lowerDelta: NodeLowerer<"Delta"> = (node, cx) => {
	const at = nodeLabel(node)
	const subject = cx.options.subject
	const source = subject.kind === "readBack" ? subject.deltas(node.relation, node.side) : undefined
	if (source === undefined) {
		return refuse(
			"UnsupportedOperation",
			at,
			`delta.${node.side}(${node.relation}) outside a write program that supplies its delta relation`
		)
	}
	if (source.columns.length !== node.heading.length) {
		return refuse(
			"MalformedDescription",
			at,
			`a delta relation of ${node.heading.length} columns for the heading, not ${source.columns.length}`
		)
	}
	const alias = cx.relationAlias({ kind: "node", node: node.id })
	const targets = isNonEmpty(source.columns)
		? mapNonEmpty(source.columns, (c) => target(col(alias, c)))
		: unitTargets
	return distinctSelect(targets, [{ kind: "table", table: source.carrier, alias }], [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const deltaLowering: Lowerers<"Delta"> = { Delta: lowerDelta }
