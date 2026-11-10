import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import { type Codebook, codecOf as rosterCodecOf } from "#compiler/ir/codes.ts"
import type { Encoder } from "#compiler/ir/products.ts"
import { type Carrier, isRefined, type ScalarType } from "#compiler/ir/scalar.ts"
import { admitLiteral } from "#compiler/scalar/compute/evaluate.ts"
import { literalDescFor } from "#compiler/scalar/literal.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import {
	admitted,
	admitValue,
	type CarrierHost,
	type CarrierSpec,
	canonicalText,
	type SpecOf
} from "#compiler/scalar/values/identity.ts"

/**
 * Exact text-mode encoders per ScalarType: what grizzle sends PostgreSQL.
 *
 * A ScalarCodec is built once per descriptor and is a set of straight-line closures: no eval, no per-value dispatch
 * on the descriptor. It has two parts, each writing a parameter text (core/wire.ts ParamText), which only the wire
 * sends and nothing in grizzle reads back; PostgreSQL's output texts are read by codec/read.ts alone:
 *
 * - `encode` admits a host value through the exact carrier's boundary (values/identity.ts admitValue: integer range,
 *   numeric precision and scale, binary32 rounding, -0 as +0, uuid case, span order and fixed width, vector
 *   dimensions, finite components and cosine domain) and writes the value's canonical text. That text is the
 *   parameter text (bound untyped and cast by the statement, $n::type), the element of an input's array (recordset.ts)
 *   and the fact identity's part. Every value is a quoted array element, so NaN and the infinities travel as text and
 *   reach the column's input function exactly.
 * - `text` writes the canonical text of a value the carrier already admitted (values/identity.ts canonicalText): one
 *   text per value under native equality.
 *
 * The texts written, per carrier (codec/read.ts states the texts read):
 *
 * | Carrier | Written |
 * | --- | --- |
 * | int2, int4, int8 | decimal digits |
 * | numeric | the one text, numeric_out of trim_scale(value); NaN, Infinity, -Infinity |
 * | float4, float8 | shortest round-trip decimal, one zero; NaN, Infinity, -Infinity |
 * | money | the amount as numeric text at scale 2, cast ($n::numeric)::money |
 * | bool | true, false |
 * | uuid | lowercase hyphenated |
 * | date | YYYY-MM-DD, 0001-01-01 to 9999-12-31 |
 * | text | the string |
 * | bytes | `\x` and two lowercase hex digits a byte, byteain's hex input; a member's array is binary (codec/bytea.ts) |
 * | code | the handle's code, decimal digits |
 * | bits | X then bit(n)'s whole hex digits, position i code i, a hole and the padding 0 |
 * | range4, range8, rangeDate | [start,end) |
 * | vector | [c1,...,cn], shortest binary32 texts, one zero |
 *
 * Money never travels as its own locale-formatted text: it is written as numeric text and converted by the
 * statement. A contract column uses its base's codec: the brand has no runtime form, and the library evaluates no
 * contract predicate or regex on the host.
 */
export interface ScalarCodec {
	readonly type: ScalarType
	/** The exact carrier's admission spec (values/identity.ts), which fact identity uses. */
	readonly spec: CarrierSpec
	/**
	 * Admit a host value and write its canonical text: the parameter text, the array element, the fact identity's part.
	 * A bytes value's is byteain's hex text, which no parameter carries, since no parameter is bytes; its member arrays
	 * travel in binary (codec/bytea.ts).
	 */
	readonly encode: (value: unknown) => Result.Result<ParamText, CodecFault>
	/**
	 * The canonical text of an admitted value: one text per value under native equality. A value of another carrier's
	 * host type is a defect, and throws: the check stays, since its callers hold a fact's values as unknown, and this is
	 * where a value's carrier type is read.
	 */
	readonly text: (value: unknown) => ParamText
}

/**
 * The carrier admission spec of a descriptor. A contract shares its base's carrier, typmod, roster and span
 * (ir/scalar.ts), so the outer descriptor already carries everything the spec needs but a roster's codes, which the
 * installation's codebook holds.
 */
export const carrierSpecOf = (type: ScalarType, codes: Codebook): CarrierSpec => {
	switch (type.carrier) {
		case "vector":
			return { carrier: "vector", dimensions: type.typmod.dims }
		case "numeric":
			return { carrier: "numeric", typmod: type.typmod }
		case "code":
		case "bits":
			return { carrier: type.carrier, roster: rosterCodecOf(codes, type.roster) }
		case "range4":
		case "range8":
		case "rangeDate":
			return { carrier: type.carrier, width: type.span.width }
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "exactInteger":
		case "exactMoney":
			return { carrier: type.carrier }
	}
}

/** A parameter text, minted by the encoders of this module alone: the canonical text of an admitted value. */
const paramText = nominal<string, ParamText>()

/**
 * The parameter text of a value `spec` admitted: its canonical text, which PostgreSQL's input function of its type reads.
 * The one site of the fact that no bytes value is a parameter text: a bytes value travels in binary (codec/bytea.ts),
 * and its canonical text, its digest, is no input of byteain, so one here is a defect.
 */
