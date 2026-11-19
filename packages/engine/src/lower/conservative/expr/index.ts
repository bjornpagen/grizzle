import { floatSpecials } from "#compiler/core/canonical.ts"
import type { ProseTag } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { moneyMinorUnits, vectorPayload } from "#compiler/ir/carriers.ts"
import { codecOf, codeOf, handlesHex, type RosterCodec } from "#compiler/ir/codes.ts"
import { datePartSlices } from "#compiler/ir/date.ts"
import {
	describeOp,
	type ScalarExpr,
	spanLiteralText,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import {
	fieldColumnType,
	baseTypeRef as physicalBaseType,
	type PhysicalNames
} from "#compiler/ir/physical.ts"
import { baseOf, rosterOf, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import {
	type Env,
	type LowerContext,
	loweringAt,
	refuse,
	refuseAt
} from "#compiler/lower/conservative/context.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { ieeeForm } from "#compiler/lower/conservative/expr/total.ts"
import { lowerSpanOp } from "#compiler/lower/conservative/span/index.ts"
import { lowerVectorOp } from "#compiler/lower/conservative/vector/index.ts"
import { isDateParse } from "#compiler/scalar/compute/registry.ts"
import { moneyFractionDigits } from "#compiler/scalar/values/decimal.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import { cast, lit, qualifiedCall, types } from "#compiler/sql/build.ts"
import { type ClosedRead, closedRead as closedReadOf } from "#compiler/sql/constants.ts"
import { dateOfText } from "#compiler/sql/lexical.ts"

/**
 * Minor units as the exact decimal text of the amount, two fractional digits under the fixed C.UTF-8 monetary
 * context that admission verifies.
 */
const moneyText = (minor: bigint): string => {
	const negative = minor < 0n
	const magnitude = negative ? -minor : minor
	const unit = 10n ** BigInt(moneyFractionDigits)
	const whole = magnitude / unit
	const cents = (magnitude % unit).toString().padStart(moneyFractionDigits, "0")
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
 * A typed literal of `type`'s base, the one literal spelling of every site (lowerScalar): a query's, a write's and a
 * persistent expression's alike. A literal is never cast to a domain: its refinement was checked at compile time (the
 * ContractLiteral check), and a persistent expression compares a domain column with a base-typed value, since a
 * constant cast to the domain would be rechecked against the domain's current constraints and a tightened domain would
 * make every later insert fail.
 *
 * Money is a quoted literal of the exact plain amount, never a currency-formatted string, and never the numeric
 * constant cast `1.25::money`: numeric_cash is STABLE and reads lc_monetary each time it runs, so in a CHECK, a domain
 * CHECK, an index predicate or a generated column it would depend on the writing session's lc_monetary, which any role
 * can set, and PostgreSQL refuses it in an index predicate or a generated column (42P17). A quoted money literal is
 * converted once, by cash_in where the statement is parsed, under the fixed C.UTF-8 monetary context that admission
 * verifies, and in a persistent expression at DDL time under the migration identity's, stored as a constant count of
 * minor units.
 *
 * Half-open, start < end: PostgreSQL's canonical spelling of a discrete range.
 *
 * The canonical payload is pgvector's input text, -0 already written as 0.
 *
 * A handle is its code under the installation's codebook, a smallint, never its position among the roster's live
 * handles: a removed handle leaves a hole, so the two differ after any removal. A set is its hex literal at its
 * roster's width (ir/codes.ts handlesHex), X'<digits>' cast to its domain.
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
			return lit.float(floatSpecials[literal.value], sqlType)
		case "money":
			return lit.text(moneyText(moneyMinorUnits(literal.value)), sqlType)
		case "bool":
			return lit.bool(literal.value)
		case "text":
		case "uuid":
		case "date":
			return lit.text(literal.value, sqlType)
		case "handle":
			return lit.int(BigInt(codeOf(literalCodec(names, type), literal.handle)), sqlType)
		case "handles":
			return lit.bits(handlesHex(literalCodec(names, type), literal.handles), sqlType)
		case "span":
			return lit.text(spanLiteralText(literal, type), sqlType)
		case "vector":
			return lit.text(vectorPayload(literal.value), sqlType)
	}
}

const exprLabel = (expr: ScalarExpr): string => `expression ${expr.id} (${expr.kind})`

