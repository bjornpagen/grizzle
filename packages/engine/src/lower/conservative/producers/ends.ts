import { appendNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ProducerNode } from "#compiler/ir/rel.ts"
import {
	type Env,
	extendEnv,
	type LowerContext,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"

import {
	carriedTargets,
	endpointArguments,
	type ProducerForm,
	producedQuery
} from "#compiler/lower/conservative/producers/shared.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { binary, call, target } from "#compiler/sql/build.ts"

/**
 * r.range(start, end): the span from a start to an end, two endpoints of one type, zero or one span per binding.
 *
 *   SELECT DISTINCT r2.c1, int8range(r2.c2, r2.c3) FROM (<input>) AS r2(c1, c2, c3) WHERE r2.c2 < r2.c3
 *
 * The endpoints' range constructor, int4range, int8range or daterange, with its default bounds, the start included and
 * the end excluded, so the produced span is [start, end), and `start < end` holds exactly when it is nonempty: an end
 * at or before its start, or a NULL endpoint, yields no fact rather than an empty, NULL or unbounded pseudo-span. One
 * binding yields at most one fact, so the produced heading is keyed by any input key among the carried columns, as an
 * intersection's is (ir/rel.ts piecesPerBinding).
 */
export const endsQuery = (
	node: ProducerNode<"spanFromEnds">,
	cx: LowerContext,
	env: Env,
	form: ProducerForm
): OperandSelect => {
	const at = nodeLabel(node)
	const input = cx.source(node.input, env)
	const scope = extendEnv(env, [[node.input.id, input.map]])
	const {
		args: [start, end],
		constructor
	} = endpointArguments(cx, node, scope, at)
	return producedQuery(
		form.produced,
		appendNonEmpty(carriedTargets(node, input.map), target(call(constructor, [start, end]))),
		[input.item],
		binary("<", start, end)
	)
}
