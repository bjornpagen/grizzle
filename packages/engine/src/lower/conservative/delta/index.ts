import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { emptyRelation } from "#compiler/lower/conservative/closed/index.ts"
import {
	distinctSelect,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import type { FromSource } from "#compiler/sql/ast.ts"
import { col, cteRefAs, target, unitTargets } from "#compiler/sql/build.ts"

/**
 * Delta: a read-back's netted delta.added(R) or delta.removed(R).
 *
 *   SELECT DISTINCT r12.c4, r12.c5 FROM r9 AS r12
 *
 * A delta is the write program's: the write compiler hands the lowering the relation that holds it, whose columns are
 * the delta's heading position by position (DeltaRelation). Where the read-back rides the one statement that writes R,
 * it is a CTE of that statement over the rows its RETURNING returns; where R's rows cross statements, the
 * transaction-scoped carrier they filled; the conservative realization's, computed by comparing the states before and
 * after the change, a carrier too. The delta of a relation no statement writes is the empty relation, as an empty closed
 * relation lowers. Outside a write program there is no delta, and the node is UnsupportedOperation.
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
	if (source.kind === "empty") {
		return emptyRelation(cx, node.heading, node.id)
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
	const from: FromSource =
		source.kind === "cte"
			? cteRefAs(source.cte, alias)
			: { kind: "table", table: source.carrier, alias }
	return distinctSelect(targets, [from], [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const deltaLowering: Lowerers<"Delta"> = { Delta: lowerDelta }
