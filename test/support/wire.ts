/**
 * The tests' door to the two wire texts (packages/engine/src/core/wire.ts): a text a test states PostgreSQL wrote, an
 * OutputText, and a parameter text a test sends on the wire itself, a ParamText, each minted here alone, so a test
 * that fabricates either says so by name; grizzle's own code mints neither but at the wire and its encoders.
 *
 * `echoed` is the tests' model of what PostgreSQL answers for a value it read from a parameter text: the output text
 * of that value as a reader tells it, the text itself for every carrier whose input and output forms coincide, and a
 * set's X and hex digits as bit_out's 0s and 1s, one per bit of the hex digits.
 */
import { Array as Arr, String as Str } from "effect"
import { nominal } from "#compiler/core/brand.ts"
import type { OutputRows, OutputText, Param, ParamText } from "#compiler/core/wire.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** A text a test states PostgreSQL wrote. */
export const outputText = nominal<string, OutputText>()

/** A test's rows of texts it states PostgreSQL wrote. */
export const outputRows = (rows: ReadonlyArray<ReadonlyArray<string>>): OutputRows =>
	Arr.map(rows, (row) => Arr.map(row, outputText))

/** A parameter text a test sends on the wire itself, or expects an encoder to write. */
export const paramText = nominal<string, ParamText>()

/**
 * A placeholder's value as its text, for a test whose statements hold no bytes column's member array, the one binary
 * parameter (codec/bytea.ts): a binary one there is the test's own error, and throws.
 */
export const textOfParam = (param: Param): ParamText => {
	if (typeof param !== "string") {
		throw new Error("a binary parameter where the test's statements hold no bytes column")
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