/**
 * Where a scalar expression is lowered, everything its SQL varies by (lowerScalar): a query's lowering, whose leaves are
 * its environment's columns and its declared parameters (querySite), or a persistent expression's, a CHECK's, a domain
 * CHECK's, an index predicate's or a STORED generated column's, whose leaves are its row's installed columns or a
 * domain's VALUE, which folds each constant subterm to its value (physical/ddl/expr.ts persistentSite). Every node is
 * one SQL node in both, through the one switch of lowerScalar, and every literal one spelling (lowerLiteral).
 */
export interface ScalarSite {
	readonly names: PhysicalNames
	/** Where a refusal of `expr` is reported. */
	readonly at: (expr: ScalarExpr) => SourceLoc
	/** A column, VALUE or a parameter, as the site reads it. */
	readonly leaf: (expr: ScalarExpr & { readonly kind: "column" | "value" | "param" }) => Expr
	/** The type a cast or a domain cast into `type` names. */
	readonly castType: (type: ScalarType, expr: ScalarExpr) => TypeRef
	/** The SQL of `expr` that the site writes otherwise than its node, or undefined for its node's own. */
	readonly whole: (expr: ScalarExpr) => Expr | undefined
}

/** A refusal at `expr`'s place in `site`. */
const refuseIn = (site: ScalarSite, expr: ScalarExpr, tag: ProseTag, capability: string): never =>
	refuseAt(tag, site.at(expr), capability)

/**
 * The SQL of the scalar expression `expr` at `site`.
 *
 * One IR node is one Compute operation, so each lowers to its SQL wherever it stands: a column, VALUE and a parameter as
 * the site reads them, a literal typed by its base, an operator its catalog form (an exact one in its exact space and
 * an IEEE 754 one natively where proved and by its guarded form otherwise, ops.ts totalForm), a cast `x::type` (a
 * rounding into a float as total.ts ieeeForm chooses, which only a query holds: a check refuses it, compute/lower.ts),
 * a domain cast `x::domain`, a conditional CASE with its ELSE, and a closed read or membership test a read of its
 * relation's installed constants (`closedRead`). No NULL and no COALESCE is produced, and NULLIF only by C.at, whose
 * absent key reads NULL, and by a persistent site's boolean NULL.
 */
export const lowerScalar = (expr: ScalarExpr, site: ScalarSite): Expr => {
	const whole = site.whole(expr)
	if (whole !== undefined) {
		return whole
	}
	const lower = (a: ScalarExpr): Expr => lowerScalar(a, site)
	switch (expr.kind) {
		case "column":
		case "value":
		case "param":
			return site.leaf(expr)
		case "literal":
			return lowerLiteral(site.names, expr.value, expr.type)
		case "cast": {
			const inner = lower(expr.args[0])
			if (isDateParse(expr.cast)) {
				return dateOfText(inner, datePartSlices)
			}
			const ieee = ieeeForm(expr, [inner])
			if (ieee?.kind === "guarded") {
				return (
					ieee.sql ??
					refuseIn(
						site,
						expr,
						"UnsupportedOperation",
						`an IEEE 754 rounding into ${baseOf(expr.type).carrier}`
					)
				)
			}
			return cast(inner, site.castType(expr.type, expr))
		}
		case "domainCast":
			return cast(lower(expr.args[0]), site.castType(expr.type, expr))
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
				return lowerSpanOp(expr, args, site.at(expr))
			}
			if (operandTypes.some((t) => t.carrier === "vector")) {
				return lowerVectorOp(expr, args, site.at(expr), site.names.vectorSchema)
			}
			return (
				defaultOps(expr, args) ??
				refuseIn(
					site,
					expr,
					"UnsupportedOperation",
					`a lowering for the operation ${describeOp(expr.op)} over ${args.length} operand(s)`
				)
			)
		}
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return closedRead(site, expr, expr.args.map(lower))
		case "call":
			return declaredCall(site, expr, expr.args.map(lower))
	}
}

