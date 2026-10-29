import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	columnIn,
	type Env,
	extendEnv,
	type LowerContext,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import {
	call,
	core,
	countStar,
	derived,
	lit,
	ne,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

type Aggregate = NodeOf<"Group">["aggs"][number]

const isBool = (agg: Aggregate): boolean => agg.args[0]?.type.carrier === "bool"

/**
 * R32's regression slope over (y, x), evaluated only under the test that makes it a value:
 * `CASE WHEN regr_sxx(y, x) <> 0 THEN regr_slope(y, x) ELSE 0 END` (shapes/catalog/native.ts). Every lowering of a
 * regrSlope aggregate builds it so.
 */
export const guardedSlope = (args: ReadonlyArray<Expr>): Expr => ({
	kind: "case",
	whens: [
		{
			when: ne(call("regr_sxx", args), lit.float(0, types.double)),
			result: call("regr_slope", args)
		}
	],
	else: lit.float(0, types.double),
	operand: undefined
})

const aggregateCall = (cx: LowerContext, agg: Aggregate, scope: Env): Expr => {
	const args = agg.args.map((a) => lowerExpr(cx, a, scope))
	switch (agg.fn) {
		case "count":
			return agg.filter === undefined
				? countStar()
				: { ...countStar(), filter: lowerExpr(cx, agg.filter, scope) }
		case "sum":
			return call("sum", args)
		case "avg":
			return call("avg", args)
		case "min":
			return call(isBool(agg) ? "bool_and" : "min", args)
		case "max":
			return call(isBool(agg) ? "bool_or" : "max", args)
		case "boolAnd":
			return call("bool_and", args)
		case "boolOr":
			return call("bool_or", args)
		case "regrSlope":
			return guardedSlope(args)
		case "regrSxx":
			return call("regr_sxx", args)
	}
}

/**
 * Group: fold the rule's distinct complete bindings, grouped by the nonaggregate head terms.
 *
 *   SELECT r3.c4, sum(r3.c5) FROM (SELECT DISTINCT r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2)) AS r3(c4, c5)
 *   GROUP BY r3.c4
 *
 * The aggregate's input is the set of the complete bound tuple B, bindings omitted from find included, deduplicated
 * before the fold: equal bindings contribute once and distinct ones each contribute, and
 * a DISTINCT after the fold could not repair an overcount. An aggregate-only group has no key, so the
 * bound tuple carries one more column, the constant private group key `true`, and the fold groups by that column: an
 * empty input creates no group and no NULL-bearing aggregate row. No literal is a GROUP BY item;
 * the constant is a column its input carries.
 *
 * Boolean min and max are bool_and and bool_or over actual groups; count is count(*), and only count is
 * filtered.
 */
const lowerGroup: NodeLowerer<"Group"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	const aggregateOnly = node.keys.length === 0
	/** SELECT DISTINCT <bound tuple> [, true]: the contributions. */
	const boundTargets = node.bound.map((name) => target(columnIn(input.map, name)))
	const contributions = select({
		...core(
			aggregateOnly ? [...boundTargets, target(lit.bool(true))] : boundTargets,
			[input.item],
			undefined
		),
		distinct: true
	})
	const origin = { kind: "node", node: node.id } as const
	const boundColumns = node.bound.map((name) => ({ name, column: cx.supply.column(origin) }))
	const presentColumns = aggregateOnly ? [cx.supply.column(origin)] : []
	const columns = [...boundColumns.map((b) => b.column), ...presentColumns]
	const alias = cx.relationAlias(origin)
	const bound = new Map<string, Expr>()
	for (const { name, column } of boundColumns) {
		bound.set(name, { kind: "column", table: alias, column })
	}
	/**
	 * The aggregates read the bound tuple only, and each heading column is a key, within the bound tuple, or an
	 * aggregate (valid DAG), read through the input's node id.
	 */
	const scope = extendEnv(env, [node.input.id, bound])
	const aggOf = new Map(node.aggs.map((a) => [a.name, a]))
	const targets = node.heading.map((c) =>
		target(
			node.keys.includes(c.name)
				? columnIn(bound, c.name)
				: aggregateCall(cx, columnIn(aggOf, c.name), scope)
		)
	)
	const groupBy: ReadonlyArray<Expr> = aggregateOnly
		? presentColumns.map((column) => ({ kind: "column", table: alias, column }))
		: node.keys.map((k) => columnIn(bound, k))
	return select({
		...core(
			targets.length === 0 ? [target(lit.bool(true))] : targets,
			[derived(contributions, alias, columns, false)],
			undefined
		),
		groupBy
	})
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const groupLowering: Lowerers<"Group"> = { Group: lowerGroup }
