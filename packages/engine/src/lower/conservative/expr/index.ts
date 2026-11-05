import { exactParts } from "#compiler/core/decimal.ts"
import { defect } from "#compiler/core/invariant.ts"
import { moneyFractionDigits, moneyMinorUnits, vectorPayload } from "#compiler/ir/carriers.ts"
import { codecOf, codeOf, handlesText, type RosterCodec } from "#compiler/ir/codes.ts"
import { describeOp, type TypedLiteral, type ScalarExpr } from "#compiler/ir/expr.ts"
import { baseTypeRef as physicalBaseType, type PhysicalNames } from "#compiler/ir/physical.ts"
import { baseOf, rosterOf, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import {
	type Env,
	type LowerContext,
	loweringAt,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { ieeeForm } from "#compiler/lower/conservative/expr/total.ts"
import { lowerSpanOp } from "#compiler/lower/conservative/span/index.ts"
import { lowerVectorOp } from "#compiler/lower/conservative/vector/index.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, cast, lit, types } from "#compiler/sql/build.ts"
import {
	cellAt,
	constantValue,
	type Coordinate,
	inSet,
	mixedRadix,
	payloadDigit
} from "#compiler/sql/constants.ts"

/**
 * Minor units as the exact decimal text of the amount, two fractional digits under the fixed C.UTF-8 monetary
 * context that admission verifies.
 */
export const moneyText = (minor: bigint): string => {
	const negative = minor < 0n
	const magnitude = negative ? -minor : minor
	const unit = 10n ** BigInt(moneyFractionDigits.value)
	const whole = magnitude / unit
	const cents = (magnitude % unit).toString().padStart(moneyFractionDigits.value, "0")
	return `${negative ? "-" : ""}${whole.toString()}.${cents}`
}

/**
 * The codes of the roster a closed literal of `type` is over. A handle's type is a closed id's and a set's a set's
 * (ir/expr.ts literalProblem), so a type over no roster is a defect.
 */
const literalCodec = (names: PhysicalNames, type: ScalarType): RosterCodec => {
	const roster = rosterOf(type)
	if (roster === undefined) {
		throw defect(`a closed literal is typed by a roster's type, not ${baseOf(type).carrier}`)
	}
	return codecOf(names.codes, roster)
}

/**
 * A typed literal of `type`'s base.
 *
 * Money enters as its exact numeric amount cast to money, never through a currency-formatted string.
 *
 * Half-open, start < end: PostgreSQL's canonical spelling of a discrete range.
 *
 * The canonical payload is pgvector's input text, -0 already written as 0.
 *
 * A handle is its code under the installation's codebook, a smallint, never its position among the roster's live
 * handles: a removed handle leaves a hole, so the two differ after any removal. A set is bit(n)'s text.
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
			return lit.decimal(literal.value.parts, sqlType)
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
			return lit.decimal(exactParts(moneyMinorUnits(literal.value), 2), sqlType)
		case "bool":
			return lit.bool(literal.value)
		case "text":
		case "uuid":
			return lit.text(literal.value, sqlType)
		case "handle":
			return lit.int(BigInt(codeOf(literalCodec(names, type), literal.handle)), sqlType)
		case "handles":
			return lit.text(handlesText(literalCodec(names, type), literal.handles), sqlType)
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
 * One IR node is one Compute operation, so each lowers to its SQL: a column becomes its qualified reference in the
 * environment, a parameter its typed placeholder, a literal a typed literal, an operator its catalog form (an exact
 * one in its exact space and an IEEE 754 one natively where proved and by its guarded form otherwise, ops.ts
 * totalForm), a cast `x::type` (a rounding into a float as total.ts ieeeForm chooses), a domain cast `x::domain`, a
 * conditional CASE with its ELSE, and a closed read or membership test a read of its relation's installed constants
 * (`closedRead`). No NULL
 * and no COALESCE is produced, and NULLIF only by C.at, whose absent key reads NULL.
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
		case "cast": {
			const inner = lower(expr.args[0])
			const ieee = ieeeForm(expr, [inner])
			if (ieee?.kind === "guarded") {
				return (
					ieee.sql ??
					refuse(
						"UnsupportedOperation",
						at,
						`an IEEE 754 rounding into ${baseOf(expr.type).carrier}`
					)
				)
			}
			return cast(inner, cx.typeRef(expr.type, at))
		}
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
			const operandTypes = [expr.type, ...expr.args.map((a) => a.type)]
			if (operandTypes.some((t) => spanCarrierOf(t) !== undefined)) {
				return lowerSpanOp(expr, args, loweringAt(at))
			}
			if (operandTypes.some((t) => t.carrier === "vector")) {
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
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return closedRead(cx, expr, expr.args.map(lower))
	}
}

/**
 * A closed read as its relation's installed constants answer it (ir/physical.ts ClosedConstant, sql/constants.ts), its
 * arguments the codes of the key fields it fixes, in key order, as SQL.
 *
 * - C.at(field, k…): the cell at the mixed-radix index of k… in the relation's string of cells; its payload code is
 *   NULLIF(cell, 0) - 1, so a key the relation holds no tuple at reads NULL, never a code; `field`'s coordinate of that
 *   code is a closed id's code, typed as its smallint, or an open-typed value read through its dictionary at code + 1.
 * - C.row(k…): the completions of the prefix k… of the last key field, `radix` bits of the relation's key set (one bit
 *   per point of the key space) from the prefix's index times that radix, bit(radix): the set over the last key
 *   field's roster, position i code i, a hole 0. A prefix of no field reads the key set's first `radix` bits.
 * - has(k…), the closed rewrite's membership test (lower/optimize/closed): the one bit of the relation's key set at the
 *   mixed-radix index of the full key k…, equal to '1'::bit(1) exactly where the relation holds a tuple there.
 *
 * Every argument is a code its column's roster domain proves below its radix, so no digit carries into its neighbour
 * (fin.md §17 "Totality"), and an index past the string reads the empty string, which is absent.
 */
const closedRead = (
	cx: LowerContext,
	expr: ScalarExpr & { readonly kind: "closedAt" | "closedRow" | "closedHas" },
	args: ReadonlyArray<Expr>
): Expr => {
	const at = exprLabel(expr)
	const constant = cx.names.closed(expr.relation)
	const coordinates = args.map((digit, i): Coordinate => {
		const key = constant.key[i]
		if (key === undefined) {
			return refuse(
				"MalformedDescription",
				at,
				`a read of ${expr.relation} by at most its ${constant.key.length} key field(s)`
			)
		}
		return { digit, radix: key.radix }
	})
	if (expr.kind === "closedRow") {
		const open = constant.key[args.length]
		if (open === undefined || args.length !== constant.key.length - 1) {
			return refuse(
				"MalformedDescription",
				at,
				`${expr.relation}.row over every key field of ${expr.relation} but its last`
			)
		}
		const [first, ...rest] = coordinates
		const prefix = first === undefined ? lit.int(0n, types.integer) : mixedRadix([first, ...rest])
		return cast(cellAt(constant.keys, prefix, open.radix), cx.baseTypeRef(expr.type))
	}
	const [first, ...rest] = coordinates
	if (first === undefined || args.length !== constant.key.length) {
		return refuse(
			"MalformedDescription",
			at,
			`${expr.relation}.${expr.kind === "closedAt" ? "at" : "has"} over every key field of ${expr.relation}, in key order`
		)
	}
	const index = mixedRadix([first, ...rest])
	if (expr.kind === "closedHas") {
		return inSet(constant.keys, index)
	}
	const position = constant.payload.findIndex((p) => p.field === expr.field)
	const payload = constant.payload[position]
	if (payload === undefined) {
		return refuse(
			"MalformedDescription",
			at,
			`${expr.relation}.at of a payload field of ${expr.relation}; ${expr.field} is none`
		)
	}
	const digit = payloadDigit(
		constant.function,
		index,
		constant.width,
		constant.payload.map((p) => p.radix),
		position
	)
	return payload.dictionary === undefined
		? cast(digit, cx.baseTypeRef(expr.type))
		: {
				kind: "subscript",
				array: constantValue(payload.dictionary),
				index: binary("+", digit, lit.int(1n, types.integer))
			}
}
