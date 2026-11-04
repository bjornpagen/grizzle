import type { DefinedOp } from "#compiler/ir/expr.ts"
import {
	baseOf,
	type Capability,
	type Carrier,
	capabilitySet,
	contractOf,
	type ExactValueCarrier,
	exactDigitsOf,
	numericTypmodOf,
	rosterOf,
	type ScalarType,
	type SpanInfo,
	spanOf,
	type TextInfo,
	textOf,
	type ValueType,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"
import {
	binaryCoercion,
	type CastOp,
	castOf,
	definedIdOf
} from "#compiler/scalar/compute/registry.ts"
import { nativeCapabilities } from "#compiler/scalar/registry.ts"

/**
 * The native capabilities of each carrier: the field registry's table (scalar/registry.ts), so a
 * computed type and a declared field of one carrier always carry one capability set.
 */
const carrierCapabilities: { readonly [C in Carrier]: ReadonlyArray<Capability> } =
	nativeCapabilities

/** The plain carriers an operation result can have without further metadata. */
export type PlainCarrier =
	| "int2"
	| "int4"
	| "int8"
	| "numeric"
	| "float4"
	| "float8"
	| "money"
	| "bool"

/** A registered result: a plain carrier, or an exact one, whose digit bound the lowering derives (exactType). */
export type ResultCarrier = PlainCarrier | ExactValueCarrier

/** The plain value type of a carrier, unfrozen: no contract and, for numeric, no typmod. */
const plainOf = (carrier: PlainCarrier): ValueType => {
	const caps = capabilitySet(carrierCapabilities[carrier])
	return carrier === "numeric"
		? { carrier, caps, typmod: undefined, contract: undefined }
		: { carrier, caps, contract: undefined }
}

/** The plain result type of a carrier, frozen. */
export const plainType = (carrier: PlainCarrier): ValueType => {
	return Object.freeze(plainOf(carrier))
}

/** The exact type of `carrier` whose values lie below 10^digits (ir/scalar.ts ExactType), frozen. */
export const exactType = (carrier: ExactValueCarrier, digits: number): ValueType =>
	Object.freeze({ carrier, caps: capabilitySet(carrierCapabilities[carrier]), digits })

/**
 * The integer digits every value of an integer or money type is below, |x| < 10^digits (of the amount, for money): the
 * carrier's range, or an exact type's bound; undefined for any other type.
 */
export const familyDigits = (t: ScalarType): number | undefined => {
	switch (t.carrier) {
		case "int2":
			return 5
		case "int4":
			return 10
		case "int8":
			return 19
		case "money":
			return 17
		case "exactInteger":
		case "exactMoney":
			return t.digits
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
			return undefined
	}
}

/** The canonical wildcard text type: what a text literal that meets no term has. */
export const wildcardText: ValueType = Object.freeze({
	carrier: "text",
	caps: capabilitySet(carrierCapabilities.text),
	contract: undefined,
	text: Object.freeze({ regex: "wildcard", lengthBound: undefined, byteBound: undefined })
})

/**
 * A type's value type, its serial declaration dropped: a serial is an integer column's generation, and its values
 * are the integer's, with the integer's capabilities.
 */
export const withoutSerial = (t: ScalarType): ValueType =>
	"serial" in t
		? Object.freeze({
				carrier: t.carrier,
				caps: capabilitySet(carrierCapabilities[t.carrier]),
				contract: undefined
			})
		: t

/** The base of a type with its serial declaration dropped: what an expression over a field computes with. */
export const valueType = (t: ScalarType): ValueType => withoutSerial(baseOf(t))

/**
 * A span type with its fixed width dropped: what a value compared with a fixed-width span adopts. A width refines the
 * stored value, which the codec checks (scalar/values/span.ts admitSpan); a window compared with the span, or a value
 * equated with it, is any span over the same endpoint.
 */
export const withoutSpanWidth = (t: ScalarType): ScalarType => {
	if ((t.carrier !== "range4" && t.carrier !== "range8") || t.span.width === undefined) {
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
 * otherwise the shared type with the numeric typmod, text refinement or span width widened, as PostgreSQL's
 * select_common_type and select_common_typmod do (a common typmod survives only when all agree). It is the same
 * whichever operand comes first.
 */
export const commonType = (a: ScalarType, b: ScalarType): ScalarType => {
	const x = withoutSerial(a)
	const y = withoutSerial(b)
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
	if (x.carrier === "numeric") {
		return plainType("numeric")
	}
	if (x.carrier === "text") {
		return wildcardText
	}
	if (x.carrier === "range4" || x.carrier === "range8") {
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
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
			return undefined
	}
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
	const fa = exactFamily(withoutSerial(a))
	return (
		fa !== undefined &&
		fa === exactFamily(withoutSerial(b)) &&
		(a.carrier === fa || b.carrier === fa)
	)
}

/**
 * The type an operand meets its partner at (meets): a plain integer or money opposite an exact value of its family is
 * widened into that exact carrier, at its own digit bound; every other operand stands at its own type.
 */
export const meetingType = (operand: ScalarType, partner: ScalarType): ScalarType => {
	const family = exactFamily(withoutSerial(partner))
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
