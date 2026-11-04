import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { Encoder } from "#compiler/ir/products.ts"
import { type Carrier, isRefined, type ScalarType } from "#compiler/ir/scalar.ts"
import { admitLiteral } from "#compiler/scalar/compute/evaluate.ts"
import { regexMember } from "#compiler/scalar/regex/nfa.ts"
import { literalDescFor } from "#compiler/scalar/registry.ts"
import { type Converter, convertByCarrier } from "#compiler/scalar/values/convert.ts"
import {
	admitted,
	admitValue,
	type CarrierHost,
	type CarrierSpec,
	canonicalText,
	type SpecOf
} from "#compiler/scalar/values/identity.ts"

/**
 * Exact text-mode codecs per ScalarType.
 *
 * A ScalarCodec is built once per descriptor and is a set of straight-line closures: no eval,
 * no per-value dispatch on the descriptor. It has four parts:
 *
 * - `encode` admits a host value through the exact carrier's boundary (values/identity.ts admitValue: integer range,
 *   numeric precision and scale, binary32 rounding, -0 as +0, uuid case, span order and fixed width, vector dimensions, finite components
 *   and cosine domain) and writes the value's canonical text. That text is the parameter text (bound untyped and cast by the statement, $n::type),
 *   the JSON string of a recordset field (recordset.ts) and the fact identity's part. Every value is a JSON string, so NaN and the infinities
 *   travel as text and reach the column's input function exactly.
 * - `text` writes the canonical text of a value the carrier already admitted (values/identity.ts canonicalText): one
 *   text per value under native equality.
 * - `convert` reads the text PostgreSQL writes for the column into its host value in its one form, trusting it
 *   (values/convert.ts): the text is PostgreSQL's own output of a value of the column's type, so nothing is checked.
 * - `cellText` reads the one text of the value a cell spells straight off the cell, with no host value between: the
 *   identity the shell stitches parent keys by.
 *
 * The text forms, per carrier:
 *
 * | Carrier | Written | Read |
 * | --- | --- | --- |
 * | int2, int4, int8 | decimal digits | int2out/int4out/int8out text |
 * | numeric | the one text, numeric_out of trim_scale(value); NaN, Infinity, -Infinity | numeric_out text, read into the one form |
 * | float4, float8 | shortest round-trip decimal, one zero; NaN, Infinity, -Infinity | float4out/float8out text, read exactly, -0 as 0 |
 * | money | the amount as numeric text at scale 2, cast ($n::numeric)::money | money::numeric text |
 * | bool | true, false | true, false (bool::text), t, f (boolout) |
 * | uuid | lowercase hyphenated | uuid_out text |
 * | text, enum | the string, the handle | the same |
 * | range4, range8 | [start,end) | range_out of a bounded half-open range |
 * | vector | [c1,...,cn], shortest binary32 texts, one zero | vector_out text, components read exactly as binary32, -0 as 0 |
 *
 * Money never travels as its own locale-formatted text: it is written as numeric text and
 * converted by the statement, and read through money::numeric under the fixed C.UTF-8 monetary context, whose two
 * fractional digits admission verifies. A contract column uses its base's codec: the brand has no runtime form,
 * and the library evaluates no contract predicate or regex on the host.
 *
 * Raw text results. The adapter's wire requests text results and parses no type (packages/grizzle/src/adapter/wire/session.ts), and
 * the outermost SELECT casts every column to text, so every cell is PostgreSQL's own output text of a text value,
 * whatever type the column has and whatever a driver would make of it: `resultTextCasts` names the casts, and
 * test/pg/codec pins the behaviour. That text is raw: equal values can spell differently in it (a stored 1.50, a -0),
 * and `convert` and `cellText` are where it becomes the value's one form.
 */
export interface ScalarCodec {
	readonly type: ScalarType
	/** The exact carrier's admission spec (values/identity.ts), which fact identity uses. */
	readonly spec: CarrierSpec
	/** Admit a host value and write its canonical text: the parameter text, the recordset field, the fact identity's part. */
	readonly encode: (value: unknown) => Result.Result<string, CodecFault>
	/**
	 * The canonical text of an admitted value: one text per value under native equality. A value of another carrier's
	 * host type is a defect, and throws: the check stays, since its callers hold a fact's values as unknown, and this is
	 * where a value's carrier type is read.
	 */
	readonly text: (value: unknown) => string
	/** PostgreSQL's output text of a value of this type, converted into its canonical host value, trusting it. */
	readonly convert: (cell: string) => CarrierHost[Carrier]
	/**
	 * The one text of the value an output text spells, read off the text: two cells of this type have equal cell texts
	 * exactly when their values are equal. The cell itself for the carriers whose output is already one text per value;
	 * numeric with trailing fractional zeros dropped, which is the value's canonical text; a float's "-0" as "0", and
	 * otherwise float4out's or float8out's own shortest spelling; a vector's "-0" components as "0"; a boolean's "t"/"f"
	 * as "true"/"false". Chosen once per column; no allocation where the cell is already the one text.
	 */
	readonly cellText: (cell: string) => string
}

