/** What the properties of text-array.test.ts read: its spaces, models and helpers. */

import {
	array,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"

/** One scalar of a text: an ASCII, Latin-1, two-byte, three-byte or astral one, or one of any plane but NUL. */
const scalar: Gen<string> = weighted([
	[3, element(["a", "é", "Ѐ", "ש", "ك", "߿", "漢", "\u{1F600}", "\u{10FFFF}"])],
	[
		1,
		weighted([
			[1, codePoint(0x01, 0xd7_ff)],
			[1, codePoint(0xe0_00, 0x10_ff_ff)]
		])
	]
])

/** A scalar whose presence let the encodeInto of nodejs/node#65994 underfill: U+0400 to U+07FF. */
const twoByteRange: Gen<string> = codePoint(0x04_00, 0x07_ff)

/** The lengths of the texts that reach the underfill: from where it starts, 53 units, to past where it was seen, 1200. */
const reachLength: Gen<number> = int(53, 1200)

/**
 * A text: the empty text, a short run of scalars, a long run of one scalar, a run of 53 to 1200 scalars, a run of one
 * scalar ending in a scalar of U+0400 to U+07FF and a tail of up to three scalars, or a run of ASCII with one scalar of
 * U+0400 to U+07FF anywhere in it. The underfill's lengths are not contiguous, so every length of the band is drawn.
 */
const text: Gen<string> = weighted([
	[1, constant("")],
	[3, map(array(scalar, { min: 1, max: 8 }), Arr.join(""))],
	[1, map(scalar, (s) => Str.repeat(2 ** 12)(s))],
	[2, map(array(scalar, { min: 53, max: 1200 }), Arr.join(""))],
	[
		3,
		(s) => {
			const run = Str.repeat(s.draw(int(0, 1200)))(s.draw(scalar))
			const tail = Arr.join(s.draw(array(scalar, { min: 0, max: 3 })), "")
			return `${run}${s.draw(twoByteRange)}${tail}`
		}
	],
	[
		2,
		(s) => {
			const length = s.draw(reachLength)
			const at = s.draw(int(0, length - 1))
			return `${Str.repeat(at)("a")}${s.draw(twoByteRange)}${Str.repeat(length - 1 - at)("a")}`
		}
	]
])

/** A case: up to five texts. */
export const texts: Gen<ReadonlyArray<string>> = array(text, { min: 0, max: 5 })

/** A scalar below U+0400, never NUL: ASCII, Latin-1 and the scripts before Cyrillic. */
const belowTwoByte: Gen<string> = codePoint(0x01, 0x03_ff)

/**
 * A case of one text that holds scalars of U+0400 to U+07FF and ends in another: a run of one such scalar, then a
 * scalar below the range, the texts nodejs/node#65994 underfilled a destination of exactly their length with.
 */
export const twoByteRunThenAnother: Gen<ReadonlyArray<string>> = (s) => {
	const run = Str.repeat(s.draw(int(0, 1200)))(s.draw(twoByteRange))
	return [`${run}${s.draw(belowTwoByte)}`]
}

export type TextFeature =
	| "no text"
	| "the empty text"
	| "a long text"
	| "an astral scalar"
	| "a text of 53 units or more that ends in U+0400 to U+07FF"
	| "a text of 53 units or more that holds U+0400 to U+07FF and ends in another scalar"

/** Whether a code point is one of U+0400 to U+07FF. */
const inTwoByteRange = (code: number): boolean => code >= 0x04_00 && code <= 0x07_ff

/** Whether a text ends in a scalar of U+0400 to U+07FF. */
export const endsTwoByte = (t: string): boolean =>
	Option.exists(Str.codePointAt(t.length - 1)(t), inTwoByteRange)

/** Whether a text holds a scalar of U+0400 to U+07FF. */
export const holdsTwoByte = (t: string): boolean =>
	Arr.some(Arr.fromIterable(t), (point) => Option.exists(Str.codePointAt(0)(point), inTwoByteRange))
