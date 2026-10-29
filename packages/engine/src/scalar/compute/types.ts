import {
	baseOf,
	type Capability,
	type Carrier,
	capabilitySet,
	contractOf,
	numericTypmodOf,
	rosterOf,
	type ScalarType,
	type SpanInfo,
	sameScalarType,
	spanOf,
	type TextInfo,
	textOf,
	type ValueType,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"
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

const plainCarriers: ReadonlySet<string> = new Set<PlainCarrier>([
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"bool"
])

export const isPlainCarrier = (carrier: Carrier): carrier is PlainCarrier =>
	plainCarriers.has(carrier)

/** The plain value type of a carrier, unfrozen: no contract and, for numeric, no typmod. */
const plainOf = (carrier: PlainCarrier): ValueType => {
	const caps = capabilitySet(...carrierCapabilities[carrier])
	return carrier === "numeric"
		? { carrier, caps, typmod: undefined, contract: undefined }
		: { carrier, caps, contract: undefined }
}

/** The plain result type of a carrier, frozen. */
export const plainType = (carrier: PlainCarrier): ValueType => {
	return Object.freeze(plainOf(carrier))
}

/** The canonical wildcard text type: what a text literal that meets no term has. */
export const wildcardText: ValueType = Object.freeze({
	carrier: "text",
	caps: capabilitySet(...carrierCapabilities.text),
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
				caps: capabilitySet(...carrierCapabilities[t.carrier]),
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
 * The type two compatible operands combine to in a conditional or LEAST/GREATEST: their common type when they agree
 * in every meaning-changing field, otherwise the shared type with the numeric typmod, text refinement or span width
 * widened, as PostgreSQL's select_common_type and select_common_typmod do (a common typmod survives only when all
 * agree). It is the same whichever operand comes first.
 */
export const commonType = (a: ScalarType, b: ScalarType): ScalarType => {
	const x = withoutSerial(a)
	const y = withoutSerial(b)
	if (sameMeaning(x, y)) {
		return x
	}
	if (x.contract !== undefined) {
		return x
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
 * Whether `to` is `from`'s value type with only refinements dropped that PostgreSQL never checks on the way: a contract
 * (its base), a numeric typmod (plain numeric), a text refinement (wildcard text), a span's fixed width. A cast between
 * the two is binary coercible: total and immutable.
 */
export const widensTo = (from: ScalarType, to: ScalarType): boolean => {
	const v = valueType(from)
	if (sameScalarType(to, v) || sameScalarType(to, withoutSpanWidth(v))) {
		return true
	}
	if (v.carrier === "numeric") {
		return sameScalarType(to, plainType("numeric"))
	}
	if (v.carrier === "text") {
		return sameScalarType(to, wildcardText)
	}
	return false
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
	if (spanOf(a)?.width !== spanOf(b)?.width) {
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

export const isFloat = (t: ScalarType): boolean => {
	const c = baseOf(t).carrier
	return c === "float4" || c === "float8"
}