/**
 * The carrier admission spec of a descriptor. A contract shares its base's carrier, typmod, roster and span
 * (ir/scalar.ts), so the outer descriptor already carries everything the spec needs.
 */
export const carrierSpecOf = (type: ScalarType): CarrierSpec => {
	switch (type.carrier) {
		case "vector":
			return { carrier: "vector", dimensions: type.typmod.dims }
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
		case "exactInteger":
		case "exactMoney":
			return { carrier: type.carrier }
	}
}

const itself = (cell: string): string => cell

/** numeric_out text with its trailing fractional zeros, and a then bare point, dropped: a slice only when it has some. */
const numericCellText = (cell: string): string => {
	const point = cell.indexOf(".")
	if (point < 0) {
		return cell
	}
	let end = cell.length
	while (cell.charCodeAt(end - 1) === 0x30) {
		end--
	}
	if (end === point + 1) {
		end--
	}
	return end === cell.length ? cell : cell.slice(0, end)
}

/** float4out or float8out text: "-0" as "0", every other text as it is (extra_float_digits = 1 writes the shortest). */
const floatCellText = (cell: string): string => (cell === "-0" ? "0" : cell)

/** Whether a vector_out component text, text[from, to), is "-0". */
const isNegativeZero = (text: string, from: number, to: number): boolean =>
	to - from === 2 && text.charCodeAt(from) === 0x2d && text.charCodeAt(from + 1) === 0x30

/** vector_out text with every "-0" component written "0": the cell itself when it has none. */
const vectorCellText = (cell: string): string => {
	let out = ""
	let copied = 0
	let start = 1
	const last = cell.length - 1
	while (start < last) {
		const comma = cell.indexOf(",", start)
		const end = comma < 0 ? last : comma
		if (isNegativeZero(cell, start, end)) {
			out += cell.slice(copied, start)
			copied = start + 1
		}
		start = end + 1
	}
	return copied === 0 ? cell : out + cell.slice(copied)
}

/** boolout's t and f, or bool::text's true and false: one letter tells them apart. */
const boolCellText = (cell: string): string => (cell.startsWith("t") ? "true" : "false")

/** The one text of the value an output cell spells, per carrier, chosen once per column. */
const cellTextByCarrier: { readonly [C in Carrier]: (cell: string) => string } = {
	int2: itself,
	int4: itself,
	int8: itself,
	numeric: numericCellText,
	float4: floatCellText,
	float8: floatCellText,
	money: itself,
	bool: boolCellText,
	uuid: itself,
	text: itself,
	enum: itself,
	range4: itself,
	range8: itself,
	vector: vectorCellText,
	exactInteger: itself,
	exactMoney: numericCellText
}

/**
 * The codec of one carrier's spec: its canonical text and its conversion read through the spec's own carrier, so the
 * admitted value, its text and its converted value are of one host type by construction.
 */
const codecOf = <C extends Carrier>(
	type: ScalarType,
	spec: SpecOf<C> & CarrierSpec
): ScalarCodec => {
	const own: SpecOf<C> = spec
	const convertOf: (spec: SpecOf<C>) => Converter<C> = convertByCarrier[own.carrier]
	const convert = convertOf(own)
	const cellText = cellTextByCarrier[own.carrier]
	const text = (value: unknown): string => canonicalText(spec, admitted(spec, value))
	const encode = (value: unknown): Result.Result<string, CodecFault> => {
		if (value === null || value === undefined) {
			return Result.err("nullValue")
		}
		const admittedValue = admitValue(spec, value)
		return !admittedValue.ok
			? Result.err(admittedValue.error)
			: Result.ok(canonicalText(spec, admittedValue.value))
	}
	return Object.freeze({ type, spec, encode, text, convert, cellText })
}

/** The codec of a descriptor: every descriptor has one, its carrier's. */
export const scalarCodec = (type: ScalarType): ScalarCodec => codecOf(type, carrierSpecOf(type))

/**
 * Whether a value is one of a refined type's: every contract level's predicate and every regex holds of it, judged as a
 * literal at the type is (evaluate.ts admitLiteral), where a predicate the evaluator cannot decide at the value admits
 * nothing. Undefined for a type with no refinement. A parameter is checked so at bind, so every fact its type states,
 * a contract's declared facts among them, holds of the value its placeholder carries as its base type.
 */
export const refinedMember = (type: ScalarType): ((value: unknown) => boolean) | undefined =>
	isRefined(type)
		? (value) => {
				const literal = literalDescFor(type, value)
				return (
					literal.ok && admitLiteral(literal.value, type, { kind: "refinements", regexMember }).ok
				)
			}
		: undefined

/**
 * The parameter encoder of a template slot (ir/products.ts Encoder, ParamSlot.encode): the codec's encode, then the
 * value's refinements (refinedMember), with a refusal as EncodingFailure naming the slot.
 */
export const paramEncoder = (type: ScalarType, slot: string): Encoder => {
	const { encode } = scalarCodec(type)
	const member = refinedMember(type)
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
 * money through numeric, every other type straight to text. The names are built-in type names.
 */
export const resultTextCasts = (type: ScalarType): ReadonlyArray<"numeric" | "text"> =>
	type.carrier === "money" ? ["numeric", "text"] : ["text"]
