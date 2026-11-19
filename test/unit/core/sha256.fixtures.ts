/** What the properties of sha256.test.ts read: its spaces, models and helpers. */

import { type Case } from "@bjornpagen/testing/explore"
import { array, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"

const platform = new TextEncoder()

export type Feature =
	| "a one-byte point"
	| "a two-byte point"
	| "a three-byte point"
	| "a four-byte point"
	| "a lone surrogate"
	| "an empty text"

const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff

/** Each code point of `text` as the platform iterates it, a lone surrogate as a code point of its own. */
const pointsOf = (text: string): ReadonlyArray<number> =>
	Arr.map(Arr.fromIterable(text), (point) =>
		Option.getOrThrowWith(Str.codePointAt(point, 0), () => new Error("a code point"))
	)

/**
 * The bytes of `text` by the definition of the encoding fingerprints hash, one code point at a time: a surrogate code
 * point is 0xE0 | cp >> 12, 0x80 | (cp >> 6) & 0x3F, 0x80 | cp & 0x3F; every other code point is the platform
 * encoder's.
 */
export const generalized = (text: string): ReadonlyArray<number> =>
	Arr.flatMap(pointsOf(text), (cp) =>
		isSurrogate(cp)
			? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)]
			: [...platform.encode(String.fromCodePoint(cp))]
	)

/**
 * Each lone surrogate of `text` the platform's TextEncoder writes as anything but U+FFFD's bytes (0xEF 0xBF 0xBD): none,
 * which is why generalized UTF-8 states its own bytes for one.
 */
export const platformLoneSurrogates = (text: string): ReadonlyArray<number> =>
	Arr.filter(pointsOf(text), (cp) => {
		if (!isSurrogate(cp)) {
			return false
		}
		const written = platform.encode(String.fromCharCode(cp))
		return !(
			written.length === 3 &&
			written[0] === 0xef &&
			written[1] === 0xbf &&
			written[2] === 0xbd
		)
	})

/** The situation each code point of a text is, by its UTF-8 width or as a lone surrogate. */
export const noteText = (text: string, c: Case<Feature>): void => {
	if (text.length === 0) {
		c.note("an empty text")
	}
	for (const cp of pointsOf(text)) {
		c.note(
			isSurrogate(cp)
				? "a lone surrogate"
				: cp < 0x80
					? "a one-byte point"
					: cp < 0x800
						? "a two-byte point"
						: cp < 0x1_0000
							? "a three-byte point"
							: "a four-byte point"
		)
	}
}

/**
 * Arbitrary UTF-16: any code unit by class (ASCII, any BMP unit, a surrogate unit, a supplementary character's pair),
 * so lone surrogates appear and adjacent surrogate units also pair up.
 */
export const utf16: Gen<string> = map(
	array(
		weighted([
			[1, map(int(0, 0x7f), (c) => String.fromCharCode(c))],
			[1, map(int(0, 0xffff), (c) => String.fromCharCode(c))],
			[1, map(int(0xd800, 0xdfff), (c) => String.fromCharCode(c))],
			[1, map(int(0x1_0000, 0x10_ffff), (c) => String.fromCodePoint(c))]
		]),
		{ min: 0, max: 10 }
	),
	(units) => Arr.join(units, "")
)
