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
import type { Select } from "#compiler/sql/ast.ts"
import { binary, distinctCoreWhen, select, target } from "#compiler/sql/build.ts"

/**
 * r.intersection(a, b): the common points of two spans, zero or one span per binding.
 *
 *   SELECT DISTINCT r2.c1, (r2.c2 * r2.c3) FROM (<input>) AS r2(c1, c2, c3) WHERE r2.c2 && r2.c3
 *
 * `a * b` is PostgreSQL's range intersection, and `a && b` holds exactly when the spans share a point, so every
 * produced span is nonempty and a disjoint or merely adjacent pair yields no fact rather than an empty or NULL
 * pseudo-span. The guard is the GiST-indexable `&&` atom, never a widened test on lower()
 * and upper(). One binding yields at most one fact, so the produced heading is keyed by any input key
 * among the carried columns (analysis/physical produceProps); distinct bindings that agree on the carried columns and
 * intersect to one span collapse at the outer DISTINCT.
 */
export const intersectionQuery = (
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
	return select(
		distinctCoreWhen(
			form.distinct,
			appendNonEmpty(carriedTargets(node, input.map), target(binary("*", a, b))),
			[input.item],
			binary("&&", a, b)
		)
	)
}
