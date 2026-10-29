import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { floatText } from "#compiler/codec/float.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { Encoder } from "#compiler/ir/products.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import { type Converter, convertByCarrier } from "#compiler/scalar/values/convert.ts"
import {
	admitted,
	admitValue,
	type CarrierHost,
	type CarrierSpec,
	identityText,
	type SpecOf
} from "#compiler/scalar/values/identity.ts"
import { spanText } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"

/**
 * Exact text-mode codecs per ScalarType.
 *
 * A ScalarCodec is built once per descriptor and is a set of straight-line closures: no eval,
 * no per-value dispatch on the descriptor. It has three parts:
 *
 * - `encode` admits a host value through the exact carrier's boundary (values/identity.ts admitValue: integer range,
 *   numeric precision and scale, binary32 rounding, -0 as +0, uuid case, span order and fixed width, vector dimensions, finite components
 *   and cosine domain) and writes the value's text form. That text is the parameter text (bound untyped and cast by the statement, $n::type)
 *   and the JSON string of a recordset field (recordset.ts). Every value is a JSON string, so NaN and the infinities
 *   travel as text and reach the column's input function exactly.
 * - `text` writes the text form of a value the carrier already admitted.
 * - `convert` reads the text form PostgreSQL writes for the column into its host value, trusting it
 *   (values/convert.ts): the text is PostgreSQL's own output of a value of the column's type, so nothing is checked.
 *
 * The text forms, per carrier:
 *
 * | Carrier | Written | Read |
 * | --- | --- | --- |
 * | int2, int4, int8 | decimal digits | int2out/int4out/int8out text |
 * | numeric | numeric_out text, display scale kept; NaN, Infinity, -Infinity | the same |
 * | float4, float8 | shortest round-trip decimal; NaN, Infinity, -Infinity | float4out/float8out text, read exactly |
 * | money | the amount as numeric text at scale 2, cast ($n::numeric)::money | money::numeric text |
 * | bool | true, false | true, false (bool::text), t, f (boolout) |
 * | uuid | lowercase hyphenated | uuid_out text |
 * | text, enum | the string, the handle | the same |
 * | range4, range8 | [start,end) | range_out of a bounded half-open range |
 * | vector | [c1,...,cn], shortest binary32 texts | vector_out text, components read exactly as binary32 |
 *
 * Money never travels as its own locale-formatted text: it is written as numeric text and
 * converted by the statement, and read through money::numeric under the fixed C.UTF-8 monetary context, whose two
 * fractional digits admission verifies. A contract column uses its base's codec: the brand has no runtime form,
 * and the library evaluates no contract predicate or regex on the host.
 *
 * Raw text results. The adapter's wire requests text results and parses no type (packages/grizzle/src/adapter/wire/session.ts), and
 * the outermost SELECT casts every column to text, so every cell is PostgreSQL's own output text of a text value,
 * whatever type the column has and whatever a driver would make of it: `resultTextCasts` names the casts, and
 * test/pg/codec pins the behaviour.
 */
export interface ScalarCodec {
	readonly type: ScalarType
	/** The exact carrier's admission spec (values/identity.ts), which fact identity uses. */
	readonly spec: CarrierSpec
	/** Admit a host value and write its text form. */
	readonly encode: (value: unknown) => Result.Result<string, CodecFault>
	/**
	 * The text form of an admitted value. A value of another carrier's host type is a defect, and throws: the check
	 * stays, since its callers hold a fact's values as unknown, and this is where a value's carrier type is read.
	 */
	readonly text: (value: unknown) => string
	/**
	 * The identity text of an admitted or converted value (values/identity.ts identityText), as fact identity writes it.
	 * A value of another carrier's host type is a defect, and throws.
	 */
	readonly identity: (value: unknown) => string
	/** PostgreSQL's text form of a value of this type, converted into a host value of its carrier without a check. */
	readonly convert: (text: string) => CarrierHost[Carrier]
	/** The identity text of the value PostgreSQL's text form converts to (convert, identity), read through one carrier. */
	readonly textIdentity: (text: string) => string
}

/** The admission spec of a key field's type: every carrier's but a vector's, whose float32 equality is no identity. */
export type KeySpec = Exclude<CarrierSpec, { readonly carrier: "vector" }>

