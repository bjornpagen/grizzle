import { appendNonEmpty } from "#compiler/core/nonempty.ts"
import type { ProducerNode } from "#compiler/ir/rel.ts"
import {
	type Env,
	extendEnv,
	type LowerContext,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"

import {
	carriedTargets,
	type ProducerForm,
	spanArguments
} from "#compiler/lower/conservative/producers/shared.ts"
import type { FromItem, Select } from "#compiler/sql/ast.ts"
import { call, col, distinctCoreWhen, select, target } from "#compiler/sql/build.ts"

/**
 * r.difference(a, b): the points of a outside b, zero, one or two spans per binding.
 *
 *   SELECT DISTINCT r2.c1, r3.c4
 *   FROM (<input>) AS r2(c1, c2, c3), LATERAL range_minus_multi(r2.c2, r2.c3) AS r3(c4)
 *
 * PostgreSQL 19's range_minus_multi is the set-returning binary difference: zero rows when b covers a, a itself when
 * they share no point, and otherwise one or two disjoint nonempty pieces. It is evaluated once per binding as a LATERAL
 * FROM producer correlated to the input row, so the complete bound tuple is retained beside its pieces.
 * Ordinary range `a - b` raises when the difference has two disconnected pieces, so it is never the lowering.
 *
 * The pieces of one invocation are distinct, so the produced heading is keyed by an input key among the carried columns
 * plus the piece (analysis/physical produceProps). Different bindings can produce identical pieces: the
 * outer DISTINCT is the conservative boundary, and the optimized lowering keeps it unless that proof holds.
 */
export const differenceQuery = (
	node: ProducerNode<"spanIntersection" | "spanDifference">,
	cx: LowerContext,
	env: Env,
	form: ProducerForm
): Select => {
	const at = nodeLabel(node)
	const input = cx.source(node.input, env)
	const scope = extendEnv(env, [[node.input.id, input.map]])
	const {
		args: [a, b]
	} = spanArguments(cx, node, scope, at)
	const origin = { kind: "node", node: node.id } as const
	const alias = cx.relationAlias(origin)
	const piece = cx.supply.column(origin)
	const pieces: FromItem = {
		kind: "function",
		call: call("range_minus_multi", [a, b]),
		alias,
		columns: [piece],
		lateral: true
	}
	return select(
		distinctCoreWhen(
			form.distinct,
			appendNonEmpty(carriedTargets(node, input.map), target(col(alias, piece))),
			[input.item, pieces],
			undefined
		)
	)
}
