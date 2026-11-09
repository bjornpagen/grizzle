/**
 * The tests' door to the two wire texts (packages/engine/src/core/wire.ts): a text a test states PostgreSQL wrote, an
 * OutputText, and a parameter a test sends on the wire itself, a ParamText or a ParamBinary, each minted here alone, so
 * a test that fabricates one says so by name; grizzle's own code mints none but at the wire and its encoders.
 *
 * `echoed` is the tests' model of what PostgreSQL answers for a value it read from a parameter text: the output text
 * of that value as a reader tells it, the text itself for every carrier whose input and output forms coincide, and a
 * set's X and hex digits as bit_out's 0s and 1s, one per bit of the hex digits.
 */
import { Array as Arr, String as Str } from "effect"
import { nominal } from "#compiler/core/brand.ts"
import type { OutputRows, OutputText, Param, ParamBinary, ParamText } from "#compiler/core/wire.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** A text a test states PostgreSQL wrote. */
export const outputText = nominal<string, OutputText>()

/** A test's rows of texts it states PostgreSQL wrote. */
export const outputRows = (rows: ReadonlyArray<ReadonlyArray<string>>): OutputRows =>
	Arr.map(rows, (row) => Arr.map(row, outputText))

/** A parameter text a test sends on the wire itself, or expects an encoder to write. */
export const paramText = nominal<string, ParamText>()

/** A binary parameter a test sends on the wire itself, whose bytes the driver sends with format code 1. */
export const paramBinary = nominal<Uint8Array<ArrayBuffer>, ParamBinary>()

/**
 * A placeholder's value as its text, for a test that reads a parameter its statement sends as text: one its statement
 * sends in binary (core/wire.ts Param) has no text, so reading one is the test's own error, and throws.
 */
export const textOfParam = (param: Param): ParamText => {
	if (typeof param !== "string") {
		throw new Error("a binary parameter where the test reads a parameter's text")
	}
	return param
}

/** Placeholder values as their texts (textOfParam). */
export const textsOfParams = (params: ReadonlyArray<Param>): ReadonlyArray<ParamText> =>
	Arr.map(params, textOfParam)

/** The bits one hex digit's value spells, most significant first. */
const digitBits = (digit: string): string =>
	Str.padStart(4, "0")(Number.parseInt(digit, 16).toString(2))

/** The output text PostgreSQL writes for the value it reads from `text`, a parameter text of `type` (see the header). */
export const echoed = (type: ScalarType, text: ParamText): OutputText =>
	type.carrier === "bits"
		? outputText(Arr.join(Arr.map(Str.split("")(Str.slice(1)(text)), digitBits), ""))
		: outputText(text)
