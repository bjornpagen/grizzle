import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import { isIntegerTypmod } from "#compiler/ir/carriers.ts"
import {
	type Codebook,
	declaredOrder,
	emptyCodebook,
	firstCodebook,
	codecOf as rosterCodecOf,
	variantLayout
} from "#compiler/ir/codes.ts"
import type { Encoder } from "#compiler/ir/products.ts"
import {
	baseOf,
	type Carrier,
	isFloatType,
	onlyOf,
	type Roster,
	rosterOf,
	type ScalarType,
	type VariantInfo
} from "#compiler/ir/scalar.ts"
import type { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import {
	admitHandles,
	admitSubsetHandle,
	admitted,
	parseValue,
	type CarrierHost,
	type CarrierSpec,
	canonicalText,
	type LiveHandles,
	type SpecOf,
	type VariantArmSpec
} from "#compiler/scalar/values/identity.ts"

/**
 * Exact text-mode encoders per ScalarType: what grizzle sends PostgreSQL.
 *
 * A ScalarCodec is built once per descriptor and is a set of straight-line closures: no eval, no per-value dispatch
 * on the descriptor. It has two parts, each writing a parameter text (core/wire.ts ParamText), which only the wire
 * sends and nothing in grizzle reads back; PostgreSQL's output texts are read by codec/read.ts alone:
 *
 * - `encode` parses a host value exactly as its carrier's (values/identity.ts parseValue: integer range, numeric
 *   precision and scale with no rounding, a real a binary32 value as it is, -0 as +0, uuid case, span order and fixed
 *   width, vector dimensions, finite components and cosine domain) and writes the value's canonical text. That text is the
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
 * | numeric(p, 0), exactInteger | decimal digits, its bigint's |
 * | float4, float8 | shortest round-trip decimal, one zero; NaN, Infinity, -Infinity |
 * | money | the amount as numeric text at scale 2, cast ($n::numeric)::money |
 * | bool | true, false |
 * | uuid | lowercase hyphenated |
 * | date | YYYY-MM-DD, 0001-01-01 to 9999-12-31 |
 * | inet, cidr | inet_out's and cidr_out's text of the value inet_in and cidr_in read (scalar/values/net.ts) |
 * | text | the string |
 * | bytes | `\x` and two lowercase hex digits a byte, byteain's hex input; a member's array is binary (codec/bytea.ts) |
 * | code | the handle's code, decimal digits |
 * | bits | X then bit(n)'s whole hex digits, position i code i, a hole and the padding 0 |
 * | range4, range8, rangeDate | [start,end) |
 * | vector | [c1,...,cn], shortest binary32 texts, one zero |
 * | variant | its composite's record literal: the tag's code, then its arm's fields' texts at their attributes, every attribute quoted, every other arm's left NULL |
 *
 * Money never travels as its own locale-formatted text: it is written as numeric text and converted by the
 * statement. A contract column uses its base's codec: the brand has no runtime form, and the library evaluates no
 * contract predicate or regex on the host, a parameter's included: its placeholder is cast to its refinement's domain,
 * so PostgreSQL checks it.
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

/** The handles of the subset of its roster a closed id of `type` holds, as a set; none for every handle. */
const subsetHandlesOf = (type: ScalarType): ReadonlySet<string> | undefined => {
	const only = onlyOf(type)
	return only === undefined ? undefined : new Set(only)
}

/**
 * The carrier admission spec of a descriptor, read off its base (ir/scalar.ts baseOf), which holds its typmod, roster
 * and span, a contract's carrier being its base's: everything the spec needs but a roster's codes, which the
 * installation's codebook holds. An integer numeric's, numeric(p, 0), is the exact integer's of its typmod, its host
 * value a bigint (values/identity.ts CarrierSpec).
 */
export const carrierSpecOf = (descriptor: ScalarType, codes: Codebook): CarrierSpec => {
	const type = baseOf(descriptor)
	switch (type.carrier) {
		case "vector":
			return { carrier: "vector", dimensions: type.typmod.dims }
		case "numeric":
			return type.typmod === undefined
				? { carrier: "numeric", typmod: undefined, bound: type.bound }
				: isIntegerTypmod(type.typmod)
					? { carrier: "exactInteger", typmod: type.typmod }
					: { carrier: "numeric", typmod: type.typmod }
		case "exactInteger":
			return { carrier: "exactInteger", typmod: undefined }
		case "code":
			return {
				carrier: type.carrier,
				roster: rosterCodecOf(codes, type.roster),
				only: subsetHandlesOf(type)
			}
		case "bits":
			return { carrier: type.carrier, roster: rosterCodecOf(codes, type.roster) }
		case "range4":
		case "range8":
		case "rangeDate":
			return { carrier: type.carrier, width: type.span.width }
		case "variant":
			return variantSpecOf(type.variant, codes)
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "tsvector":
		case "exactMoney":
			return { carrier: type.carrier }
	}
}

/**
 * The spec of a variant under an installation's codes: its tag's roster's codes, and each arm's fields' specs at their
 * attributes of its composite, in its layout under those codes (ir/codes.ts variantLayout).
 */
const variantSpecOf = (variant: VariantInfo, codes: Codebook): CarrierSpec => {
	const roster = rosterCodecOf(codes, variant.roster)
	const layout = variantLayout(variant.arms, roster.names, (f) => isFloatType(f.type))
	const arms = new Map<string, VariantArmSpec>(
		layout.map((arm) => [
			arm.handle,
			Object.freeze({
				fields: Object.freeze(
					arm.fields.map(({ field, at, zero }) =>
						Object.freeze({ name: field.name, spec: carrierSpecOf(field.type, codes), at, zero })
					)
				)
			})
		])
	)
	return {
		carrier: "variant",
		roster,
		arms,
		attributes:
			1 +
			layout.reduce(
				(n, arm) => n + arm.fields.reduce((k, f) => k + (f.zero === undefined ? 1 : 2), 0),
				0
			)
	}
}

/**
 * Every roster a type reads codes of: a closed id's and a set's own, a variant's tag's and those of each of its arms'
 * fields, through contracts.
 */
const rostersIn = (type: ScalarType): ReadonlyArray<Roster> => {
	const base = baseOf(type)
	if (base.carrier === "variant") {
		return [
			base.variant.roster,
			...base.variant.arms.flatMap((arm) => arm.fields.flatMap((f) => rostersIn(f.type)))
		]
	}
	const roster = rosterOf(type)
	return roster === undefined ? [] : [roster]
}

/** A parameter text, minted by the encoders of this module alone: the canonical text of an admitted value. */
const paramText = nominal<string, ParamText>()

/**
 * The parameter text of a value `spec` admitted, from its canonical text (values/identity.ts canonicalText), which
 * PostgreSQL's input function of its type reads: that text itself, the one a write works out of the value and holds
 * beside it (runtime/write/cells.ts Texts). The one site of the fact that no bytes value is a parameter text: a bytes
 * value travels in binary (codec/bytea.ts), and its canonical text, its digest, is no input of byteain, so one here is a
 * defect.
 */
export const paramOfText = (spec: CarrierSpec, text: string): ParamText => {
	if (spec.carrier === "bytes") {
		defect("a bytea value travels in binary, never as a parameter text")
	}
	return paramText(text)
}

/** The parameter text of a value `spec` admitted: its canonical text (`paramOfText`). */
const parameterText = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: CarrierHost[C]
): ParamText => paramOfText(spec, canonicalText(spec, value))

