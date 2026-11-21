/** What the properties of sha256.test.ts read: its spaces, models and helpers. */

import { isWellFormedText, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { array, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Option, String as Str } from "effect"

const platform = new TextEncoder()

export type Feature =
	| "a one-byte point"
	| "a two-byte point"
	| "a three-byte point"
	| "a four-byte point"
	| "an empty text"

/** Each code point of `text` as the platform iterates it. */
const pointsOf = (text: string): ReadonlyArray<number> =>
	Arr.map(Arr.fromIterable(text), (point) =>
		Option.getOrThrowWith(Str.codePointAt(point, 0), () => new Error("a code point"))
	)

/** The bytes of a well-formed text as the platform's UTF-8 encoder writes them, the bytes its UTF-8 is. */
export const platformBytes = (text: WellFormedText): ReadonlyArray<number> => [
	...platform.encode(text)
]

/** The situation each code point of a text is, by its UTF-8 width. */
export const noteText = (text: string, c: Case<Feature>): void => {
	if (text.length === 0) {
		c.note("an empty text")
	}
	for (const cp of pointsOf(text)) {
		c.note(
			cp < 0x80
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
 * Well-formed text, through the brand's one door (grizzle-text isWellFormedText): any scalar by its UTF-8 width, ASCII,
 * two bytes, three bytes on either side of the surrogates, and a supplementary character's pair.
 */
export const wellFormedTexts: Gen<WellFormedText> = map(
	array(
		weighted([
			[1, map(int(0, 0x7f), (c) => String.fromCharCode(c))],
			[1, map(int(0x80, 0x7ff), (c) => String.fromCharCode(c))],
			[1, map(int(0x800, 0xd7ff), (c) => String.fromCharCode(c))],
			[1, map(int(0xe000, 0xffff), (c) => String.fromCharCode(c))],
			[1, map(int(0x1_0000, 0x10_ffff), (c) => String.fromCodePoint(c))]
		]),
		{ min: 0, max: 10 }
	),
	(scalars) => {
		const text = Arr.join(scalars, "")
		if (!isWellFormedText(text)) {
			throw new Error("a text of scalars is well-formed")
		}
		return text
	}
)

export type MessagesFeature =
	| "a message longer than its chunk"
	| "messages one after another"
	| "an empty message"

/** Messages written one after another, each of drawn well-formed pieces, and the chunk their writer drains at. */
export const messagesGen: Gen<{
	readonly messages: ReadonlyArray<ReadonlyArray<WellFormedText>>
	readonly chunk: number
}> = (source) => ({
	messages: source.draw(array(array(wellFormedTexts, { min: 0, max: 8 }), { min: 1, max: 4 })),
	chunk: source.draw(int(1, 32))
})
