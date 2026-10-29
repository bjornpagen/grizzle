import { Refusal } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { makeCertificate } from "#compiler/ir/certificate.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type { AggregateSpec, NodeOf } from "#compiler/ir/rel.ts"
import {
	contractOf,
	numericTypmodOf,
	type ScalarType,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"

import {
	type ColumnMap,
	columnIn,
	type Env,
	extendEnv,
	type LowerContext,
	type NodeLowerer,
	namedMap,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { guardedSlope } from "#compiler/lower/conservative/group/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { aggregateOverload } from "#compiler/scalar/aggregate.ts"
import type { Expr, FromItem, TypeRef } from "#compiler/sql/ast.ts"
import {
	call,
	cast,
	col,
	core,
	countStar,
	derived,
	lit,
	select,
	target,
	types
} from "#compiler/sql/build.ts"
import { printType } from "#compiler/sql/print.ts"

/**
 * The shape an aggregate lowers as: R24's conditional count, sum(cond(p, 1, 0)) as count(*) FILTER (WHERE p), or its
 * native call, which every other aggregate is, sum(cond(p, x, 0)) as sum(CASE WHEN p THEN x ELSE 0 END) included.
 */
type AggregateShape =
	| { readonly kind: "conditionalCount"; readonly predicate: ScalarExpr }
	| { readonly kind: "native" }

const nativeCall: AggregateShape = { kind: "native" }

/**
 * An integer literal's value at display scale 0, or undefined: sum over a numeric 1.0 displays a scale that count(*)
 * does not, so it is no conditional count (scalar/aggregate.ts).
 */
const integerValue = (literal: TypedLiteral): bigint | undefined => {
	if (literal.kind === "int") {
		return literal.value
	}
	if (literal.kind !== "numeric") {
		return undefined
	}
	const text = decimalPayload(literal.value)
	const start = text.startsWith("-") ? 1 : 0
	if (text.length === start) {
		return undefined
	}
	for (let i = start; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x30 || code > 0x39) {
			return undefined
		}
	}
	return BigInt(text)
}

/**
 * The literals of a conditional count share one carrier, neither a contract nor a typmod: a numeric(5,2) literal 1
 * displays 1.00, so its sum displays a scale count(*) cast to numeric does not.
 */
const sameCarrier = (a: ScalarType, b: ScalarType): boolean =>
	a.carrier === b.carrier &&
	contractOf(a) === undefined &&
	contractOf(b) === undefined &&
	numericTypmodOf(a) === undefined &&
	vectorTypmodOf(a) === undefined &&
	numericTypmodOf(b) === undefined &&
	vectorTypmodOf(b) === undefined

/** Recognizes R24 in an aggregate of the IR. */
const aggregateShape = (agg: AggregateSpec): AggregateShape => {
	if (agg.fn !== "sum") {
		return nativeCall
	}
	const [arg] = agg.args
	if (arg.kind !== "cond") {
		return nativeCall
	}
	const [predicate, one, zero] = arg.args
	if (zero.kind !== "literal" || integerValue(zero.value) !== 0n) {
		return nativeCall
	}
	return one.kind === "literal" &&
		integerValue(one.value) === 1n &&
		sameCarrier(one.type, zero.type) &&
		one.value.kind === zero.value.kind
		? { kind: "conditionalCount", predicate }
		: nativeCall
}

const isBool = (agg: AggregateSpec): boolean => agg.args[0]?.type.carrier === "bool"

/**
 * The PostgreSQL result type of an aggregate's native call.
 *
 * min, max, bool_and and bool_or return their argument's base type: PostgreSQL resolves a domain argument to its
 * base type, and an enum keeps its enum.
 */
const nativeResultType = (
	cx: LowerContext,
	agg: AggregateSpec,
	shape: AggregateShape,
	at: string
) => {
	if (agg.fn === "count" || shape.kind === "conditionalCount") {
		return types.bigint
	}
	if (agg.fn === "regrSlope" || agg.fn === "regrSxx") {
		return types.double
	}
	const arg = agg.args[0].type
	if (agg.fn === "sum" || agg.fn === "avg") {
		const overload = aggregateOverload(
			{ name: agg.fn === "sum" ? "sum" : "mean", arg },
			SourceLoc(at, [])
		)
		if (!overload.ok) {
			throw new Refusal(overload.error)
		}
		return cx.baseTypeRef(overload.value.result)
	}
	return cx.baseTypeRef(arg)
}

const aggregateCall = (
	cx: LowerContext,
	agg: AggregateSpec,
	shape: AggregateShape,
	scope: Env
): Expr => {
	if (shape.kind === "conditionalCount") {
		return { ...countStar(), filter: lowerExpr(cx, shape.predicate, scope) }
	}
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

const castTo = (e: Expr, from: TypeRef, to: TypeRef): Expr =>
	printType(from) === printType(to) ? e : cast(e, to)

const certifyConditional = (facts: ShapeFacts, node: NodeOf<"Group">, agg: AggregateSpec): void => {
	const cert = makeCertificate({
		rule: "R24.conditionalCount",
		inputs: [node.input.id],
		outputs: [node.id],
		premises: [{ kind: "node", node: node.id }],
		context: "queryLocal",
		preservedHeading: [agg.name],
		equality: [],
		coercion: [],
		params: undefined
	})
	if (!cert.ok) {
		throw new Refusal(cert.error)
	}
	facts.certify(cert.value)
}

/**
 * Aggregates: fold the distinct complete bindings, with a constant group key and native types (R24).
 *
 * A Group folds the set of its complete bound tuple B, bindings omitted from find included: equal
 * bindings contribute once, distinct ones each contribute, and no DISTINCT after the fold repairs an overcount.
 * The fold therefore reads its input deduplicated on B unless the physical facts prove the input, as
 * realized, has exactly one row per B (analysis/contribution). Binding (account, amount) of a
 * Posting keyed by id keeps the inner DISTINCT; binding (id, account, amount) elides it, so two postings with equal
 * amounts both contribute.
 *
 *   SELECT r3.c4, sum(r3.c5) FROM (SELECT DISTINCT r2.c2, r2.c3 FROM (<input>) AS r2(c1, c2, c3)) AS r3(c4, c5)
 *   GROUP BY r3.c4
 *
 * An aggregate-only fold groups by a constant private column `true` carried by real input rows, so an empty input
 * creates no group and no NULL-bearing row; no literal is a GROUP BY item. Its single
 * output row needs no outer DISTINCT, nor does a grouped fold's, whose group key is a key of its output.
 *
 * Types are PostgreSQL's own overloads (scalar/aggregate.ts): count is bigint, a bigint sum numeric, min and
 * max keep their input's type. Where the native result type differs from the IR's heading type, as min or max over a
 * contract returns the contract's base, the result is cast to the IR type.
 *
 * R24: `sum(cond(p, 1, 0))` is `count(*) FILTER (WHERE p)`, exact because count over
 * no qualifying row is zero, cast to the composition's sum type when that is not bigint; `sum(cond(p, x, 0))` stays
 * `sum(CASE WHEN p THEN x ELSE 0 END)` with the zero of x's type, never `sum(x) FILTER (WHERE p)`, which is NULL for a
 * group where no binding satisfies p.
 *
 * One row per B already: fold the input directly.
 */
export const aggregateLowerer =
	(facts: ShapeFacts): NodeLowerer<"Group"> =>
	(node, cx, env) => {
		const at = nodeLabel(node)
		const input = cx.source(node.input, env)
		const aggregateOnly = node.keys.length === 0
		const exact = facts.contributionExact(node)
		let from: FromItem
		let bound: ColumnMap
		let present: Expr | undefined
		if (exact && !aggregateOnly) {
			from = input.item
			bound = input.map
		} else {
			/** SELECT [DISTINCT] <B> [, true] FROM (<input>): the contributions, and the carried constant group key. */
			const boundTargets = node.bound.map((name) => target(columnIn(input.map, name)))
			const contributions = select({
				...core(
					aggregateOnly ? [...boundTargets, target(lit.bool(true))] : boundTargets,
					[input.item],
					undefined
				),
				distinct: !exact
			})
			const origin = { kind: "node", node: node.id } as const
			const named = cx.freshColumns(node.bound, origin)
			const presentColumn = aggregateOnly ? cx.supply.column(origin) : undefined
			const alias = cx.relationAlias(origin)
			const columns = named.map((n) => n.column)
			from = derived(
				contributions,
				alias,
				presentColumn === undefined ? columns : [...columns, presentColumn],
				false
			)
			bound = namedMap(alias, named)
			if (presentColumn !== undefined) {
				present = col(alias, presentColumn)
			}
		}
		/** The aggregates read the bound tuple only (valid DAG), through the input's node id. */
		const scope = extendEnv(env, [node.input.id, bound])
		const aggOf = new Map(node.aggs.map((a) => [a.name, a]))
		const targets = node.heading.map((c) => {
			if (node.keys.includes(c.name)) {
				return target(columnIn(bound, c.name))
			}
			const agg = columnIn(aggOf, c.name)
			const shape = aggregateShape(agg)
			if (shape.kind === "conditionalCount") {
				certifyConditional(facts, node, agg)
			}
			const native = nativeResultType(cx, agg, shape, at)
			return target(castTo(aggregateCall(cx, agg, shape, scope), native, cx.typeRef(c.type, at)))
		})
		const groupBy = present !== undefined ? [present] : node.keys.map((k) => columnIn(bound, k))
		return select({
			...core(targets.length === 0 ? [target(lit.bool(true))] : targets, [from], undefined),
			groupBy
		})
	}
