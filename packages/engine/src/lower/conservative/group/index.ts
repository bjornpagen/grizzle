import { Refusal } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { appendNonEmpty } from "#compiler/core/nonempty.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	extendEnv,
	type InputSource,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	namedMap,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { exactNumeric, roundToFloat } from "#compiler/lower/conservative/expr/total.ts"
import {
	type AggregateOverload,
	callOverload,
	type ExactCarrier
} from "#compiler/scalar/aggregate.ts"
import type { Call, CountStar, Expr, FromSource, WindowSpec } from "#compiler/sql/ast.ts"
import { binary, call, core, countStar, derived, lit, select, target } from "#compiler/sql/build.ts"

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
 * Group: fold the input's rows, grouped by the nonaggregate head terms.
 *
 *   SELECT r2.c2, sum(r2.c3) FROM (<input>) AS r2(c1, c2, c3) GROUP BY r2.c2
 *
 * The bound tuple B is a key of the input (ir/rel.ts FoldInput): every fact the rule matches is read by a key the
 * bindings hold, so the input, a set over its heading as every conservative fragment is, holds one row per value of B,
 * and each row is one contribution. An aggregate-only group has no key, so the input is read through B and one more
 * column, the constant private group key `true`, one row per input row, and the fold groups by that column: an empty
 * input creates no group and no NULL-bearing aggregate row. No literal is a GROUP BY item; the constant is a column its
 * input carries.
 *
 * Boolean min and max are bool_and and bool_or over actual groups; count is count(*), and only count is
 * filtered. Each aggregate is its overload's lowering (aggregateExpr), so it is a function of its contributions, one
 * per keyed row, in any order.
 */
const lowerGroup: NodeLowerer<"Group"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	const read = groupRead(node, cx, input)
	/**
	 * The aggregates read the bound tuple only, and each heading column is a key, within the bound tuple, or an
	 * aggregate (valid DAG), read through the input's node id.
	 */
	const scope = extendEnv(env, [[node.input.id, read.bound]])
	const aggOf = new Map(node.aggs.map((a) => [a.name, a]))
	const targets = node.heading.map((c) =>
		target(
			node.keys.includes(c.name)
				? columnIn(read.bound, c.name)
				: aggregateCall(cx, columnIn(aggOf, c.name), scope, nodeLabel(node))
		)
	)
	const groupBy: ReadonlyArray<Expr> =
		read.present === undefined ? node.keys.map((k) => columnIn(read.bound, k)) : [read.present]
	return select({
		...core(targets.length === 0 ? [target(lit.bool(true))] : targets, [read.from], undefined),
		groupBy
	})
}

/**
 * What a fold reads: its input as it is, for a fold with group keys; for an aggregate-only fold, its input through B
 * and the carried constant group key, one row per input row since B is a key of it.
 */
const groupRead = (
	node: NodeOf<"Group">,
	cx: LowerContext,
	input: InputSource
): {
	readonly from: FromSource
	readonly bound: ColumnMap
	readonly present: Expr | undefined
} => {
	if (node.keys.length > 0) {
		return { from: input.item, bound: input.map, present: undefined }
	}
	const targets = appendNonEmpty(
		node.bound.columns.map((name) => target(columnIn(input.map, name))),
		target(lit.bool(true))
	)
	const origin = { kind: "node", node: node.id } as const
	const boundColumns = node.bound.columns.map((name) => ({ name, column: cx.supply.column(origin) }))
	const presentColumn = cx.supply.column(origin)
	const alias = cx.relationAlias(origin)
	return {
		from: derived(
			select(core(targets, [input.item], undefined)),
			alias,
			[...boundColumns.map((b) => b.column), presentColumn],
			false
		),
		bound: namedMap(alias, boundColumns),
		present: { kind: "column", table: alias, column: presentColumn }
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const groupLowering: Lowerers<"Group"> = { Group: lowerGroup }
