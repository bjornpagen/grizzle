import { moneyMinorUnits, vectorPayload } from "#compiler/ir/carriers.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import { describeOp, type TypedLiteral, type ScalarExpr } from "#compiler/ir/expr.ts"
import { type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import { baseTypeRef as physicalBaseType } from "#compiler/lower/conservative/base-type.ts"
import {
	type Env,
	type LowerContext,
	loweringAt,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { lowerSpanOp } from "#compiler/lower/conservative/span/index.ts"
import type { PhysicalNames } from "#compiler/lower/conservative/types.ts"
import { lowerVectorOp } from "#compiler/lower/conservative/vector/index.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { cast, lit } from "#compiler/sql/build.ts"

/**
 * Minor units as the exact decimal text of the amount, two fractional digits under the fixed C.UTF-8 monetary
 * context that admission verifies.
 */
export const moneyText = (minor: bigint): string => {
	const negative = minor < 0n
	const magnitude = negative ? -minor : minor
	const whole = magnitude / 100n
	const cents = (magnitude % 100n).toString().padStart(2, "0")
	return `${negative ? "-" : ""}${whole.toString()}.${cents}`
}

/**
 * A typed literal of `type`'s base.
 *
 * Money enters as its exact numeric amount cast to money, never through a currency-formatted string.
 *
 * Half-open, start < end: PostgreSQL's canonical spelling of a discrete range.
 *
 * The canonical payload is pgvector's input text, -0 already written as 0.
 */
export const lowerLiteral = (
	names: PhysicalNames,
	literal: TypedLiteral,
	type: ScalarType
): Expr => {
	const sqlType = physicalBaseType(names, type)
	switch (literal.kind) {
		case "int":
			return lit.int(literal.value, sqlType)
		case "numeric":
			return lit.decimal(decimalPayload(literal.value), sqlType)
		case "float":
			return lit.float(literal.value, sqlType)
		case "floatSpecial":
			return lit.float(
				literal.value === "NaN"
					? Number.NaN
					: literal.value === "Infinity"
						? Number.POSITIVE_INFINITY
						: Number.NEGATIVE_INFINITY,
				sqlType
			)
		case "money":
			return lit.decimal(moneyText(moneyMinorUnits(literal.value)), sqlType)
		case "bool":
			return lit.bool(literal.value)
		case "text":
		case "uuid":
			return lit.text(literal.value, sqlType)
		case "enum":
			return lit.text(literal.handle, sqlType)
		case "span":
			return lit.text(`[${literal.start.toString()},${literal.end.toString()})`, sqlType)
		case "vector":
			return lit.text(vectorPayload(literal.value), sqlType)
	}
}

const exprLabel = (expr: ScalarExpr): string => `expression ${expr.id} (${expr.kind})`

/**
 * The SQL of the expression `expr`, evaluated where `env` is in scope.
 *
 * Scalar expressions.
 *
 * One IR node is one PostgreSQL operator, function or cast, so each lowers to exactly one SQL node: a column becomes
 * its qualified reference in the environment, a parameter its typed placeholder, a literal a typed literal, an
 * operator its catalog form, a cast `x::type`, a domain cast `x::domain`, and a conditional CASE with its ELSE. No
 * NULL, NULLIF or COALESCE is produced, and nothing is added that the IR does not state.
 *
 * Types: a comparison parameter is cast to its base type and a written or emitted one to
 * its domain, which the IR records as the parameter's type; a literal is typed by its base, since its refinement was
 * checked at compile time (the ContractLiteral check); a domain cast always names the domain, because the
 * database validation it carries is its point.
 */
export const lowerExpr = (cx: LowerContext, expr: ScalarExpr, env: Env): Expr => {
	const at = exprLabel(expr)
	const lower = (a: ScalarExpr): Expr => lowerExpr(cx, a, env)
	switch (expr.kind) {
		case "column": {
			const e = env.get(expr.column.node)?.get(expr.column.name)
			if (e === undefined) {
				return refuse(
					"MalformedDescription",
					at,
					`a column ${expr.column.node}.${expr.column.name} of a node in scope`
				)
			}
			return e
		}
		case "value":
			return refuse("MalformedDescription", at, "VALUE only inside a contract predicate")
		case "param":
			return cx.params.scalar(expr.param, expr.type, cx.typeRef(expr.type, at))
		case "literal":
			return lowerLiteral(cx.names, expr.value, expr.type)
		case "cast":
		case "domainCast":
			return cast(lower(expr.args[0]), cx.typeRef(expr.type, at))
		case "cond": {
			const [when, result, otherwise] = expr.args
			return {
				kind: "case",
				whens: [{ when: lower(when), result: lower(result) }],
				else: lower(otherwise),
				operand: undefined
			}
		}
		case "op": {
			const args = expr.args.map(lower)
			const types = [expr.type, ...expr.args.map((a) => a.type)]
			if (types.some((t) => spanCarrierOf(t) !== undefined)) {
				return lowerSpanOp(expr, args, loweringAt(at))
			}
			if (types.some((t) => t.carrier === "vector")) {
				return lowerVectorOp(expr, args, loweringAt(at), cx.names.vectorSchema)
			}
			const lowered = defaultOps(expr, args)
			if (lowered === undefined) {
				return refuse(
					"UnsupportedOperation",
					at,
					`a lowering for the operation ${describeOp(expr.op)} over ${args.length} operand(s)`
				)
			}
			return lowered
		}
	}
}
