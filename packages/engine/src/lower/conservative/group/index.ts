import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { appendNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { unwrap } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { AggregateCallOver, NodeOf } from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
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
import {
	exactNumeric,
	roundToFloat,
	signedZeroOf
} from "#compiler/lower/conservative/expr/total.ts"
import {
	type AggregateOverload,
	callOverload,
	type ExactCarrier
} from "#compiler/scalar/aggregate.ts"
import { excludesZero } from "#compiler/scalar/compute/typing.ts"
import type { Call, CountStar, Expr, FromSource, WindowSpec } from "#compiler/sql/ast.ts"
import {
	binary,
	call,
	cast,
	core,
	countStar,
	derived,
	eq,
	keyedRead,
	lit,
	operandSelect,
	select,
	target,
	types
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"

type Aggregate = NodeOf<"Group">["aggs"][number]

/** An aggregate of one argument's argument, which every lowering but count's reads. */
const argumentOf = (args: ReadonlyArray<Expr>): Expr => defined(args[0], "an aggregate's argument")

/** A float type's zero of one sign, a literal of its SQL type. */
const zeroOf = (float: "float4" | "float8", negative: boolean): Expr =>
	lit.float(negative ? -0 : 0, float === "float4" ? types.real : types.double)

/**
 * What an aggregate's argument proves of a float's -0, which a float's zero work reads (aggregateExpr): `unsigned`, that
 * it holds none, no argument or a term whose own form proves it (holdsNoNegativeZero), so a float's zeros are one value
 * there, its native extreme is IEEE 754-2019's and its zero total +0; or `signed`, nothing, so a float's extreme and
 * zero total read their zero's sign off its rows. Only a float's lowerings read it: no other type has two zeros.
 */
export type ArgumentZeros = "signed" | "unsigned"

/** The carriers of an integer, whose one zero a cast to a float takes to +0. */
const integerCarriers: ReadonlySet<string> = new Set(["int2", "int4", "int8", "exactInteger"])

/**
 * Whether a float term holds no -0, by its own form: its type holds no zero (scalar/compute/typing.ts excludesZero, a
 * contract whose predicate excludes it); it is a cast of an integer, whose one zero is +0; a literal other than -0; or
 * a Logic.cond whose two values hold none.
 */
const holdsNoNegativeZero = (e: ScalarExpr): boolean => {
	if (excludesZero(e.type)) {
		return true
	}
	if (e.kind === "literal") {
		return !(e.value.kind === "floatSpecial" && e.value.value === "-0")
	}
	if (e.kind === "cast") {
		return integerCarriers.has(baseOf(e.args[0].type).carrier)
	}
	return e.kind === "cond" && holdsNoNegativeZero(e.args[1]) && holdsNoNegativeZero(e.args[2])
}

/** What an aggregate's argument proves of a float's -0 (ArgumentZeros): count's none, as it reads no value. */
export const argumentZeros = (agg: AggregateCallOver<ScalarExpr>): ArgumentZeros =>
	agg.fn === "count" || holdsNoNegativeZero(agg.args[0]) ? "unsigned" : "signed"

/**
 * IEEE 754's sum, over an argument's rows, of `zero` where the argument is zero and of `other` where it is not: a zero
 * whose sign is the rows', in any order. -0 is the sum's identity, so `other` -0 sums the zeros alone, -0 exactly when
 * each is -0; +0 absorbs -0, so `other` +0 is -0 exactly when every row is -0. It reads zeros alone, and never
 * overflows.
 */
const zerosSum = (
	float: "float4" | "float8",
	arg: Expr,
	zero: Expr,
	other: Expr,
	window: WindowSpec | undefined
): Expr => ({
	...call("sum", [
		{
			kind: "case",
			operand: undefined,
			whens: [{ when: eq(arg, zeroOf(float, false)), result: zero }],
			else: other
		}
	]),
	over: window
})

/**
 * The zero of a float sum or mean that is zero: -0 exactly when every row is -0, as IEEE 754's sum of them is, and
 * JavaScript's Math.sumPrecise: a +0 or any nonzero value makes it +0. An argument that holds no -0 (ArgumentZeros)
 * has +0 alone, with no sum.
 */
const signedZero = (
	float: "float4" | "float8",
	arg: Expr,
	zeros: ArgumentZeros,
	window: WindowSpec | undefined
): Expr =>
	zeros === "unsigned"
		? zeroOf(float, false)
		: zerosSum(float, arg, arg, zeroOf(float, false), window)

/**
 * A float's min or max over its rows with IEEE 754-2019's zero (scalar/aggregate.ts signedExtreme): the native extreme,
 * and where it is zero the least zero -0 when any row's is, the greatest +0 when any row's is, read off the IEEE sum of
 * the rows' zeros, negated for min: CASE WHEN min(x) = 0 THEN -sum(CASE WHEN x = 0 THEN -x ELSE -0 END) ELSE min(x)
 * END. An argument that holds no -0 (ArgumentZeros) has one zero, so its native extreme is IEEE 754-2019's.
 */
const signedExtremeOf = (
	fn: "min" | "max",
	float: "float4" | "float8",
	arg: Expr,
	zeros: ArgumentZeros,
	window: WindowSpec | undefined
): Expr => {
	const native: Expr = { ...call(fn, [arg]), over: window }
	if (zeros === "unsigned") {
		return native
	}
	const negated = (e: Expr): Expr => ({ kind: "negate", expr: e })
	const zero =
		fn === "max"
			? zerosSum(float, arg, arg, zeroOf(float, true), window)
			: negated(zerosSum(float, arg, negated(arg), zeroOf(float, true), window))
	return {
		kind: "case",
		operand: undefined,
		whens: [{ when: eq(native, zeroOf(float, false)), result: zero }],
		else: native
	}
}

/**
 * An exact sum's numeric total as its result: a float's rounded once to its carrier as IEEE 754 rounds, ±Infinity past
 * the largest finite value, a zero total of its rows' signs (total.ts roundToFloat, signedZero); money's the exact
 * amount itself, exact money, which no sum overflows.
 */
const roundedSum = (
	total: Expr,
	exact: ExactCarrier,
	arg: Expr,
	zeros: ArgumentZeros,
	window: WindowSpec | undefined
): Expr => {
	switch (exact) {
		case "float4":
		case "float8":
			return roundToFloat(total, exact, signedZero(exact, arg, zeros, window))
		case "money":
			return total
	}
}

/**
 * An exact mean: the exact total, its display scale trimmed because numeric_div reads it (registry.ts OperandReading),
 * over the count, rounded once to double precision as IEEE 754 rounds; one below half the least subnormal the zero of
 * its sign, the total's, and a mean of a zero total, or of a positive one too small, its rows' signs' (cast to double
 * precision from a real's), +0 wherever a row is nonzero (total.ts signedZeroOf).
 */
const roundedMean = (
	total: Expr,
	count: Expr,
	exact: "float4" | "float8",
	arg: Expr,
	zeros: ArgumentZeros,
	window: WindowSpec | undefined
): Expr =>
	roundToFloat(
		binary("/", call("trim_scale", [total]), count),
		"float8",
		signedZeroOf(total, "float8", cast(signedZero(exact, arg, zeros, window), types.double))
	)

/**
 * An aggregate's SQL as its overload's lowering states it (scalar/aggregate.ts AggregateLowering): the one place an
 * overload becomes SQL, which every emitter calls, a grouped fold with no window and a running fold with its window.
 * Each aggregate call it writes takes `window` as its OVER, and count(*) takes `filter`, the one filtered aggregate. A
 * float's zero work is done only where its argument may hold -0 (`zeros`, argumentZeros).
 */
export const aggregateExpr = (
	overload: AggregateOverload,
	args: ReadonlyArray<Expr>,
	filter: Expr | undefined,
	window: WindowSpec | undefined,
	zeros: ArgumentZeros
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
		case "widened":
			return over(
				call(
					overload.sql,
					args.map((a) => cast(a, types.bigint))
				)
			)
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
				lowering.exact,
				argumentOf(args),
				zeros,
				window
			)
		case "exactMean":
			return roundedMean(
				over(
					call(
						"sum",
						args.map((a) => exactNumeric(a, lowering.exact))
					)
				),
				counted(undefined),
				lowering.exact,
				argumentOf(args),
				zeros,
				window
			)
		case "signedExtreme":
			return signedExtremeOf(lowering.fn, lowering.float, argumentOf(args), zeros, window)
	}
}

