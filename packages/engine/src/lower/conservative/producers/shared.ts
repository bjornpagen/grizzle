import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { NodeOf, ProducerNode } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	type LowerContext,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type { Expr, Target } from "#compiler/sql/ast.ts"
import { target } from "#compiler/sql/build.ts"

/** Which set boundaries a producer's lowering emits. */
export interface ProducerForm {
	/** The outermost SELECT DISTINCT over the produced heading. */
	readonly distinct: boolean
	/**
	 * A pack, and the busy relation of a coverage subtraction: SELECT DISTINCT over the grouped input before range_agg.
	 * range_agg absorbs repeats (a multirange is a set of points), so only the conservative baseline, which places a
	 * boundary at every set boundary whatever it reads, keeps it.
	 */
	readonly contributions: boolean
}

/**
 * The conservative baseline: every boundary.
 *
 * What the span producers share: the form a lowering takes, the span arguments, and the carried columns.
 *
 * A producer is evaluated once per binding of its input, the complete bound tuple of the rule, and yields zero or more
 * facts of its carried columns and the produced span. The conservative lowering closes every producer with SELECT
 * DISTINCT over the produced heading: different bindings can yield the same piece. The
 * optimized lowering (lower/shapes/spans) reuses the same builders and drops a boundary only where the physical facts
 * prove the produced heading unique, so both artifacts spell every producer alike apart from
 * their DISTINCTs.
 */
export const conservativeProducerForm: ProducerForm = { distinct: true, contributions: true }

/** The range carrier of a span: int4range for pg.integer endpoints, int8range for pg.bigint. */
type SpanCarrier = "range4" | "range8"

/**
 * The range carrier of the span expression `e`, or MalformedDescription: the checker builds every producer argument as
 * a span, and validation checks only that it reads the producer's input.
 */
const spanCarrierOf = (e: ScalarExpr, at: string): SpanCarrier => {
	const carrier = e.type.carrier
	if (carrier !== "range4" && carrier !== "range8") {
		return refuse(
			"MalformedDescription",
			at,
			`a span argument of the producer, not a value of ${carrier}`
		)
	}
	return carrier
}

/** A unary producer's span argument lowered where `scope` is in scope. */
export const spanArgument = (
	cx: LowerContext,
	node: ProducerNode<"spanPack">,
	scope: Env,
	at: string
): { readonly arg: Expr; readonly carrier: SpanCarrier } => {
	const [a] = node.args
	const carrier = spanCarrierOf(a, at)
	return { arg: lowerExpr(cx, a, scope), carrier }
}

/** A binary producer's span arguments lowered where `scope` is in scope, both of one range carrier. */
export const spanArguments = (
	cx: LowerContext,
	node: ProducerNode<"spanIntersection" | "spanDifference">,
	scope: Env,
	at: string
): { readonly args: readonly [Expr, Expr]; readonly carrier: SpanCarrier } => {
	const [a, b] = node.args
	const carrier = spanCarrierOf(a, at)
	if (spanCarrierOf(b, at) !== carrier) {
		return refuse("MalformedDescription", at, `spans of one range type for ${node.producer}`)
	}
	const left = lowerExpr(cx, a, scope)
	const right = lowerExpr(cx, b, scope)
	return { args: [left, right], carrier }
}

/**
 * The targets of the carried columns, columns of the input, read from `map`: the produced heading is the carried
 * columns, then the produced span (valid DAG).
 */
export const carriedTargets = (node: NodeOf<"Produce">, map: ColumnMap): ReadonlyArray<Target> =>
	node.carried.map((name) => target(columnIn(map, name)))
