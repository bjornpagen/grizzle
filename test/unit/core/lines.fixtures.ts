/** What the properties of lines.test.ts read: its spaces, models and helpers. */

import {
	characterOf,
	codePoint,
	constant,
	type Gen,
	int,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type * as Engine from "#compiler/core/result.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"

export type Longest =
	| "within V8's longest string"
	| "V8's longest string"
	| "past V8's longest string"

/** Where a drawn limit falls against the text's length: the situations the measure's arithmetic must get right. */
export type Bound = "far within" | "at the limit" | "one past" | "far past"

/** One line a writer writes, `depth` views deep. */
export interface Written {
	readonly depth: number
	readonly text: string
}

/** A text's pieces: ASCII, a newline inside a line, and an astral character, two UTF-16 code units. */
export const piece: Gen<string> = weighted([
	[4, string(characterOf(["a", "b", " ", ","] as const), { min: 0, max: 6 })],
	[1, constant("\n")],
	[1, codePoint(0x1_0000, 0x1_0010)]
])

/** How far the limit sits from the text's length, by the situation it puts the measure in. */
export const offset: Gen<number> = weighted([
	[2, int(2, 40)],
	[3, constant(0)],
	[3, constant(-1)],
	[2, int(-40, -2)]
])

export const boundOf = (length: number, limit: number): Bound =>
	limit === length
		? "at the limit"
		: limit === length - 1
			? "one past"
			: limit > length
				? "far within"
				: "far past"

/** The limit drawn around `length`, never below zero. */
export const limitAround = (length: number, by: number): number => Math.max(length + by, 0)

export const at = SourceLoc("drawn text", [])

/**
 * Exactly the expected text when it fits, and otherwise ResourceBound (text) at `at` with the expected text's length
 * as `needed`: the oracle is the text joined by hand.
 */
export const agrees = (
	actual: Engine.Result<string, CompileError>,
	expected: string,
	limit: number
): void => {
	if (expected.length <= limit) {
		assert.equal(succeeded(actual), expected)
		return
	}
	assert.deepEqual(refused(actual, "ResourceBound").reason, {
		_tag: "ResourceBound",
		at,
		bound: { kind: "stringLength", limit, needed: expected.length }
	})
}

/** A frame's text: none, one of two literals, or a drawn piece. */
export const frame = (one: string, other: string): Gen<string> =>
	weighted([
		[1, constant("")],
		[1, constant(one)],
		[1, constant(other)],
		[1, piece]
	])

/** How a text past JavaScript's longest string is made of lines: the fewest that pass it, or more. */
export type Past = "the fewest lines past" | "more lines past"
