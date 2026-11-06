import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
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
import type { Expr, FromItem, OperandSelect, Target } from "#compiler/sql/ast.ts"
import {
	distinctCore,
	keyedSet,
	provedCore,
	select,
	simpleSelect,
	target
} from "#compiler/sql/build.ts"

/**
 * How the produced heading's rows are a set: SELECT DISTINCT; a plain core whose targets key the sets it reads, by the
 * producer's construction (`keyed`, a pack's grouped key and the disjoint components of one multirange); a plain core
 * under the physical analysis's proof that they are unique (`certified`); or a plain core whose rows may repeat
 * (`operand`), which stands only where the node is realized plain because its consumers make its rows a set, as any
 * plain node's query does (shapes/index.ts withoutBoundary). A plain core claims no proof nothing made.
 */
export type ProducedRows = "distinct" | "keyed" | "certified" | "operand"

/**
 * How a pack's contributions, the carried columns and the span range_agg folds, are a set: SELECT DISTINCT over its
 * input, or a plain read of an input that is a set, keyed by them (`keyed`), as the physical analysis proves where it
 * keys that input by the carried columns and the span. range_agg folds keyed rows, never a projection's repeats.
 */
export type Contributions = "distinct" | "keyed"

/** Which set boundaries a producer's lowering emits; only a pack has contributions. */
export interface ProducerForm {
	readonly produced: ProducedRows
	readonly contributions: Contributions
}

/**
 * The conservative baseline: every boundary.
 *
 * What the span producers share: the form a lowering takes, the span arguments, and the carried columns.
 *
 * A producer is evaluated once per binding of its input, the complete bound tuple of the rule, and yields zero or more
 * facts of its carried columns and the produced span. The conservative lowering closes every producer with SELECT
 * DISTINCT over the produced heading: different bindings can yield the same piece. The optimized lowering
 * (lower/shapes/spans) reuses the same builders and drops a boundary only where the physical facts prove its rows a set
 * without it, or where the node's consumers make them one, so both artifacts spell every producer alike apart from
 * their DISTINCTs.
 */
export const conservativeProducerForm: ProducerForm = {
	produced: "distinct",
	contributions: "distinct"
}

/** SELECT <targets> FROM <from> [WHERE <where>] over the produced heading, a set as `rows` states or an operand. */
export const producedQuery = (
	rows: ProducedRows,
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): OperandSelect => {
	switch (rows) {
		case "distinct":
			return select(distinctCore(targets, from, where))
		case "keyed":
			return select(keyedSet(targets, from, where, "a producer's rows keyed by its construction"))
		case "certified":
			return select(provedCore("certified", targets, from, where))
		case "operand":
			return simpleSelect(targets, from, where)
	}
}

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
