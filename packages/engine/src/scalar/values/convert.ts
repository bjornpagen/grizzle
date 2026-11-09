import { nominal } from "#compiler/core/brand.ts"
import {
	type CellConversion,
	type Column,
	convertColumn,
	type ConvertedCarrier
} from "#compiler/core/decoder.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import { handleAt, type RosterCodec } from "#compiler/ir/codes.ts"
import { convertDate } from "#compiler/ir/date.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { convertComponent, convertDouble, convertReal } from "#compiler/scalar/values/float.ts"
import type { CarrierHost, SpecOf } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
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
 * pg.vector(N) descriptor's column carries (scalar/vector.ts).
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

/**
 * The conversion of PostgreSQL's output text of a column into its host value, one per carrier.
 *
 * A conversion yields the value in its carrier's one form, so equal values PostgreSQL spells differently (1.50 and 1.5,
 * -0 and 0) convert to one host value: decode is conversion only, into the canonical form.
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
 * | numeric | numeric_out, at any display scale | Decimal.fromOutput, the one form: trailing fractional zeros dropped |
 * | float8 | float8out | Number, -0 as +0 |
 * | float4 | float4out, shortest binary32 text | the binary32 value exactly (float.ts convertReal), -0 as +0 |
 * | money | money::numeric | Money.fromOutput, the minor-unit count |
 * | bool | `true`/`false` (bool::text), `t`/`f` (boolout) | the first letter is t |
 * | uuid, text | uuid_out, the string | the text itself |
 * | date | date_out under DateStyle ISO, YYYY-MM-DD | the text itself, a CalendarDate |
 * | code | int2out of the code | the live handle the code names |
 * | bits | bit_out, n characters of 0 and 1 | a fresh Set of the handles of its 1 bits, position i code i |
 * | range4, range8, rangeDate | range_out of a bounded half-open range, [start,end) | a frozen { start, end } |
 * | vector | vector_out, [c1,...,cn] | a Float32Array of the column's dimensions, components exactly binary32 |
 * | exactInteger | int8out or numeric_out of an integer | BigInt, the exact integer |
 * | exactMoney | numeric_out of an amount at scale 2 | Money.fromOutput, an exact count of any size |
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
	numeric: () => (text) => Decimal.fromOutput(text),
	float4: () => convertReal,
	float8: () => convertDouble,
	money: () => (text) => Money.fromOutput(text),
	/** bool::text writes true and false, boolout t and f: one letter tells them apart. */
	bool: () => (text) => text.startsWith("t"),
	uuid: () => identity,
	date: () => convertDate,
	text: () => identity,
	code: (spec) => convertCode(spec.roster),
	bits: (spec) => convertBits(spec.roster),
	range4: () => convertSpan(Number),
	range8: () => convertSpan(BigInt),
	rangeDate: () => convertSpan(convertDate),
	vector: (spec) => convertVector(spec.dimensions),
	exactInteger: () => BigInt,
	exactMoney: () => (text) => Money.fromOutput(text)
}

/** Each converted carrier's conversion (core/decoder.ts ConvertedCarrier), built once from its carrier's spec. */
const converted: { readonly [C in ConvertedCarrier]: Converter<C> } = {
	int2: convertByCarrier.int2({ carrier: "int2" }),
	int4: convertByCarrier.int4({ carrier: "int4" }),
	int8: convertByCarrier.int8({ carrier: "int8" }),
	numeric: convertByCarrier.numeric({ carrier: "numeric", typmod: undefined }),
	float4: convertByCarrier.float4({ carrier: "float4" }),
	float8: convertByCarrier.float8({ carrier: "float8" }),
	money: convertByCarrier.money({ carrier: "money" }),
	bool: convertByCarrier.bool({ carrier: "bool" }),
	uuid: convertByCarrier.uuid({ carrier: "uuid" }),
	date: convertByCarrier.date({ carrier: "date" }),
	text: convertByCarrier.text({ carrier: "text" }),
	range4: convertByCarrier.range4({ carrier: "range4", width: undefined }),
	range8: convertByCarrier.range8({ carrier: "range8", width: undefined }),
	rangeDate: convertByCarrier.rangeDate({ carrier: "rangeDate", width: undefined }),
	exactInteger: convertByCarrier.exactInteger({ carrier: "exactInteger" }),
	exactMoney: convertByCarrier.exactMoney({ carrier: "exactMoney" })
}

/** The conversion a column's data states (core/decoder.ts CellConversion): its carrier's, a vector's of its dimensions. */
export const converterOf = (conversion: CellConversion): ((text: OutputText) => unknown) =>
	conversion.carrier === "vector"
		? convertVector(conversion.dimensions)
		: converted[conversion.carrier]

/** The column converting its cells by `carrier`'s conversion, of that carrier's host values. */
export const carrierColumn = <C extends ConvertedCarrier>(carrier: C): Column<CarrierHost[C]> =>
	convertColumn({ carrier })

/** The column converting vector_out texts into Vectors of `dimensions` dimensions. */
export const vectorColumn = <N extends number>(dimensions: N): Column<Vector<N>> =>
	convertColumn({ carrier: "vector", dimensions })
