/**
 * The test oracles of a bit string's text: a closed relation's packed constant, and a set over a roster.
 *
 * PostgreSQL builds every installed constant itself, from the rows a `PackConstant` statement states, so the engine
 * writes no constant's text. These are the host's second implementations, written cell by cell and position by
 * position, that a suite compares PostgreSQL's packed value, or a bits value's wire text, against (testing doctrine,
 * rule 3).
 */
import { Array as Arr, String as Str } from "effect"
import type { CompileBound } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { Constant } from "#compiler/ir/cells.ts"

/**
 * The constant as PostgreSQL's bit-string text: each cell's bits, most significant first, from cell 0, where an absent
 * cell is `width` zeros and a held one is 1 + its payload's code in binary. ResourceBound (stringLength) when the text
 * would be longer than `limit` characters, measured before it is built.
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

/**
 * A set over a roster of `size` codes as its bit(size) text: position c is 1 exactly when code c is a member, so a hole,
 * which no member holds, is 0, and the text is `size` characters long whatever the members.
 */
export const setText = (size: number, members: ReadonlyArray<number>): string => {
	const held = new Set(members)
	return Arr.join(
		Arr.map(
			Arr.makeBy(size, (code) => code),
			(code) => (held.has(code) ? "1" : "0")
		),
		""
	)
}
