/**
 * The reader of PostgreSQL's output texts (core/wire.ts OutputText): each carrier's conversion of a result cell into
 * its host value in its one form, and the one text of the value a cell spells, each over a text PostgreSQL wrote and
 * no other. A parameter text grizzle wrote is a ParamText, which no reader takes, so no path reads back a text grizzle
 * wrote; the architecture's zones (.fallowrc.json) give this module to the decode sites alone.
 *
 * - `convert` reads the text PostgreSQL writes for the column into its host value in its one form, trusting it
 *   (values/convert.ts): the text is PostgreSQL's own output of a value of the column's type, so nothing is checked. A
 *   bytes column's cell is no text but its value, which its statement's delivery assembled (codec/delivery.ts).
 * - `cellText` reads the one text of the value a cell spells straight off the cell, with no host value between: the
 *   identity the shell stitches parent keys by.
 *
 * The texts read, per carrier:
 *
 * | Carrier | Read |
 * | --- | --- |
 * | int2, int4, int8 | int2out/int4out/int8out text |
 * | numeric | numeric_out text, read into the one form |
 * | float4, float8 | float4out/float8out text, read exactly, -0 as 0 |
 * | money | money::numeric text |
 * | bool | true, false (bool::text), t, f (boolout) |
 * | uuid | uuid_out text |
 * | date | date_out text under DateStyle ISO |
 * | text | the string |
 * | bytes | no text: the cell is the value its delivery assembled (codec/delivery.ts), its one text its windows-1252 decode |
 * | code | int2out text, read as the handle the code names |
 * | bits | bit_out text, read as the set of handles |
 * | range4, range8, rangeDate | range_out of a bounded half-open range |
 * | vector | vector_out text, components read exactly as binary32, -0 as 0 |
 *
 * Raw text results. The adapter's wire requests text results and parses no type
 * (packages/grizzle/src/adapter/wire/session.ts), and the outermost SELECT casts every column to text, so every cell is
 * PostgreSQL's own output text of a text value, whatever type the column has and whatever a driver would make of it:
 * `resultTextCasts` names the casts, and test/pg/codec pins the behaviour. That text is raw: equal values can spell
 * differently in it (a stored 1.50, a -0), and `convert` and `cellText` are where it becomes the value's one form.
 * Money is read through money::numeric under the fixed C.UTF-8 monetary context.
 */
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { bytesValueOf, outputTextOf } from "#compiler/core/decoder.ts"
import { bitInputText, hexOfBitText } from "#compiler/core/hex.ts"
import type { Cell } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import { bytesText } from "#compiler/scalar/values/bytes.ts"
import {
	type Converter,
	convertByCarrier,
	type TextCarrier
} from "#compiler/scalar/values/convert.ts"
import type { CarrierHost, CarrierSpec, SpecOf } from "#compiler/scalar/values/identity.ts"

/** A column's reader: its cell's host value, and the one text of the value its cell holds. */
export interface ScalarReader {
	readonly type: ScalarType
	/** The exact carrier's spec (values/identity.ts), which compares two values the reader converted. */
	readonly spec: CarrierSpec
	/**
	 * A delivered cell of this type as its canonical host value, trusting it: PostgreSQL's output text converted, or a
	 * bytes column's assembled value itself.
	 */
	readonly convert: (cell: Cell) => CarrierHost[Carrier]
	/**
	 * The one text of the value a cell holds, read off the cell: two cells of this type have equal cell texts exactly
	 * when their values are equal. The cell itself for the carriers whose output is already one text per value;
	 * numeric with trailing fractional zeros dropped, which is the value's canonical text; a float's "-0" as "0", and
	 * otherwise float4out's or float8out's own shortest spelling; a vector's "-0" components as "0"; a boolean's "t"/"f"
	 * as "true"/"false"; a set's 0s and 1s as X and their hex digits; a bytes value's windows-1252 decode, its one text
	 * (scalar/values/bytes.ts bytesText). Chosen once per column; no allocation where the cell is already the one text.
	 */
	readonly cellText: (cell: Cell) => string
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

/** bit_out text of a set, whole hex digits long, as its one text, the text its encoder writes: X then its hex digits. */
const bitsCellText = (cell: string): string => bitInputText(hexOfBitText(cell))

/** boolout's t and f, or bool::text's true and false: one letter tells them apart. */
const boolCellText = (cell: string): string => (cell.startsWith("t") ? "true" : "false")

/** The one text of the value an output cell spells, per text carrier, chosen once per column. */
const cellTextByCarrier: { readonly [C in TextCarrier]: (cell: string) => string } = {
	int2: itself,
	int4: itself,
	int8: itself,
	numeric: numericCellText,
	float4: floatCellText,
	float8: floatCellText,
	money: itself,
	bool: boolCellText,
	uuid: itself,
	date: itself,
	text: itself,
	code: itself,
	bits: bitsCellText,
	range4: itself,
	range8: itself,
	rangeDate: itself,
	vector: vectorCellText,
	exactInteger: itself,
	exactMoney: numericCellText
}

/** The reader of one text carrier's spec: its conversion read through the spec's own carrier, of a text cell. */
const textReaderOf = <C extends TextCarrier>(
	type: ScalarType,
	spec: SpecOf<C> & CarrierSpec
): ScalarReader => {
	const own: SpecOf<C> = spec
	const convertOf: (spec: SpecOf<C>) => Converter<C> = convertByCarrier[own.carrier]
	const convert = convertOf(own)
	const text = cellTextByCarrier[own.carrier]
	return Object.freeze({
		type,
		spec,
		convert: (cell: Cell) => convert(outputTextOf(cell)),
		cellText: (cell: Cell) => text(outputTextOf(cell))
	})
}

/** The reader of a descriptor under an installation's codes: every descriptor has one, its carrier's. */
export const scalarReader = (type: ScalarType, codes: Codebook): ScalarReader => {
	const spec = carrierSpecOf(type, codes)
	return spec.carrier === "bytes"
		? Object.freeze({
				type,
				spec,
				convert: bytesValueOf,
				cellText: (cell: Cell) => bytesText(bytesValueOf(cell))
			})
		: textReaderOf(type, spec)
}
