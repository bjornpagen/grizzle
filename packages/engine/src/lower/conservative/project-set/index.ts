import type { NodeId } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	distinctSelect,
	extendEnv,
	type Lowerers,
	type NodeLowerer,
	wholeSelect
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { binaryCoercion } from "#compiler/scalar/compute/registry.ts"
import { target, unitTargets } from "#compiler/sql/build.ts"

/** The column of `input` an expression delivers with every value kept: the column, or its binary coercion. */
const keptColumn = (e: ScalarExpr, input: NodeId): string | undefined =>
	e.kind === "column"
		? e.column.node === input
			? e.column.name
			: undefined
		: e.kind === "cast" && e.cast === binaryCoercion
			? keptColumn(e.args[0], input)
			: undefined

/** Whether a projection delivers every column of its input with every value kept: its rows are its input's, renamed. */
const keepsEveryColumn = (node: NodeOf<"ProjectSet">): boolean => {
	const kept = new Set(node.out.map((o) => keptColumn(o.expr, node.input.id)))
	return node.input.heading.every((c) => kept.has(c.name))
}

/**
 * ProjectSet: evaluate a new tuple for each input tuple and take the set of results.
 *
 *   SELECT DISTINCT <expr>, ... FROM (<input>) AS r2(c1, c2)
 *
 * The projection is the point at which equal outputs collapse. A logical projection is not evidence that
 * its SQL is unique, and the baseline uses no evidence, so the DISTINCT is there wherever the projection may collapse
 * two tuples: dropping a key, following fanout, or a noninjective expression can each repeat an output. A projection
 * that delivers every input column with every value kept collapses none, so over a set it is the set renamed
 * (wholeSelect), with no deduplication.
 *
 * The heading is the projections' names in order (valid DAG), so the targets are the projections'.
 */
const lowerProjectSet: NodeLowerer<"ProjectSet"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	const scope = extendEnv(env, [[node.input.id, input.map]])
	const targets = isNonEmpty(node.out)
		? mapNonEmpty(node.out, (o) => target(lowerExpr(cx, o.expr, scope)))
		: unitTargets
	return keepsEveryColumn(node)
		? wholeSelect([input.item], targets, [])
		: distinctSelect(targets, [input.item], [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const projectSetLowering: Lowerers<"ProjectSet"> = { ProjectSet: lowerProjectSet }
