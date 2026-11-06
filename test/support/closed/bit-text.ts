/**
 * The test oracles of a bit string's text: a closed relation's installed constant, a set over a roster, and the hex
 * spelling grizzle writes either in.
 *
 * PostgreSQL installs a constant from the hex literal the host's encoder states (ir/cells.ts literalOf), and stores a set
 * in its roster's bits domain. These are the host's second implementations, written cell by cell and position by
 * position, sharing no code with the engine's hex encoder (core/hex.ts), that a suite compares PostgreSQL's value, the
 * encoder's literal, or a set's wire text against (testing doctrine, rule 3). Each rounds a string up to whole hex digits
 * by its own arithmetic: four bits a digit, the bits past the last cell or code 0.
 */
import { Array as Arr, String as Str } from "effect"
import type { CompileBound } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { Constant } from "#compiler/ir/cells.ts"

/** The bits one hex digit spells, as the oracle counts them. */
const nibble = 4

/** `bits` rounded up to whole hex digits: the length of every bit string grizzle writes of `bits` bits. */
export const wholeDigits = (bits: number): number => Math.ceil(bits / nibble) * nibble

/**
 * The constant's cells as bit-string text: each cell's bits, most significant first, from cell 0, where an absent cell
 * is `width` zeros and a held one is 1 + its payload's code in binary, exactly cells · width characters.
 * ResourceBound (stringLength) when the text would be longer than `limit` characters, measured before it is built.
 */
export const bitText = (constant: Constant, limit: number): Result.Result<string, CompileBound> => {
	const bits = constant.cells * BigInt(constant.width)
	if (bits > BigInt(limit)) {
		return Result.err({ kind: "stringLength", limit, needed: Number(bits) })
	}
	const width = constant.width
	const parts: Array<string> = []
	let written = 0
	for (const entry of constant.entries) {
		const start = Number(entry.index) * width
		parts.push(
			Str.repeat(start - written)("0"),
			Str.padStart(width, "0")((1n + entry.payload).toString(2))
		)
		written = start + width
	}
	parts.push(Str.repeat(Number(bits) - written)("0"))
	return Result.ok(Arr.join(parts, ""))
}

/** A bit string's text padded with 0s on the right to whole hex digits. */
const padded = (text: string): string => Str.padEnd(wholeDigits(text.length), "0")(text)

/**
 * The constant as PostgreSQL holds it once installed, its cells' bits (bitText) padded with 0s to whole hex digits, as
 * its one hex literal states it. ResourceBound as bitText.
 */
export const installedText = (
	constant: Constant,
	limit: number
): Result.Result<string, CompileBound> => Result.map(bitText(constant, limit), padded)

/**
 * A set over a roster of `size` codes as its bits domain's text, bit(n) with n the codes rounded up to whole hex digits:
 * position c is 1 exactly when code c is a member, so a hole, which no member holds, and every position past the last
 * code are 0, and the text is n characters long whatever the members.
 */
export const setText = (size: number, members: ReadonlyArray<number>): string => {
	const held = new Set(members)
	return Arr.join(
		Array.from({ length: wholeDigits(size) }, (_, code) => (held.has(code) ? "1" : "0")),
		""
	)
}

/**
 * A bit string's text, whole hex digits long, as its hex digits: each four characters read as one binary numeral and
 * written in 0-9 and A-F. A text of another length is a defect of its caller.
 */
export const hexOfText = (text: string): string => {
	if (text.length % nibble !== 0) {
		throw new Error(`a text of ${text.length} bits is no whole number of hex digits`)
	}
	return Arr.join(
		Array.from({ length: text.length / nibble }, (_, d) =>
			Str.toUpperCase(
				Number.parseInt(Str.slice(d * nibble, (d + 1) * nibble)(text), 2).toString(16)
			)
		),
		""
	)
}

/** Hex digits as the bit-string text they spell: each digit its four bits, most significant first. */
export const textOfHex = (hex: string): string =>
	Arr.join(
		Arr.map(Array.from(hex), (digit) =>
			Str.padStart(nibble, "0")(Number.parseInt(digit, 16).toString(2))
		),
		""
	)
