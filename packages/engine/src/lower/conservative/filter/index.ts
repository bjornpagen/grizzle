import {
	extendEnv,
	headingTargets,
	type Lowerers,
	type NodeLowerer,
	wholeSelect
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"

/**
 * Filter: keep the tuples for which the predicate is true.
 *
 *   SELECT r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2) WHERE <predicate>
 *
 * The predicate reads its input's columns only (valid DAG), and outer values through the environment. Its non-null
 * proof is the IR's, so the plain WHERE keeps exactly the true bindings. The heading is the input's, so the rows kept of
 * a set are a set (wholeSelect), and of rows that may repeat, the node's set boundary makes them one.
 */
const lowerFilter: NodeLowerer<"Filter"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	const scope = extendEnv(env, [[node.input.id, input.map]])
	return wholeSelect(cx, node, [input.item], headingTargets(node.heading, input.map), [
		lowerExpr(cx, node.pred, scope)
	])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const filterLowering: Lowerers<"Filter"> = { Filter: lowerFilter }
