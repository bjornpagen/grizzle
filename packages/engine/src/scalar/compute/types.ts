import type { DecimalParts } from "#compiler/core/decimal.ts"
import {
	integerDigits,
	moneyDigits,
	moneyFractionDigits,
	numericMaxFractionDigits,
	numericMaxIntegerDigits
} from "#compiler/ir/carriers.ts"
import type { DefinedOp } from "#compiler/ir/expr.ts"
import {
	type Capability,
	type Carrier,
	type ExactValueCarrier,
	type NumericBound,
	type ScalarType,
	type SpanInfo,
	type TextInfo,
	baseOf,
	capabilitySet,
	contractOf,
	exactDigitsOf,
	numericBoundOf,
	numericTypmodOf,
	rosterOf,
	spanOf,
	textOf,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"
import {
	binaryCoercion,
	type CastOp,
	castOf,
	definedIdOf
} from "#compiler/scalar/compute/registry.ts"
import { nativeCapabilities, type PlainCarrier } from "#compiler/scalar/native.ts"
import { numericValue } from "#compiler/scalar/registry.ts"

/**
 * The native capabilities of each carrier: the field registry's table (scalar/registry.ts), so a
 * computed type and a declared field of one carrier always carry one capability set.
 */
const carrierCapabilities: { readonly [C in Carrier]: ReadonlyArray<Capability> } =
	nativeCapabilities

/** A registered result: a plain carrier, numeric, or an exact one, whose bound the lowering derives. */
export type ResultCarrier = PlainCarrier | "numeric" | ExactValueCarrier

/** The exact type of `carrier` whose values lie below 10^digits (ir/scalar.ts ExactType), frozen. */
export const exactType = (carrier: ExactValueCarrier, digits: number): ScalarType =>
	Object.freeze({ carrier, caps: capabilitySet(carrierCapabilities[carrier]), digits })

/** Whether a type is a computed numeric (ir/scalar.ts NumericBound): numeric of no typmod. */
export const isComputedNumeric = (t: ScalarType): boolean =>
	t.carrier === "numeric" && t.typmod === undefined

/**
 * The computed numeric a numeric literal is: its own value's integer digits and least scale; NaN's and an infinity's
 * none.
 */
export const literalNumeric = (parts: DecimalParts): ScalarType =>
	numericValue(
		parts.kind === "finite"
			? {
					digits: Math.max(0, parts.coefficient.toString().length - parts.minScale),
					scale: parts.minScale
				}
			: { digits: 0, scale: 0 }
	)

/**
 * Every numeric value: a computed numeric at numeric's own limits. What a literal adopts before its own value bounds it,
 * and what an overload is looked up by, never a node's type.
 */
export const anyNumeric: ScalarType = numericValue({
	digits: numericMaxIntegerDigits.value,
	scale: numericMaxFractionDigits.value
})

/**
 * The bound every value of a numeric-convertible type has once converted into numeric exactly: an integer's or
 * money's range, an exact value's digits, numeric(p, s)'s p - s integer and (for s > 0) s fraction digits, a computed
 * numeric's own; undefined for every other type.
 */
export const exactNumericBound = (t: ScalarType): NumericBound | undefined => {
	const v = baseOf(t)
	switch (v.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return { digits: integerDigits[v.carrier].value, scale: 0 }
		case "money":
			return { digits: moneyDigits.value, scale: moneyFractionDigits.value }
		case "exactInteger":
			return { digits: v.digits, scale: 0 }
		case "exactMoney":
			return { digits: v.digits, scale: moneyFractionDigits.value }
		case "numeric":
			return v.typmod === undefined
				? v.bound
				: { digits: v.typmod.precision - v.typmod.scale, scale: Math.max(v.typmod.scale, 0) }
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return undefined
	}
}

/** The least bound holding both: the more integer and the more fraction digits. */
export const numericHull = (a: NumericBound, b: NumericBound): NumericBound => ({
	digits: Math.max(a.digits, b.digits),
	scale: Math.max(a.scale, b.scale)
})

/**
 * The integer digits every value of an integer or money type is below, |x| < 10^digits (of the amount, for money): the
 * carrier's range, or an exact type's bound; undefined for any other type.
 */
export const familyDigits = (t: ScalarType): number | undefined => {
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return integerDigits[t.carrier].value
		case "money":
			return moneyDigits.value
		case "exactInteger":
		case "exactMoney":
			return t.digits
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return undefined
	}
}

