import {
	distinctSelect,
	extendEnv,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { lit, target } from "#compiler/sql/build.ts"

/**
 * ProjectSet: evaluate a new tuple for each input tuple and take the set of results.
 *
 *   SELECT DISTINCT <expr>, ... FROM (<input>) AS r2(c1, c2)
 *
 * The projection is the point at which equal outputs collapse. A logical projection is not evidence that
 * its SQL is unique, and the baseline uses no evidence, so the DISTINCT is always there:
 * dropping a key, following fanout, or a noninjective expression can each repeat an output.
 *
 * The heading is the projections' names in order (valid DAG), so the targets are the projections'.
 */
const lowerProjectSet: NodeLowerer<"ProjectSet"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	const scope = extendEnv(env, [node.input.id, input.map])
	const targets =
		node.out.length === 0
			? [target(lit.bool(true))]
			: node.out.map((o) => target(lowerExpr(cx, o.expr, scope)))
	return distinctSelect(targets, [input.item], [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const projectSetLowering: Lowerers<"ProjectSet"> = { ProjectSet: lowerProjectSet }