/**
 * A value's one text under `spec`: its exact parse as the spec's carrier's (values/identity.ts parseValue), NULL and
 * undefined refused by the null ban (nullValue), and the admitted value's canonical text, one text per value under the
 * type's equality: a codec's encode before it is a parameter text, and a found row's column's text (program/text.ts
 * rowTextOver).
 */
export const specText =
	<C extends Carrier>(spec: SpecOf<C> & CarrierSpec) =>
	(value: unknown): Result.Result<string, CodecFault> =>
		value === null || value === undefined
			? Result.err("nullValue")
			: Result.map(parseValue(spec, value), (admittedValue) => canonicalText(spec, admittedValue))

/**
 * The codec of one carrier's spec: its canonical text read through the spec's own carrier, so the admitted value and
 * its text are of one host type by construction.
 */
const codecOf = <C extends Carrier>(
	type: ScalarType,
	spec: SpecOf<C> & CarrierSpec
): ScalarCodec => {
	const text = (value: unknown): ParamText => parameterText(spec, admitted(spec, value))
	const exact = specText(spec)
	const encode = (value: unknown): Result.Result<ParamText, CodecFault> =>
		Result.map(exact(value), (canonical) => paramOfText(spec, canonical))
	return Object.freeze({ type, spec, encode, text })
}

/**
 * A column's cell of a value `spec` admitted, as a family write's transport carries it (runtime/write/draw.ts
 * MemberCell), from the value and its canonical text (`paramOfText`): a bytes value itself, which its column's binary
 * array carries (codec/bytea.ts), and any other its parameter text, its canonical text.
 */
export const cellOfText = (
	spec: CarrierSpec,
	value: unknown,
	text: string
): ParamText | AdmittedBytes => (spec.carrier === "bytes" ? admitted(spec, value) : paramText(text))