/** The carrier admission spec of a type no vector is. */
export const keySpecOf = (type: Exclude<ScalarType, { readonly carrier: "vector" }>): KeySpec => {
	switch (type.carrier) {
		case "numeric":
			return { carrier: "numeric", typmod: type.typmod }
		case "enum":
			return { carrier: "enum", handles: type.roster.handles }
		case "range4":
		case "range8":
			return { carrier: type.carrier, width: type.span.width }
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "text":
			return { carrier: type.carrier }
	}
}

/**
 * The carrier admission spec of a descriptor. A contract shares its base's carrier, typmod, roster and span
 * (ir/scalar.ts), so the outer descriptor already carries everything the spec needs.
 */
export const carrierSpecOf = (type: ScalarType): CarrierSpec =>
	type.carrier === "vector" ? { carrier: "vector", dimensions: type.typmod.dims } : keySpecOf(type)

/** The text form of one carrier's host values. */
const textByCarrier: { readonly [C in Carrier]: (value: CarrierHost[C]) => string } = {
	int2: (v) => String(v),
	int4: (v) => String(v),
	int8: (v) => String(v),
	numeric: (v) => v.toString(),
	float4: (v) => floatText(v),
	float8: (v) => floatText(v),
	money: (v) => v.toString(),
	bool: (v) => (v ? "true" : "false"),
	uuid: (v) => v,
	text: (v) => v,
	enum: (v) => v,
	range4: (v) => spanText(v),
	range8: (v) => spanText(v),
	vector: (v) => Vector.componentText(v)
}

/**
 * The codec of one carrier's spec: its text form and its conversion read through the spec's own carrier, so the
 * admitted value, its text form and its converted value are of one host type by construction.
 */
const codecOf = <C extends Carrier>(
	type: ScalarType,
	spec: SpecOf<C> & CarrierSpec
): ScalarCodec => {
	const own: SpecOf<C> = spec
	const textOf: (value: CarrierHost[C]) => string = textByCarrier[own.carrier]
	const convertOf: (spec: SpecOf<C>) => Converter<C> = convertByCarrier[own.carrier]
	const convert = convertOf(own)
	const text = (value: unknown): string => textOf(admitted(spec, value))
	const identity = (value: unknown): string => identityText(spec, admitted(spec, value))
	const textIdentity = (cell: string): string => identityText(spec, convert(cell))
	const encode = (value: unknown): Result.Result<string, CodecFault> => {
		if (value === null || value === undefined) {
			return Result.err("nullValue")
		}
		const admittedValue = admitValue(spec, value)
		return !admittedValue.ok
			? Result.err(admittedValue.error)
			: Result.ok(textOf(admittedValue.value))
	}
	return Object.freeze({ type, spec, encode, text, identity, convert, textIdentity })
}

/** The codec of a descriptor: every descriptor has one, its carrier's. */
export const scalarCodec = (type: ScalarType): ScalarCodec => codecOf(type, carrierSpecOf(type))

/**
 * The parameter encoder of a template slot (ir/products.ts Encoder, ParamSlot.encode): the codec's encode with its
 * refusal as EncodingFailure naming the slot.
 */
export const paramEncoder = (type: ScalarType, slot: string): Encoder => {
	const { encode } = scalarCodec(type)
	const place = slotPlace(slot)
	const encoder: Encoder = (value) => {
		const text = encode(value)
		return !text.ok ? Result.err(encodeFailure(text.error, place)) : Result.ok(text.value)
	}
	return encoder
}

/**
 * The casts the outermost SELECT applies to a result column of this type so the driver delivers its text form:
 * money through numeric, every other type straight to text. The names are built-in type names.
 */
export const resultTextCasts = (type: ScalarType): ReadonlyArray<"numeric" | "text"> =>
	type.carrier === "money" ? ["numeric", "text"] : ["text"]

/**
 * Whether equal values of `t` always print alike, so its result text is its identity under native equality: every
 * carrier but the numeric and floating ones, whose equal values can print differently (1.0 and 1.00, -0 and 0). A
 * contract shares its base's carrier.
 */
export const printsAlike = (t: ScalarType): boolean =>
	t.carrier !== "numeric" && t.carrier !== "float4" && t.carrier !== "float8"
