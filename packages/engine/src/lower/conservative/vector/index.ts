import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { describeOp, type ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	columnIn,
	headingTargets,
	type Lowerers,
	type NodeLowerer,
	refuseAt
} from "#compiler/lower/conservative/context.ts"
import { admitsArity, nativeOp, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import type { BinaryOperator, Expr, OrderItem } from "#compiler/sql/ast.ts"
import { and, asc, distinctCore, lit, or, qualifiedCall, select } from "#compiler/sql/build.ts"

/**
 * The extension's functions this lowering emits, by Compute operation.
 *
 * pgvector in the conservative lowering.
 *
 * Two things lower here.
 *
 * Every scalar operation over a vector, for queries and for persistent expressions alike (physical/ddl/expr.ts), so
 * a CHECK and a query spell one native tree. Each is qualified by the installation's vector schema, which is resolved
 * at installation and never assumed to be on the search_path:
 *
 * - Compute.cosineDistance is the extension's function, `"vector_ext"."cosine_distance"(a, b)`, wherever it appears:
 *   in a projection, a filter, an order, a fold. The `<=>` operator is never emitted here: only approximateNearest's
 *   optimized lowering spells it, because the HNSW opclass advertises that operator as its ordering operation and an
 *   operator-ordered SELECT can take the ANN path once an index exists. The function computes the
 *   identical native arithmetic and no index can order by it. Both operands are vectors of one dimension count,
 *   which the builder checks and this lowering checks again for a Description from a JavaScript caller.
 * - The comparisons are the extension's operators, `a OPERATOR("vector_ext".=) b`, its B-tree equality and order of
 *   stored float32 components. BETWEEN and IN resolve their operators by name through the search_path,
 *   so over vectors they are spelled by the comparisons they stand for: `a >= lo AND a <= hi` and `a = x OR a = y`,
 *   each qualified. LEAST and GREATEST compare through the type's default B-tree opclass, which needs no name lookup,
 *   and stay one construct.
 *
 * The ApproximateNearest node, whose conservative form is the exact top-k of its sealed source: the source is
 * deduplicated, then ordered by the score column ascending, the cosine distance the checker traced `by` to, and then by
 * every other heading column ascending, so the choice of k facts is a function of the source alone and never rests on a
 * key; LIMIT takes `take`. It is the complete exact candidate set an approximate retrieval may underfill or miss
 * neighbours of, the baseline the optimized `<=>` lowering is measured against for recall, never its substitute: its
 * ORDER BY names the score column the source computed with cosine_distance, so no HNSW index can drive it.
 */
export const vectorFunctions = { cosineDistance: "cosine_distance", norm: "vector_norm" } as const

const qualifiedBinary = (op: BinaryOperator, left: Expr, right: Expr, schema: string): Expr => ({
	kind: "binary",
	op,
	left,
	right,
	schema
})

/** The dimension count of a vector-valued type, or undefined for a type of any other carrier. */
const vectorDims = (t: ScalarType): number | undefined => {
	const base = baseOf(t)
	return base.carrier === "vector" ? base.typmod.dims : undefined
}

/** The SQL of one scalar operation whose operands or result are vectors, qualified by `vectorSchema`. */
export const lowerVectorOp = (
	expr: ScalarExpr & { readonly kind: "op" },
	args: ReadonlyArray<Expr>,
	at: SourceLoc,
	vectorSchema: string
): Expr => {
	const native = nativeOp(expr.op)
	if (native === undefined) {
		return refuseAt(
			"UnsupportedOperation",
			at,
			`a pgvector operation of the Compute catalogue; ${describeOp(expr.op)} is not one`
		)
	}
	const dims = expr.args.map((a) => vectorDims(a.type))
	if (
		!operandCarriers(native.operands).every((c) => c === "vector") ||
		!dims.every((d) => d !== undefined)
	) {
		return refuseAt(
			"UnsupportedOperation",
			at,
			`a pgvector operation over vector operands; ${describeOp(expr.op)} meets ${expr.args.map((a) => baseOf(a.type).carrier).join(", ")}`
		)
	}
	if (!admitsArity(native.operands, args.length)) {
		return refuseAt("MalformedDescription", at, `the operands of ${describeOp(expr.op)}`)
	}
	const [first, ...rest] = dims
	if (first === undefined || !rest.every((d) => d === first)) {
		return refuseAt(
			"UnsupportedOperation",
			at,
			"vectorDistance: the operands of a vector operation share one dimension count"
		)
	}
	const sql = native.sql
	const [a, b] = args
	const operands = (): readonly [Expr, Expr] => {
		if (a === undefined || b === undefined) {
			return refuseAt("MalformedDescription", at, `the operands of ${describeOp(expr.op)}`)
		}
		return [a, b]
	}
	switch (sql.kind) {
		case "function": {
			if (native.fn !== "cosineDistance" || sql.owner !== "vector") {
				return refuseAt("UnsupportedOperation", at, `the pgvector function ${sql.name}`)
			}
			return qualifiedCall(vectorSchema, vectorFunctions.cosineDistance, operands())
		}
		case "infix":
			if (sql.owner !== "vector") {
				return refuseAt("UnsupportedOperation", at, `the vector operator ${sql.op}`)
			}
			return qualifiedBinary(sql.op, ...operands(), vectorSchema)
		case "between": {
			const [x, low, high] = args
			if (x === undefined || low === undefined || high === undefined) {
				return refuseAt("MalformedDescription", at, `the operands of ${describeOp(expr.op)}`)
			}
			return and([
				qualifiedBinary(">=", x, low, vectorSchema),
				qualifiedBinary("<=", x, high, vectorSchema)
			])
		}
		case "in": {
			const [x, ...list] = args
			if (x === undefined) {
				return refuseAt("MalformedDescription", at, "the operand of an IN")
			}
			return isNonEmpty(list)
				? or(mapNonEmpty(list, (item) => qualifiedBinary("=", x, item, vectorSchema)))
				: lit.bool(false)
		}
		case "least":
		case "greatest": {
			const [x, ...more] = args
			if (x === undefined) {
				return refuseAt("MalformedDescription", at, `the operands of ${describeOp(expr.op)}`)
			}
			return { kind: sql.kind, args: [x, ...more] }
		}
		case "prefix":
		case "cast":
		case "and":
		case "or":
		case "not":
		case "difference":
		case "subset":
		case "disjoint":
		case "endsWith":
		case "collapse":
			return refuseAt("UnsupportedOperation", at, `the vector operation ${describeOp(expr.op)}`)
	}
}

/**
 * ApproximateNearest in the baseline: the source's first k rows by its score, a double precision column of the heading,
 * which is the source's (valid DAG), then by every other column.
 */
const lowerApproximateNearest: NodeLowerer<"ApproximateNearest"> = (node, cx, env) => {
	const input = cx.source(node.source, env)
	const items: ReadonlyArray<OrderItem> = [
		node.score,
		...node.heading.map((c) => c.name).filter((n) => n !== node.score)
	].map((name) => asc(columnIn(input.map, name)))
	return {
		...select(distinctCore(headingTargets(node.heading, input.map), [input.item], undefined)),
		orderBy: items,
		limit: cx.boundExpr({ kind: "literal", k: node.take })
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const approximateNearestLowering: Lowerers<"ApproximateNearest"> = {
	ApproximateNearest: lowerApproximateNearest
}
