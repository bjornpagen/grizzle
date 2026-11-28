import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { nominal } from "#compiler/core/brand.ts"
import {
	type CellConversion,
	type Column,
	convertColumn,
	type ConvertedCarrier
} from "#compiler/core/decoder.ts"
import { sha256FromText } from "#compiler/core/digest.ts"
import { ofWire, type OutputText } from "#compiler/core/wire.ts"
import { isIntegerTypmod } from "#compiler/ir/carriers.ts"
import { handleAt, type RosterCodec } from "#compiler/ir/codes.ts"
import { convertDate } from "#compiler/ir/date.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { Numeric, type NumericTypmod } from "#compiler/scalar/values/decimal.ts"
import { numericOwnBound } from "#compiler/scalar/values/fault.ts"
import { convertComponent, convertDouble, convertReal } from "#compiler/scalar/values/float.ts"
import type {
	CarrierHost,
	CarrierSpec,
	SpecOf,
	VariantValue
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { convertCidr, convertInet } from "#compiler/scalar/values/net.ts"
import { recordAttributes } from "#compiler/scalar/values/record.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"

/**
 * The carriers a cell of which is an output text: every carrier but bytes, whose cell is its value, assembled from the
 * chunks it travels in (codec/delivery.ts).
 */
export type TextCarrier = Exclude<Carrier, "bytes">

/** The conversion of one carrier's output text, PostgreSQL's and no other, built from its spec. */
export type Converter<C extends TextCarrier> = (text: OutputText) => CarrierHost[C]

/** An endpoint's text inside a range's output text: PostgreSQL's output of the endpoint, minted where it is cut out. */
const endpointText = nominal<string, OutputText>()

/**
 * range_out of a bounded half-open range, "[start,end)", its endpoints read by `endpoint`: the range carrier's own
 * integers, or a span descriptor's endpoint column (scalar/span.ts), whose contract brands them. Each endpoint's text
 * is the endpoint type's own output, which range_out writes between the bounds.
 */
const convertSpan =
	<E>(endpoint: (text: OutputText) => E) =>
	(text: OutputText): Span<E> => {
		const comma = text.indexOf(",")
		return Object.freeze({
			start: endpoint(endpointText(text.slice(1, comma))),
			end: endpoint(endpointText(text.slice(comma + 1, -1)))
		})
	}

/**
 * vector_out text, "[c1,...,cn]": the components converted straight into a Float32Array of the column's dimensions, one
 * comma at a time, with no intermediate array or substring. The vector is of the column's N dimensions, the tag a
 * vector(N) descriptor's column carries (scalar/vector.ts).
 */
const convertVector =
	<N extends number>(dimensions: N) =>
	(text: string): Vector<N> => {
		const buffer = new Float32Array(dimensions)
		const last = text.length - 1
		let start = 1
		for (let i = 0; i < dimensions; i++) {
			const comma = text.indexOf(",", start)
			const end = comma < 0 ? last : comma
			buffer[i] = convertComponent(text, start, end)
			start = end + 1
		}
		return Vector.branded(buffer)
	}

const identity = (text: string): string => text

/** int2out of a closed id's code: the live handle it names. */
const convertCode =
	(roster: RosterCodec) =>
	(text: string): string =>
		handleAt(roster, Number(text))

/**
 * bit(n)'s output text, position i code i: a fresh Set of the handles of its 1 bits, one per converted value, which the
 * reader owns. It is not frozen: Object.freeze leaves a Set's members writable, so freezing would promise nothing.
 */
const convertBits =
	(roster: RosterCodec) =>
	(text: string): ReadonlySet<string> => {
		const handles = new Set<string>()
		for (let code = text.indexOf("1"); code >= 0; code = text.indexOf("1", code + 1)) {
			handles.add(handleAt(roster, code))
		}
		return handles
	}

/** An attribute's text inside a record's output text: PostgreSQL's output of the attribute, minted where it is cut out. */
const attributeText = nominal<string, OutputText>()

/**
 * The attributes of a record's output text (scalar/values/record.ts recordAttributes), each PostgreSQL's output of the
 * attribute, none where the attribute is NULL: what a variant's composite is read from, here and by a decoder
 * (runtime/read/record.ts).
 */
export const recordAttributeTexts = (text: OutputText): ReadonlyArray<OutputText | undefined> =>
	recordAttributes(text).map((a) => (a === undefined ? undefined : attributeText(a)))

/**
 * The conversion of one attribute of a variant's composite (ir/scalar.ts VariantType), as record_out writes it: its
 * type's own output, which its carrier's conversion reads, but a digest's, which record_out writes as byteaout's hex
 * under the bytea_output every role runs with (core/digest.ts sha256FromText), never as the wire text its own column's
 * delivery sends. A bytes attribute is a defect: no arm holds one (scalar/registry.ts isArmFieldType).
 */
const attributeConversion = (spec: CarrierSpec): ((text: OutputText) => unknown) => {
	switch (spec.carrier) {
		case "sha256":
			return (text) => sha256FromText(text)
		case "bytes":
			defect("no variant arm holds bytea")
		case "bits":
		case "bool":
		case "cidr":
		case "code":
		case "date":
		case "exactInteger":
		case "exactMoney":
		case "float4":
		case "float8":
		case "inet":
		case "int2":
		case "int4":
		case "int8":
		case "money":
		case "numeric":
		case "range4":
		case "range8":
		case "rangeDate":
		case "text":
		case "tsvector":
		case "uuid":
		case "variant":
		case "vector":
			return textConversion(spec)
	}
}

/** The conversion of a text carrier's spec, read through the spec's own carrier. */
const textConversion = <C extends TextCarrier>(
	spec: SpecOf<C> & CarrierSpec
): ((text: OutputText) => unknown) => {
	const own: SpecOf<C> = spec
	const convertOf: (spec: SpecOf<C>) => Converter<C> = convertByCarrier[own.carrier]
	return convertOf(own)
}

/**
 * record_out of a variant's composite: its tag's code as the live handle it names, and each field of that arm read from
 * its attribute by its own conversion (attributeConversion), into a frozen record, the tag first and then the arm's
 * fields in declared order (scalar/values/identity.ts VariantValue). The text is PostgreSQL's own, of a value its
 * domain admitted, so the tagged arm's every attribute is present.
 */
const convertVariant = (spec: SpecOf<"variant">): Converter<"variant"> => {
	const arms = new Map(
		Array.from(
			spec.arms,
			([handle, arm]) =>
				[
					handle,
					arm.fields.map((f) => ({
						name: f.name,
						at: f.at,
						convert: attributeConversion(f.spec)
					}))
				] as const
		)
	)
	return (text) => {
		const attributes = recordAttributeTexts(text)
		const tag = handleAt(spec.roster, Number(attributes[0]))
		const value: Record<string, unknown> = { tag }
		for (const field of defined(arms.get(tag), "a variant's arm")) {
			value[field.name] = field.convert(defined(attributes[field.at], "a tagged arm's attribute"))
		}
		const held: VariantValue = Object.freeze({ ...value, tag })
		return held
	}
}

/**
 * The conversion of PostgreSQL's output text of a column into its host value, one per carrier.
 *
 * A conversion yields the value in its carrier's one form, so equal values PostgreSQL spells differently (1.50 and 1.5,
 * a vector component's -0 and 0) convert to one host value: decode is conversion only, into the canonical form. A
 * float's -0 is no spelling of 0 but a value of its own (float.ts), read back as -0.
 *
 * A conversion trusts its text. Every text it meets is PostgreSQL's own output of a value of the column's type in the
 * fixed execution context Db.open verifies (extra_float_digits = 1, DateStyle ISO, the C.UTF-8 monetary context), written by grizzle's
 * own SQL, whose outermost SELECT casts every column to text: so a conversion checks no syntax, range, typmod, roster or
 * dimension, returns no Result and never refuses. Each one is a straight-line closure built once per descriptor.
 *
 * | Carrier | Text | Host value |
 * | --- | --- | --- |
 * | int2, int4 | int2out, int4out | Number |
 * | int8 | int8out | BigInt |
 * | numeric | numeric_out, at any display scale | Numeric.fromOutput, the one form: trailing fractional zeros dropped |
 * | float8 | float8out | Number, -0 its own |
 * | float4 | float4out, shortest binary32 text | the binary32 value exactly (float.ts convertReal), -0 its own |
 * | money | money::numeric | Money.fromOutput, the minor-unit count |
 * | bool | `true`/`false` (bool::text), `t`/`f` (boolout) | the first letter is t |
 * | uuid, text | uuid_out, the string | the text itself |
 * | sha256 | its bytes' wire text, `encode(x, 'base64url')` (core/wire.ts bytesWireAlphabet) | a fresh Uint8Array of them, the column's Sha256 |
 * | tsvector | tsvectorout, its lexemes in order with their positions and weights | the text itself |
 * | date | date_out under DateStyle ISO, YYYY-MM-DD | the text itself, a CalendarDate |
 * | inet | inet_out; network_show in a fused array (c::text), its mask always stated | as inet_out prints it |
 * | cidr | cidr_out, which network_show prints alike | read and printed as cidr_out prints it, the same text |
 * | code | int2out of the code | the live handle the code names |
 * | bits | bit_out, n characters of 0 and 1 | a fresh Set of the handles of its 1 bits, position i code i |
 * | range4, range8, rangeDate | range_out of a bounded half-open range, [start,end) | a frozen { start, end } |
 * | vector | vector_out, [c1,...,cn] | a Float32Array of the column's dimensions, components exactly binary32 |
 * | exactInteger, an integer numeric's spec | int8out or numeric_out of an integer | BigInt, the exact integer |
 * | exactMoney | numeric_out of an amount at scale 2 | Money.fromOutput, an exact count of any size |
 * | variant | record_out of its composite | a frozen record of its tag's handle and its arm's fields (convertVariant) |
 *
 * Every converter is a per-row hot path, run on each value of each row a statement returns: native string methods and
 * index loops, no Option or closure per character, and one allocation for the value itself.
 */
export const convertByCarrier: {
	readonly [C in TextCarrier]: (spec: SpecOf<C>) => Converter<C>
} = {
	int2: () => Number,
	int4: () => Number,
	int8: () => BigInt,
	numeric: () => (text) => Numeric.fromOutput(text),
	float4: () => convertReal,
	float8: () => convertDouble,
	money: () => (text) => Money.fromOutput(text),
	/** bool::text writes true and false, boolout t and f: one letter tells them apart. */
	bool: () => (text) => text.startsWith("t"),
	uuid: () => identity,
	date: () => convertDate,
	inet: () => convertInet,
	cidr: () => convertCidr,
	text: () => identity,
	sha256: () => ofWire,
	code: (spec) => convertCode(spec.roster),
	bits: (spec) => convertBits(spec.roster),
	range4: () => convertSpan(Number),
	range8: () => convertSpan(BigInt),
	rangeDate: () => convertSpan(convertDate),
	vector: (spec) => convertVector(spec.dimensions),
	tsvector: () => identity,
	exactInteger: () => BigInt,
	exactMoney: () => (text) => Money.fromOutput(text),
	variant: (spec) => convertVariant(spec)
}

/**
 * Each converted carrier's spec (core/decoder.ts ConvertedCarrier): its carrier's, of no typmod, width or roster, a
 * column's whatever its declaration's, which its conversion and its value's one text (conversionSpec) read alike.
 */
const conversionSpecs: { readonly [C in ConvertedCarrier]: SpecOf<C> } = {
	int2: { carrier: "int2" },
	int4: { carrier: "int4" },
	int8: { carrier: "int8" },
	numeric: { carrier: "numeric", typmod: undefined, bound: numericOwnBound },
	float4: { carrier: "float4" },
	float8: { carrier: "float8" },
	money: { carrier: "money" },
	bool: { carrier: "bool" },
	uuid: { carrier: "uuid" },
	date: { carrier: "date" },
	inet: { carrier: "inet" },
	cidr: { carrier: "cidr" },
	text: { carrier: "text" },
	sha256: { carrier: "sha256" },
	tsvector: { carrier: "tsvector" },
	range4: { carrier: "range4", width: undefined },
	range8: { carrier: "range8", width: undefined },
	rangeDate: { carrier: "rangeDate", width: undefined },
	exactInteger: { carrier: "exactInteger", typmod: undefined },
	exactMoney: { carrier: "exactMoney" }
}

/** Each converted carrier's conversion (core/decoder.ts ConvertedCarrier), built once from its carrier's spec. */
const converted: { readonly [C in ConvertedCarrier]: Converter<C> } = {
	int2: convertByCarrier.int2(conversionSpecs.int2),
	int4: convertByCarrier.int4(conversionSpecs.int4),
	int8: convertByCarrier.int8(conversionSpecs.int8),
	numeric: convertByCarrier.numeric(conversionSpecs.numeric),
	float4: convertByCarrier.float4(conversionSpecs.float4),
	float8: convertByCarrier.float8(conversionSpecs.float8),
	money: convertByCarrier.money(conversionSpecs.money),
	bool: convertByCarrier.bool(conversionSpecs.bool),
	uuid: convertByCarrier.uuid(conversionSpecs.uuid),
	date: convertByCarrier.date(conversionSpecs.date),
	inet: convertByCarrier.inet(conversionSpecs.inet),
	cidr: convertByCarrier.cidr(conversionSpecs.cidr),
	text: convertByCarrier.text(conversionSpecs.text),
	sha256: convertByCarrier.sha256(conversionSpecs.sha256),
	tsvector: convertByCarrier.tsvector(conversionSpecs.tsvector),
	range4: convertByCarrier.range4(conversionSpecs.range4),
	range8: convertByCarrier.range8(conversionSpecs.range8),
	rangeDate: convertByCarrier.rangeDate(conversionSpecs.rangeDate),
	exactInteger: convertByCarrier.exactInteger(conversionSpecs.exactInteger),
	exactMoney: convertByCarrier.exactMoney(conversionSpecs.exactMoney)
}

/** The spec a column's conversion reads its values by (core/decoder.ts CellConversion): its carrier's, a vector's of its dimensions. */
export const conversionSpec = (conversion: CellConversion): CarrierSpec =>
	conversion.carrier === "vector"
		? { carrier: "vector", dimensions: conversion.dimensions }
		: conversionSpecs[conversion.carrier]

/** The conversion a column's data states (core/decoder.ts CellConversion): its carrier's, a vector's of its dimensions. */
export const converterOf = (conversion: CellConversion): ((text: OutputText) => unknown) =>
	conversion.carrier === "vector"
		? convertVector(conversion.dimensions)
		: converted[conversion.carrier]

/** The column converting its cells by `carrier`'s conversion, of that carrier's host values. */
export const carrierColumn = <C extends ConvertedCarrier>(carrier: C): Column<CarrierHost[C]> =>
	convertColumn({ carrier })

/**
 * The host type of numeric(p, s) at a scale S, which follows its values: a bigint at a literal scale 0, whose values
 * are integers and never NaN, a Numeric at any other literal scale, and either at a scale only a number states, which
 * no type tells apart. types/fields (NumericTypmodField) states it to a caller.
 */
export type NumericHostOf<S extends number> = number extends S
	? Numeric | bigint
	: `${S}` extends "0"
		? bigint
		: Numeric

/**
 * numeric(p, s)'s column at its scale S: at scale 0 (ir/carriers.ts isIntegerTypmod) the exact integer's conversion, BigInt
 * reading numeric_out's digits, since its values are integers and never NaN; at any other numeric's, a Numeric. Its host type is the scale's (types/fields NumericHostOf), which a literal scale states.
 */
export const numericColumn = <S extends number>(
	typmod: NumericTypmod & { readonly scale: S }
): Column<NumericHostOf<S>> =>
	convertColumn({ carrier: isIntegerTypmod(typmod) ? "exactInteger" : "numeric" })

/** The column converting vector_out texts into Vectors of `dimensions` dimensions. */
export const vectorColumn = <N extends number>(dimensions: N): Column<Vector<N>> =>
	convertColumn({ carrier: "vector", dimensions })