/**
 * A plain text's parameter text: a name, a fingerprint or a JSON document grizzle's own statements send as text, written
 * by the text carrier's encoder. Text the carrier refuses (a NUL, a lone surrogate) is a defect: every such text is
 * grizzle's own.
 */
export const textParam = (value: string): ParamText => {
	const admittedText = parseValue({ carrier: "text" }, value)
	if (!admittedText.ok) {
		defect(`a text parameter grizzle writes, refused as ${admittedText.error}`)
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
 * A roster's live handles under no installation: its declared order's (ir/codes.ts declaredOrder), against which a
 * closed id's and a set's one text admits a handle as the codec admits it (scalar/values/identity.ts LiveHandles).
 */
const declaredHandles = (roster: Roster): LiveHandles => ({
	roster: roster.closed,
	rank: declaredOrder(roster).rank
})

/**
 * A closed id's one text under no installation: its handle, its host value, a live handle of its roster, and of `only`
 * where the closed id holds a subset of them (admitSubsetHandle). A code is a storage detail of one installation, so no
 * text reads one.
 */
export const handleText = (
	roster: Roster,
	only: ReadonlySet<string> | undefined
): ((value: unknown) => Result.Result<string, CodecFault>) => {
	const live = declaredHandles(roster)
	return (value) => admitSubsetHandle(value, live, only)
}

/**
 * A set's handles under no installation, its one list: each a live handle of its roster (admitHandles), in the roster's
 * declared order.
 */
export const handleList = (
	roster: Roster
): ((value: unknown) => Result.Result<ReadonlyArray<string>, CodecFault>) => {
	const live = declaredHandles(roster)
	const rankOf = (handle: string): number =>
		defined(live.rank.get(handle), "an admitted handle's rank")
	return (value) =>
		Result.map(admitHandles(value, live), (handles) =>
			[...handles].toSorted((a, b) => rankOf(a) - rankOf(b))
		)
}

/**
 * A value's one text read under no installation (program/text.ts codecTextOver), a function of its host value alone: a
 * closed id's its handle (handleText); a set's its handles in its roster's declared order (handleList) as a JSON array,
 * a handle holding any text but NUL; a variant's its codec's encode under the codes a first installation of its rosters
 * would hold (ir/codes.ts firstCodebook), each in its declared order. Every other carrier's is its codec's encode,
 * which reads no code: the exact parse of the value and its canonical text.
 */
export const hostText = (
	type: ScalarType
): ((value: unknown) => Result.Result<string, CodecFault>) => {
	const base = baseOf(type)
	if (base.carrier === "code") {
		return handleText(base.roster, subsetHandlesOf(type))
	}
	if (base.carrier === "bits") {
		const handles = handleList(base.roster)
		return (value) => Result.map(handles(value), jsonText)
	}
	if (base.carrier === "variant") {
		return scalarCodec(type, firstCodebook(rostersIn(type))).encode
	}
	return scalarCodec(type, emptyCodebook).encode
}

/**
 * The parameter encoder of a template slot (ir/products.ts Encoder, ParamSlot.encode): the codec's encode, the exact
 * parse of the value as its base carrier's, with a refusal as EncodingFailure naming the slot. A refined type's contract
 * and pattern are PostgreSQL's: the placeholder is cast to the refinement's domain, which checks the value as it is
 * bound, and its refusal is classified into the law (errors/execution.ts LawRejected, witness/classify.ts).
 */
export const paramEncoder = (type: ScalarType, slot: string, codes: Codebook): Encoder => {
	const { encode } = scalarCodec(type, codes)
	const place = slotPlace(slot)
	const encoder: Encoder = (value) => {
		const text = encode(value)
		return text.ok ? Result.ok(text.value) : Result.err(encodeFailure(text.error, place))
	}
	return encoder
}

/**
 * One step of a value's result text (lower/delivery.ts resultCast): a cast to the built-in type numeric or text, or
 * `wire`, a bytes value's wire text, the one encoding bytes travel in (core/wire.ts bytesWireAlphabet).
 */
export type ResultStep = "numeric" | "text" | "wire"

/**
 * The steps the outermost SELECT applies to a result column of this type so the driver delivers its text form: money
 * through numeric, a digest as its bytes' wire text, every other type straight to text. A bytes value has no result
 * text: it travels in chunks (lower/delivery.ts), so a cast of one is a defect, and no reader ever meets one.
 */
export const resultTextCasts = (type: ScalarType): ReadonlyArray<ResultStep> => {
	switch (baseOf(type).carrier) {
		case "bytes":
			defect("a bytea value travels in chunks, never as its result text")
		case "money":
			return ["numeric", "text"]
		case "sha256":
			return ["wire"]
		case "inet":
		case "cidr":
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
		case "variant":
			return ["text"]
	}
}