/** The canonical wildcard text type: what a text literal that meets no term has. */
export const wildcardText: ScalarType = Object.freeze({
	carrier: "text",
	caps: capabilitySet(carrierCapabilities.text),
	contract: undefined,
	text: Object.freeze({ regex: "wildcard", lengthBound: undefined, byteBound: undefined })
})

/** The base of a type: what an expression over a field computes with. */
export const valueType = (t: ScalarType): ScalarType => baseOf(t)

/**
 * A span type with its fixed width dropped: what a value compared with a fixed-width span adopts. A width refines the
 * stored value, which the codec checks (scalar/values/span.ts admitSpan); a window compared with the span, or a value
 * equated with it, is any span over the same endpoint.
 */
export const withoutSpanWidth = (t: ScalarType): ScalarType => {
	if (
		(t.carrier !== "range4" && t.carrier !== "range8" && t.carrier !== "rangeDate") ||
		t.span.width === undefined
	) {
		return t
	}
	return Object.freeze({
		carrier: t.carrier,
		caps: t.caps,
		contract: t.contract,
		span: Object.freeze({ endpoint: t.span.endpoint, width: undefined })
	})
}

/**
 * The scalar types the Compute catalogue produces, and the compatibility rule its operands obey.
 *
 * An operation's result is a plain native type: a contract operand contributes its base and arithmetic never yields
 * a contract. The capability set of each plain type is fixed carrier by carrier
 * and is the same table the field descriptors use (scalar/registry.ts).
 *
 * Compatibility is nominal: two operands meet in a comparison, an arithmetic operation, a
 * conditional or a LEAST/GREATEST exactly when they have one carrier, one contract identity at every level, one closed
 * roster, one vector dimension count, and one span endpoint. Numeric typmods and text refinements do not
 * enter: numeric(7, 6) meets numeric(18, 2) through numeric's own operators, and two compatible text fields can admit
 * different value subsets. A serial declaration is a column generation request, not a value domain, so
 * it does not enter either.
 */
export const compatible = (a: ScalarType, b: ScalarType): boolean => {
	const ca = contractOf(a)
	const cb = contractOf(b)
	return ca === undefined || cb === undefined
		? ca === cb && sameCore(a, b)
		: ca.name === cb.name && compatible(ca.base, cb.base)
}

/** The identity two uncontracted operands share: one carrier, closed roster, vector dimension count and span endpoint. */
const sameCore = (a: ScalarType, b: ScalarType): boolean =>
	a.carrier === b.carrier &&
	rosterOf(a)?.closed === rosterOf(b)?.closed &&
	vectorTypmodOf(a)?.dims === vectorTypmodOf(b)?.dims &&
	sameEndpoint(spanOf(a), spanOf(b))

const sameEndpoint = (a: SpanInfo | undefined, b: SpanInfo | undefined): boolean =>
	a === undefined || b === undefined ? a === b : compatible(a.endpoint, b.endpoint)

/**
 * The type two operands that meet combine to in a conditional or LEAST/GREATEST: their common type when they agree
 * in every meaning-changing field, the exact carrier where one is exact and the other a plain value of its family,
 * otherwise the shared type with the text refinement or span width widened, and two numerics of different typmods or
 * bounds a computed numeric of both bounds' hull, as PostgreSQL's select_common_type and select_common_typmod do (a
 * common typmod survives only when all agree). It is the same whichever operand comes first.
 */
export const commonType = (a: ScalarType, b: ScalarType): ScalarType => {
	const x = a
	const y = b
	if (sameMeaning(x, y)) {
		return x
	}
	if (contractOf(x) !== undefined) {
		return x
	}
	const family = exactFamily(x)
	const dx = familyDigits(x)
	const dy = familyDigits(y)
	if (family !== undefined && family === exactFamily(y) && dx !== undefined && dy !== undefined) {
		return exactType(family, Math.max(dx, dy))
	}
	const nx = exactNumericBound(x)
	const ny = exactNumericBound(y)
	if (x.carrier === "numeric" && nx !== undefined && ny !== undefined) {
		return numericValue(numericHull(nx, ny))
	}
	if (x.carrier === "text") {
		return wildcardText
	}
	if (x.carrier === "range4" || x.carrier === "range8" || x.carrier === "rangeDate") {
		return withoutSpanWidth(x)
	}
	return x
}

/**
 * Whether two types are the same type in every field that changes a value's meaning, contracts compared by identity.
 */