const parameterText = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: CarrierHost[C]
): ParamText => {
	if (spec.carrier === "bytes") {
		throw defect("a bytes value travels in binary, never as a parameter text")
	}
	return paramText(canonicalText(spec, value))
}

/**
 * The codec of one carrier's spec: its canonical text read through the spec's own carrier, so the admitted value and
 * its text are of one host type by construction.
 */
const codecOf = <C extends Carrier>(
	type: ScalarType,
	spec: SpecOf<C> & CarrierSpec
): ScalarCodec => {
	const text = (value: unknown): ParamText => parameterText(spec, admitted(spec, value))
	const encode = (value: unknown): Result.Result<ParamText, CodecFault> => {
		if (value === null || value === undefined) {
			return Result.err("nullValue")
		}
		const admittedValue = admitValue(spec, value)
		return !admittedValue.ok
			? Result.err(admittedValue.error)
			: Result.ok(parameterText(spec, admittedValue.value))
	}
	return Object.freeze({ type, spec, encode, text })
}

/** The parameter text of a value `spec` already admitted (values/identity.ts admitted): its canonical text. */
export const admittedParam = (spec: CarrierSpec, value: unknown): ParamText =>
	parameterText(spec, admitted(spec, value))

/**
 * A column's cell of a value `spec` already admitted, as a family write's transport carries it (runtime/write/draw.ts
 * MemberCell): a bytes value itself, which its column's binary array carries (codec/bytea.ts), and any other its
 * parameter text.
 */
export const admittedCell = (spec: CarrierSpec, value: unknown): ParamText | AdmittedBytes =>
	spec.carrier === "bytes" ? admitted(spec, value) : admittedParam(spec, value)

/**
 * A plain text's parameter text: a name, a fingerprint or a JSON document grizzle's own statements send as text, written
 * by the text carrier's encoder. Text the carrier refuses (a NUL, a lone surrogate) is a defect: every such text is
 * grizzle's own.
 */
export const textParam = (value: string): ParamText => {
	const admittedText = admitValue({ carrier: "text" }, value)
	if (!admittedText.ok) {
		throw defect(`a text parameter grizzle writes, refused as ${admittedText.error}`)
	}
	return paramText(canonicalText({ carrier: "text" }, admittedText.value))
}

/** A count's parameter text, written by the bigint carrier's encoder. */
export const countParam = (value: number): ParamText =>
	paramText(canonicalText({ carrier: "int8" }, BigInt(value)))

/** The codec of a descriptor under an installation's codes: every descriptor has one, its carrier's. */
export const scalarCodec = (type: ScalarType, codes: Codebook): ScalarCodec =>
	codecOf(type, carrierSpecOf(type, codes))

/**
 * Whether a value is one of a refined type's: every contract level's predicate and every regex holds of it, judged as a
 * literal at the type is (evaluate.ts admitLiteral), where a predicate the evaluator cannot decide at the value admits
 * nothing. Undefined for a type with no refinement. A parameter is checked so at bind, so every fact its type states,
 * a contract's declared facts among them, holds of the value its placeholder carries as its base type. Every value is
 * judged by the automata of `patterns`, the installation's table of the patterns its types read: a served file's, read
 * as generate built them (scalar/regex/matcher.ts ServedPatterns), or a compile's (patterns.ts CompilePatterns).
 */
export const refinedMember = (
	type: ScalarType,
	patterns: PatternReads
): ((value: unknown) => boolean) | undefined => {
	if (!isRefined(type)) {
		return undefined
	}
	return (value) => {
		const literal = literalDescFor(type, value)
		return literal.ok && admitLiteral(literal.value, type, { kind: "refinements", patterns }).ok
	}
}

/**
 * The parameter encoder of a template slot (ir/products.ts Encoder, ParamSlot.encode): the codec's encode, then the
 * value's refinements (refinedMember), judged by `patterns`, with a refusal as EncodingFailure naming the slot.
 */
export const paramEncoder = (
	type: ScalarType,
	slot: string,
	codes: Codebook,
	patterns: PatternReads
): Encoder => {
	const { encode } = scalarCodec(type, codes)
	const member = refinedMember(type, patterns)
	const place = slotPlace(slot)
	const encoder: Encoder = (value) => {
		const text = encode(value)
		if (!text.ok) {
			return Result.err(encodeFailure(text.error, place))
		}
		return member === undefined || member(value)
			? Result.ok(text.value)
			: Result.err(encodeFailure("refinedValue", place))
	}
	return encoder
}

/**
 * The casts the outermost SELECT applies to a result column of this type so the driver delivers its text form:
 * money through numeric, every other type straight to text. The names are built-in type names. A bytes value has no
 * result text: it travels in chunks (lower/delivery.ts), so a cast of one is a defect, and no reader ever meets one.
 */
export const resultTextCasts = (type: ScalarType): ReadonlyArray<"numeric" | "text"> => {
	if (type.carrier === "bytes") {
		throw defect("a bytes value travels in chunks, never as its result text")
	}
	return type.carrier === "money" ? ["numeric", "text"] : ["text"]
}
