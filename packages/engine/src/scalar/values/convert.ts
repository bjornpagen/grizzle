import { handleAt, type RosterCodec } from "#compiler/ir/codes.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { convertDate } from "#compiler/ir/date.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { convertComponent, convertDouble, convertReal } from "#compiler/scalar/values/float.ts"
import type { CarrierHost, SpecOf } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"

/** The conversion of one carrier's output text, built from its spec. */
export type Converter<C extends Carrier> = (text: string) => CarrierHost[C]

/**
 * range_out of a bounded half-open range, "[start,end)", its endpoints read by `endpoint`: the range carrier's own
 * integers, or a span descriptor's endpoint column (scalar/span.ts), whose contract brands them.
 */
export const convertSpan =
	<E>(endpoint: (text: string) => E) =>
	(text: string): Span<E> => {
		const comma = text.indexOf(",")
		return Object.freeze({
			start: endpoint(text.slice(1, comma)),
			end: endpoint(text.slice(comma + 1, -1))
		})
	}

/**
 * vector_out text, "[c1,...,cn]": the components converted straight into a Float32Array of the column's dimensions, one
 * comma at a time, with no intermediate array or substring. The vector is of the column's N dimensions, the tag a
 * pg.vector(N) descriptor's column carries (scalar/vector.ts).
 */
export const convertVector =
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
 * | range4, range8 | range_out of a bounded half-open range, [start,end) | a frozen { start, end } |
 * | vector | vector_out, [c1,...,cn] | a Float32Array of the column's dimensions, components exactly binary32 |
 * | exactInteger | int8out or numeric_out of an integer | BigInt, the exact integer |
 * | exactMoney | numeric_out of an amount at scale 2 | Money.fromOutput, an exact count of any size |
 *
 * Every converter is a per-row hot path, run on each value of each row a statement returns: native string methods and
 * index loops, no Option or closure per character, and one allocation for the value itself.
 */
export const convertByCarrier: { readonly [C in Carrier]: (spec: SpecOf<C>) => Converter<C> } = {
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
	vector: (spec) => convertVector(spec.dimensions),
	exactInteger: () => BigInt,
	exactMoney: () => (text) => Money.fromOutput(text)
}