const sameMeaning = (a: ScalarType, b: ScalarType): boolean => {
	if (!compatible(a, b)) {
		return false
	}
	const ta = numericTypmodOf(a)
	const tb = numericTypmodOf(b)
	if (ta?.precision !== tb?.precision || ta?.scale !== tb?.scale) {
		return false
	}
	const ba = numericBoundOf(a)
	const bb = numericBoundOf(b)
	if (ba?.digits !== bb?.digits || ba?.scale !== bb?.scale) {
		return false
	}
	if (spanOf(a)?.width !== spanOf(b)?.width || exactDigitsOf(a) !== exactDigitsOf(b)) {
		return false
	}
	return sameRegex(textOf(a)?.regex, textOf(b)?.regex)
}

/**
 * Whether two types' text refinements are one: both absent, both the canonical wildcard, or two patterns of one
 * language's key.
 */
export const sameRegex = (
	a: TextInfo["regex"] | undefined,
	b: TextInfo["regex"] | undefined
): boolean =>
	a === undefined || b === undefined || a === "wildcard" || b === "wildcard"
		? a === b
		: a.key === b.key

export const isInteger = (t: ScalarType): boolean => {
	const c = baseOf(t).carrier
	return c === "int2" || c === "int4" || c === "int8"
}

/**
 * The exact carrier a plain value of `t` widens into exactly, where it has one: an uncontracted integer into the exact
 * integers, uncontracted money into exact money. A contract keeps its identity, so it meets no exact value without
 * Compute.base.
 */
export const exactFamily = (t: ScalarType): "exactInteger" | "exactMoney" | undefined => {
	if (contractOf(t) !== undefined) {
		return undefined
	}
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return "exactInteger"
		case "money":
		case "exactMoney":
			return "exactMoney"
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return undefined
	}
}

/**
 * Whether two operands that meet are an exact value and a plain value of its family, in either order: an exact integer
 * beside a smallint, an integer or a bigint, exact money beside money. Their common type is the exact one, which no
 * value of the plain one's type carries, so a conditional, LEAST or GREATEST over them is refused (lower.ts
 * exactBeside).
 */
export const mixesExact = (a: ScalarType, b: ScalarType): boolean => {
	const family = exactFamily(a)
	return (
		family !== undefined &&
		family === exactFamily(b) &&
		(valueType(a).carrier === family) !== (valueType(b).carrier === family)
	)
}

/**
 * The one relation every position meets two operands by, a comparison's, an operation's, a conditional's branches', a
 * union's arms', a computed term bound at a column: compatible (types.ts compatible), or one an exact value and the
 * other a plain value of its family, which widens into it exactly (meetingType, widening), so the comparison is a value
 * comparison and the arithmetic exact. Two variables bound to each other meet only compatibly.
 */
export const meets = (a: ScalarType, b: ScalarType): boolean => {
	if (compatible(a, b)) {
		return true
	}
	const fa = exactFamily(a)
	return fa !== undefined && fa === exactFamily(b) && (a.carrier === fa || b.carrier === fa)
}

/**
 * The type an operand meets its partner at (meets): a plain integer or money opposite an exact value of its family is
 * widened into that exact carrier, at its own digit bound; every other operand stands at its own type.
 */
export const meetingType = (operand: ScalarType, partner: ScalarType): ScalarType => {
	const family = exactFamily(partner)
	const value = valueType(operand)
	const digits = familyDigits(value)
	return family !== undefined &&
		baseOf(partner).carrier === family &&
		value.carrier !== family &&
		exactFamily(value) === family &&
		digits !== undefined
		? exactType(family, digits)
		: operand
}

/** How a value is widened: the binary coercion within its carrier, or a registered cast defined on every value. */
export type Widening =
	| { readonly kind: "coercion" }
	| { readonly kind: "registered"; readonly op: CastOp }

/**
 * The one widening every position casts an operand by into the type it meets its partner at (meetingType) or a union's
 * common type: the binary coercion within a carrier (a refinement, a typmod or an exact bound dropped), else the
 * registered cast into the exact family, defined on every value; undefined where `to` widens no value of `from`.
 */
export const wideningOf = (from: ScalarType, to: ScalarType): Widening | undefined => {
	const source = baseOf(from).carrier
	const target = baseOf(to).carrier
	if (source === target) {
		return { kind: "coercion" }
	}
	const op = castOf(source, target)
	return op === undefined || op.partial ? undefined : { kind: "registered", op }
}

/** The identity of the one widening (wideningOf), as an expression names it. */
export const widening = (from: ScalarType, to: ScalarType): DefinedOp | undefined => {
	const w = wideningOf(from, to)
	return w === undefined ? undefined : w.kind === "coercion" ? binaryCoercion : definedIdOf(w.op)
}

export const isFloat = (t: ScalarType): boolean => {
	const c = baseOf(t).carrier
	return c === "float4" || c === "float8"
}
