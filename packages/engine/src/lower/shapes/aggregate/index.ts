import { Refusal } from "#compiler/core/canonical.ts"
import { appendNonEmpty, isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { makeCertificate } from "#compiler/ir/certificate.ts"
import { integerLiteral, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { AggregateSpec, NodeOf } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType, vectorTypmodOf } from "#compiler/ir/scalar.ts"

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
import { aggregateExpr, groupAggregateOverload } from "#compiler/lower/conservative/group/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { AggregateOverload } from "#compiler/scalar/aggregate.ts"
import type { Expr, FromItem, Target, TypeRef } from "#compiler/sql/ast.ts"
import {
	cast,
	col,
	core,
	countStar,
	derived,
	distinctCoreWhen,
	lit,
	sameTypeRef,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

/**
 * The shape an aggregate lowers as: R24's conditional count, sum(cond(p, 1, 0)) as count(*) FILTER (WHERE p), or its
 * native call, which every other aggregate is, sum(cond(p, x, 0)) as sum(CASE WHEN p THEN x ELSE 0 END) included.
 */
type AggregateShape =
	| { readonly kind: "conditionalCount"; readonly predicate: ScalarExpr }
	| { readonly kind: "native" }

const nativeCall: AggregateShape = { kind: "native" }

/**
 * The literals of a conditional count share one carrier and are no contract: a value 1 of any numeric typmod is the
 * integer 1, whose sum count(*) cast to numeric equals.
 */
const sameCarrier = (a: ScalarType, b: ScalarType): boolean =>
	a.carrier === b.carrier &&
	contractOf(a) === undefined &&
	contractOf(b) === undefined &&
	vectorTypmodOf(a) === undefined &&
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
	if (zero.kind !== "literal" || integerLiteral(zero.value) !== 0n) {
		return nativeCall
	}
	return one.kind === "literal" &&
		integerLiteral(one.value) === 1n &&
		sameCarrier(one.type, zero.type) &&
		one.value.kind === zero.value.kind
		? { kind: "conditionalCount", predicate }
		: nativeCall
}

/**
 * The PostgreSQL result type of an aggregate's lowered call: bigint for a count, conditional or not, and otherwise
 * its overload's result's base, since PostgreSQL resolves a domain argument of min, max, bool_and and bool_or to its
 * base type, a closed id's smallint code among them.
 */
const nativeResultType = (
	cx: LowerContext,
	overload: AggregateOverload,
	shape: AggregateShape
): TypeRef => (shape.kind === "conditionalCount" ? types.bigint : cx.baseTypeRef(overload.result))

const aggregateCall = (
	cx: LowerContext,
	agg: AggregateSpec,
	overload: AggregateOverload,
	shape: AggregateShape,
	scope: Env
): Expr => {
	switch (shape.kind) {
		case "conditionalCount":
			return { ...countStar(), filter: lowerExpr(cx, shape.predicate, scope) }
		case "native":
			return aggregateExpr(
				overload,
				agg.args.map((a) => lowerExpr(cx, a, scope)),
				agg.filter === undefined ? undefined : lowerExpr(cx, agg.filter, scope),
				undefined
			)
	}
}

const castTo = (e: Expr, from: TypeRef, to: TypeRef): Expr =>
	sameTypeRef(from, to) ? e : cast(e, to)

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
 * contract returns the contract's base, the result is cast to the IR type. Each aggregate is its overload's lowering
 * (conservative/group aggregateExpr): a sum or mean over real, double precision or money accumulates exact values and
 * rounds once, so the fold is a function of its contributions' multiset under every plan.
 *
 * R24: `sum(cond(p, 1, 0))` is `count(*) FILTER (WHERE p)`, exact because count over
 * no qualifying row is zero, cast to the composition's sum type when that is not bigint; `sum(cond(p, x, 0))` stays
 * `sum(CASE WHEN p THEN x ELSE 0 END)` with the zero of x's type, never `sum(x) FILTER (WHERE p)`, which is NULL for a
 * group where no binding satisfies p; over real, double precision or money the exact value is taken of the CASE, the
 * argument. The count's literals are integers by value, so sum(cond(p, 1.0, 0)) and typmod literals are counts too.
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
			const boundTargets = node.bound.map((name) => target(columnIn(input.map, name)))
			/**
			 * SELECT [DISTINCT] <B> [, true] FROM (<input>): the contributions, and the carried constant group key, after
			 * the bound tuple exactly when the fold has no key, as a bound tuple of no field has none.
			 */
			const read: { readonly targets: NonEmptyReadonlyArray<Target>; readonly present: boolean } =
				!aggregateOnly && isNonEmpty(boundTargets)
					? { targets: boundTargets, present: false }
					: { targets: appendNonEmpty(boundTargets, target(lit.bool(true))), present: true }
			const contributions = select(distinctCoreWhen(!exact, read.targets, [input.item], undefined))
			const origin = { kind: "node", node: node.id } as const
			const named = cx.freshColumns(node.bound, origin)
			const presentColumn = read.present ? cx.supply.column(origin) : undefined
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
		const scope = extendEnv(env, [[node.input.id, bound]])
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
			const overload = groupAggregateOverload(agg, at)
			const native = nativeResultType(cx, overload, shape)
			return target(
				castTo(aggregateCall(cx, agg, overload, shape, scope), native, cx.typeRef(c.type, at))
			)
		})
		const groupBy = present !== undefined ? [present] : node.keys.map((k) => columnIn(bound, k))
		return select({
			...core(targets.length === 0 ? [target(lit.bool(true))] : targets, [from], undefined),
			groupBy
		})
	}
