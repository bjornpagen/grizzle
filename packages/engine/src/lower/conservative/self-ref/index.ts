import {
	distinctSelect,
	headingTargets,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	namedMap,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { cteRefAs } from "#compiler/sql/build.ts"

/**
 * SelfRef: a recursive relation's single feedback reference, read by its step.
 *
 *   SELECT DISTINCT r5.c1, r5.c2 FROM r1 AS r5
 *
 * It scans the recursive CTE its Recursive node is lowering, under a fresh alias. PostgreSQL admits one such reference
 * in the recursive term and refuses it inside a subquery expression or an outer join; a valid
 * DAG holds the SelfRef inside the step, by construction, and this plug-in refuses what PostgreSQL would reject with
 * 42P19 rather than emit it:
 *
 * - a second scan in one step: a nonlinear self-join, or several transition arms that each read the feedback, which
 *   must be factored to one feedback scan first;
 * - a scan inside an EXISTS or NOT EXISTS of the recursive term (sublinkDepth); a semi-join that reads the feedback on
 *   its right lowers as a join instead (semi-join/exists.ts).
 */
const lowerSelfRef: NodeLowerer<"SelfRef"> = (node, cx: LowerContext) => {
	const at = nodeLabel(node)
	const feedback = cx.feedback.get(node.recursive)
	if (feedback === undefined) {
		return refuse(
			"MalformedDescription",
			at,
			`a feedback reference read inside the step of ${node.recursive}`
		)
	}
	if (feedback.reads > 0) {
		return refuse(
			"UnsupportedOperation",
			at,
			`a single feedback reference in the step of ${node.recursive}: factor a nonlinear self-join or several transition arms to one feedback scan`
		)
	}
	if (cx.sublinkDepth > feedback.sublinkDepth) {
		return refuse(
			"UnsupportedOperation",
			at,
			`a feedback reference of ${node.recursive} outside a subquery expression, which PostgreSQL refuses`
		)
	}
	feedback.reads += 1
	const alias = cx.relationAlias({ kind: "node", node: node.id })
	/** A SelfRef's heading is its recursive relation's (valid DAG), whose state columns the feedback names. */
	const map = namedMap(alias, feedback.columns)
	return distinctSelect(headingTargets(node.heading, map), [cteRefAs(feedback.cte, alias)], [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const selfRefLowering: Lowerers<"SelfRef"> = { SelfRef: lowerSelfRef }