/**
 * Compute.call(f, args) of a declared function that returns a value: the function's call, each argument cast to its
 * declared type's base, the type the function takes it at, and its value cast to the type its declared field's values
 * are stored as (ir/physical.ts fieldColumnType), whose domain PostgreSQL checks it at, a closed id's roster's among
 * them, where a NULL value is refused through the installation's refusal function (SQLSTATE
 * 22004, null_value_not_allowed), since grizzle holds no NULL:
 *
 *   COALESCE(<level>.<f>(<a>::<base>, ...), CASE WHEN <level>.__refuse('22004', '<f>', ...) THEN <the call> ELSE
 *     <the call> END)::<type>
 *
 * COALESCE reads its second argument only where its first is NULL, and the refusal raises there, so the function is
 * called once and the CASE's branches, which state the value's type, are never read.
 */
const declaredCall = (
	site: ScalarSite,
	expr: ScalarExpr & { readonly kind: "call" },
	args: ReadonlyArray<Expr>
): Expr => {
	const fn = site.names.declaredFunction(expr.function.name)
	const value = qualifiedCall(
		fn.ref.schema,
		fn.ref.name,
		args.map((a, i) => {
			const param = expr.params[i]
			if (param === undefined) {
				throw defect("a call's argument at each of its declared parameters")
			}
			return cast(a, physicalBaseType(site.names, param))
		})
	)
	const refused = qualifiedCall(site.names.refusal.schema, site.names.refusal.name, [
		lit.text("22004", types.text),
		lit.text(expr.function.name, types.text),
		lit.text(`function ${expr.function.name} returned NULL`, types.text)
	])
	return cast(
		{
			kind: "coalesce",
			args: [
				value,
				{ kind: "case", operand: undefined, whens: [{ when: refused, result: value }], else: value }
			]
		},
		fieldColumnType(site.names, expr.type).type
	)
}

/**
 * A query's site (lowerScalar): a column is its qualified reference in `env`, a parameter its typed placeholder, and
 * VALUE is refused. Types: a comparison parameter is cast to its base type and a written or emitted one to its domain,
 * which the IR records as the parameter's type; a literal is typed by its base, since its refinement was checked at
 * compile time (the ContractLiteral check); a domain cast always names the domain, because the database validation it
 * carries is its point.
 */
const querySite = (cx: LowerContext, env: Env): ScalarSite => ({
	names: cx.names,
	at: (expr) => loweringAt(exprLabel(expr)),
	leaf: (expr) => {
		const at = exprLabel(expr)
		switch (expr.kind) {
			case "column":
				return (
					env.get(expr.column.node)?.get(expr.column.name) ??
					refuse(
						"MalformedDescription",
						at,
						`a column ${expr.column.node}.${expr.column.name} of a node in scope`
					)
				)
			case "value":
				return refuse("MalformedDescription", at, "VALUE only inside a contract predicate")
			case "param":
				return cx.scalarParam(expr.param, expr.type, at)
		}
	},
	castType: (type, expr) => cx.typeRef(type, exprLabel(expr)),
	whole: () => undefined
})

/** The SQL of the expression `expr`, evaluated where `env` is in scope (lowerScalar at its query's site). */
export const lowerExpr = (cx: LowerContext, expr: ScalarExpr, env: Env): Expr =>
	lowerScalar(expr, querySite(cx, env))

/**
 * A closed read as its relation's installed constants answer it (sql/constants.ts closedRead), its arguments the codes
 * of the key fields it fixes, in key order, as SQL: C.at's payload field, C.row's completions, or C.has's membership
 * test, which the closed rewrite (lower/optimize/closed) also states. Every argument is a code its column's roster domain proves below
 * its roster's size, and a slot code past its owner's count reads the first cell past the string, so no index aliases
 * a neighbour's and an index past the string reads absent.
 */
const closedRead = (
	site: ScalarSite,
	expr: ScalarExpr & { readonly kind: "closedAt" | "closedRow" | "closedHas" },
	args: ReadonlyArray<Expr>
): Expr => {
	const read: ClosedRead =
		expr.kind === "closedAt"
			? { kind: "at", field: expr.field }
			: expr.kind === "closedRow"
				? { kind: "row" }
				: { kind: "has" }
	const lowered = closedReadOf(
		site.names.closed(expr.relation),
		expr.relation,
		read,
		args,
		physicalBaseType(site.names, expr.type)
	)
	return lowered.ok ? lowered.value : refuseIn(site, expr, "MalformedDescription", lowered.error)
}
