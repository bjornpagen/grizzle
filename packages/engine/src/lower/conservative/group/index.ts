import { Refusal } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { appendNonEmpty, isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	columnIn,
	type Env,
	extendEnv,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { exactNumeric, roundToFloat } from "#compiler/lower/conservative/expr/total.ts"
import {
	type AggregateOverload,
	callOverload,
	type ExactCarrier
} from "#compiler/scalar/aggregate.ts"
import type { Call, CountStar, Expr, Target, WindowSpec } from "#compiler/sql/ast.ts"
import {
	binary,
	call,
	core,
	countStar,
	derived,
	distinctCore,
	lit,
	select,
	target
} from "#compiler/sql/build.ts"

type Aggregate = NodeOf<"Group">["aggs"][number]

/**
 * An exact sum's numeric total as its result: a float's rounded once to its carrier as IEEE 754 rounds, ±Infinity past
 * the largest finite value (total.ts roundToFloat); money's the exact amount itself, exact money, which no sum
 * overflows.
 */
const roundedSum = (total: Expr, exact: ExactCarrier): Expr => {
	switch (exact) {
		case "float4":
			return roundToFloat(total, "float4")
		case "float8":
			return roundToFloat(total, "float8")
		case "money":
			return total
	}
}

/**
 * An exact mean: the exact total, its display scale trimmed because numeric_div reads it (I2), over the count, rounded
 * once to double precision as IEEE 754 rounds.
 */
const roundedMean = (total: Expr, count: Expr): Expr =>
	roundToFloat(binary("/", call("trim_scale", [total]), count), "float8")

/**
 * An aggregate's SQL as its overload's lowering states it (scalar/aggregate.ts AggregateLowering): the one place an
 * overload becomes SQL, which every emitter calls, a grouped fold with no window and a running fold with its window.
 * Each aggregate call it writes takes `window` as its OVER, and count(*) takes `filter`, the one filtered aggregate.
 */
export const aggregateExpr = (
	overload: AggregateOverload,
	args: ReadonlyArray<Expr>,
	filter: Expr | undefined,
	window: WindowSpec | undefined
): Expr => {
	const over = (c: Call): Call => ({ ...c, over: window })
	const counted = (where: Expr | undefined): CountStar => ({
		...countStar(),
		filter: where,
		over: window
	})
	const lowering = overload.lowering
	switch (lowering.kind) {
		case "native":
			return overload.fn === "count" ? counted(filter) : over(call(overload.sql, args))
		case "scaleFree":
			return over(
				call(
					overload.sql,
					args.map((a) => call("trim_scale", [a]))
				)
			)
		case "exactSum":
			return roundedSum(
				over(
					call(
						"sum",
						args.map((a) => exactNumeric(a, lowering.exact))
					)
				),
				lowering.exact
			)
		case "exactMean":
			return roundedMean(
				over(
					call(
						"sum",
						args.map((a) => exactNumeric(a, lowering.exact))
					)
				),
				counted(undefined)
			)
	}
}

/** The overload of a Group's aggregate over its arguments' types, refused where PostgreSQL defines none. */
export const groupAggregateOverload = (agg: Aggregate, at: string): AggregateOverload => {
	const overload = callOverload(agg, SourceLoc(at, []))
	if (!overload.ok) {
		throw new Refusal(overload.error)
	}
	return overload.value
}

const aggregateCall = (cx: LowerContext, agg: Aggregate, scope: Env, at: string): Expr =>
	aggregateExpr(
		groupAggregateOverload(agg, at),
		agg.args.map((a) => lowerExpr(cx, a, scope)),
		agg.filter === undefined ? undefined : lowerExpr(cx, agg.filter, scope),
		undefined
	)

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
 * filtered. Each aggregate is its overload's lowering (aggregateExpr), so it is a function of its arguments' multiset.
 */
const lowerGroup: NodeLowerer<"Group"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	const aggregateOnly = node.keys.length === 0
	const boundTargets = node.bound.map((name) => target(columnIn(input.map, name)))
	/**
	 * SELECT DISTINCT <bound tuple> [, true]: the contributions, the constant private group key after the bound tuple
	 * exactly when the fold has no key, as a bound tuple of no field has none.
	 */
	const read: { readonly targets: NonEmptyReadonlyArray<Target>; readonly present: boolean } =
		!aggregateOnly && isNonEmpty(boundTargets)
			? { targets: boundTargets, present: false }
			: { targets: appendNonEmpty(boundTargets, target(lit.bool(true))), present: true }
	const contributions = select(distinctCore(read.targets, [input.item], undefined))
	const origin = { kind: "node", node: node.id } as const
	const boundColumns = node.bound.map((name) => ({ name, column: cx.supply.column(origin) }))
	const presentColumns = read.present ? [cx.supply.column(origin)] : []
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
	const scope = extendEnv(env, [[node.input.id, bound]])
	const aggOf = new Map(node.aggs.map((a) => [a.name, a]))
	const targets = node.heading.map((c) =>
		target(
			node.keys.includes(c.name)
				? columnIn(bound, c.name)
				: aggregateCall(cx, columnIn(aggOf, c.name), scope, nodeLabel(node))
		)
	)
	const groupBy: ReadonlyArray<Expr> = read.present
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