/** The overload of a Group's aggregate over its arguments' types, refused where PostgreSQL defines none. */
export const groupAggregateOverload = (agg: Aggregate, at: string): AggregateOverload => {
	return unwrap(callOverload(agg, SourceLoc(at, [])))
}

const aggregateCall = (cx: LowerContext, agg: Aggregate, scope: Env, at: string): Expr =>
	aggregateExpr(
		groupAggregateOverload(agg, at),
		agg.args.map((a) => lowerExpr(cx, a, scope)),
		agg.filter === undefined ? undefined : lowerExpr(cx, agg.filter, scope),
		undefined,
		argumentZeros(agg)
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
		rows: read.present === undefined ? "grouped" : "oneRow",
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
	const boundColumns = node.bound.columns.map((name) => ({
		name,
		column: cx.supply.column(origin)
	}))
	const presentColumn = cx.supply.column(origin)
	const alias = cx.relationAlias(origin)
	return {
		from: derived(
			namedQuery(operandSelect(keyedRead(targets, [input.item], undefined)), [
				...boundColumns.map((b) => b.column),
				presentColumn
			]),
			alias,
			false
		),
		bound: namedMap(alias, boundColumns),
		present: { kind: "column", table: alias, column: presentColumn }
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const groupLowering: Lowerers<"Group"> = { Group: lowerGroup }
