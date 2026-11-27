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
 * | inet, cidr | network_show text, its mask always stated, read into inet_out's and cidr_out's |
 * | text | the string |
 * | bytes | no text: the cell is the value its delivery assembled (codec/delivery.ts), its one text its SHA-256 digest |
 * | sha256 | its bytes' wire text, `encode(x, 'base64url')` (core/wire.ts bytesWireAlphabet) |
 * | code | int2out text, read as the handle the code names |
 * | bits | bit_out text, read as the set of handles |
 * | range4, range8, rangeDate | range_out of a bounded half-open range |
 * | vector | vector_out text, components read exactly as binary32, -0 as 0 |
 * | variant | record_out of its composite, read as its tag's handle and its arm's fields |
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
import { sha256FromText, sha256Text } from "#compiler/core/digest.ts"
import { bitInputText, hexOfBitText } from "#compiler/core/hex.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { type Cell, ofWire, type OutputText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { baseOf, type Carrier, type ScalarType } from "#compiler/ir/scalar.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import {
	type Converter,
	convertByCarrier,
	type TextCarrier
} from "#compiler/scalar/values/convert.ts"
import {
	type CarrierHost,
	type CarrierSpec,
	canonicalText,
	keyText,
	type SpecOf
} from "#compiler/scalar/values/identity.ts"

/** A column's reader: its cell's host value, and the one text of the value its cell holds. */
export interface ScalarReader {
	readonly type: ScalarType
	/** The exact carrier's spec (values/identity.ts), which compares two values the reader converted. */
	readonly spec: CarrierSpec
	/**
	 * A delivered cell of this type as its canonical host value, trusting it: PostgreSQL's output text converted, or a
	 * bytes column's assembled value with its digest (scalar/values/bytes.ts AdmittedBytes).
	 */
	readonly convert: (cell: Cell) => CarrierHost[Carrier]
	/**
	 * The one text of the value a cell holds, read off the cell: two cells of this type have equal cell texts exactly
	 * when they hold one value, but bytes, as the value's fact identity (scalar/values/identity.ts canonicalText) is.
	 * The cell itself for the carriers whose output is already one text per value, a float's among them, float4out's or
	 * float8out's own shortest spelling, its "-0" a value of its own; numeric with trailing fractional zeros dropped,
	 * which is the value's canonical text; a vector's "-0" components as "0"; a boolean's
	 * "t"/"f" as "true"/"false"; a set's 0s and 1s as X and their hex digits; a bytes value's SHA-256 digest
	 * (core/sha256.ts sha256Hex), which two values share only if their bytes are equal or they are a SHA-256 collision,
	 * so a reader that takes two cells of one text as one compares their bytes too; a variant's its converted value's
	 * canonical text, since its attributes' output texts are their types' raw ones. Chosen once per column; no
	 * allocation where the cell is already the one text.
	 */
	readonly cellText: (cell: Cell) => string
	/**
	 * The text a key compares a cell by (scalar/values/identity.ts keyText): its cell text, but a float's -0 as 0, since
	 * PostgreSQL's equality holds the two zeros one key, so a parent's key and a child's that PostgreSQL matched are one
	 * text whichever zero each holds.
	 */
	readonly keyText: (cell: Cell) => string
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
	float4: itself,
	float8: itself,
	money: itself,
	bool: boolCellText,
	uuid: itself,
	date: itself,
	inet: itself,
	cidr: itself,
	text: itself,
	sha256: (cell) => sha256Text(ofWire(cell)),
	code: itself,
	bits: bitsCellText,
	range4: itself,
	range8: itself,
	rangeDate: itself,
	vector: vectorCellText,
	tsvector: itself,
	exactInteger: itself,
	exactMoney: numericCellText,
	variant: itself
}

/** The reader of one text carrier's spec: its conversion read through the spec's own carrier, of a text cell. */
const textReaderOf = <C extends TextCarrier>(
	type: ScalarType,
	spec: SpecOf<C> & CarrierSpec
): ScalarReader => {
	const own: SpecOf<C> = spec
	const convertOf: (spec: SpecOf<C>) => Converter<C> = convertByCarrier[own.carrier]
	const convert = convertOf(own)
	const text: (text: OutputText) => string =
		own.carrier === "variant"
			? (cell) => canonicalText(spec, convert(cell))
			: cellTextByCarrier[own.carrier]
	return Object.freeze({
		type,
		spec,
		convert: (cell: Cell) => convert(outputTextOf(cell)),
		cellText: (cell: Cell) => text(outputTextOf(cell)),
		keyText: (cell: Cell) => keyText(spec, text(outputTextOf(cell)))
	})
}

/**
 * The value PostgreSQL's own output text of a value of `type` spells, as an error's DETAIL prints a key: the reader's
 * conversion of a delivered cell (`scalarReader`), whose text is that output text for every carrier but a digest's,
 * which its delivery sends as its bytes' wire text and a DETAIL prints as byteaout's hex, `\x` and two digits a byte,
 * under the bytea_output every role runs with (physical/ddl/roles.ts): its one text (core/digest.ts sha256FromText).
 */
export const detailValue = (
	type: ScalarType,
	codes: Codebook,
	text: OutputText
): CarrierHost[Carrier] =>
	baseOf(type).carrier === "sha256" ? sha256FromText(text) : scalarReader(type, codes).convert(text)

/** The reader of a descriptor under an installation's codes: every descriptor has one, its carrier's. */
export const scalarReader = (type: ScalarType, codes: Codebook): ScalarReader => {
	const spec = carrierSpecOf(type, codes)
	return spec.carrier === "bytes"
		? Object.freeze({
				type,
				spec,
				convert: (cell: Cell) => new AdmittedBytes(bytesValueOf(cell)),
				cellText: (cell: Cell) => sha256Hex(bytesValueOf(cell)),
				keyText: (cell: Cell) => sha256Hex(bytesValueOf(cell))
			})
		: textReaderOf(type, spec)
}
