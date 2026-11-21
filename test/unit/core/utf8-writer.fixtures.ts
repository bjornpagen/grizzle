/** What the properties of utf8-writer.test.ts read: its spaces, models and helpers. */

import {
	isWellFormedText,
	jsonText,
	type Overflow,
	Utf8Writer,
	type WellFormedText
} from "@bjornpagen/grizzle-text/utf8"
import { array, element, type Gen, int, map, oneOf, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"

const platform = new TextEncoder()

/**
 * A piece a writer writes: a string's JSON literal, a number's JSON text, a well-formed text as it is, or ASCII
 * punctuation.
 */
export type Piece =
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "text"; readonly value: WellFormedText }
	| { readonly kind: "ascii"; readonly value: string }

export type WriterFeature =
	| "a short escape"
	| "a control's \\u escape"
	| "a lone surrogate escaped"
	| "a surrogate pair"
	| "a two-byte point"
	| "a three-byte point"
	| "a safe integer"
	| "a negative integer"
	| "negative zero"
	| "a number past the safe integers"
	| "a fraction"
	| "a number JSON writes as null"
	| "a text"
	| "drained"
	| "a piece longer than the chunk"

/**
 * One scalar, as JSON's grammar and UTF-8 read it: each control, the quotation mark, the reverse solidus and the
 * printable ASCII around them, the edges of the UTF-8 widths, U+FFFD and U+FFFF, and a supplementary character's pair.
 */
const scalar: Gen<string> = weighted([
	[3, map(int(0x00, 0x7f), (c) => String.fromCharCode(c))],
	[1, map(int(0x80, 0x7ff), (c) => String.fromCharCode(c))],
	[1, map(int(0x800, 0xd7ff), (c) => String.fromCharCode(c))],
	[1, map(int(0xe000, 0xffff), (c) => String.fromCharCode(c))],
	[1, map(int(0x1_0000, 0x10_ffff), (c) => String.fromCodePoint(c))]
])

/** A lone surrogate of either half, which no well-formed text holds and JSON.stringify writes as its escape. */
const loneSurrogate: Gen<string> = map(int(0xd800, 0xdfff), (c) => String.fromCharCode(c))

/** A string of any code units, lone surrogates among them: JSON.stringify writes every string. */
const anyString: Gen<string> = map(
	array(
		weighted([
			[6, scalar],
			[1, loneSurrogate]
		]),
		{ min: 0, max: 12 }
	),
	Arr.join("")
)

/** Well-formed text: scalars alone. */
const wellFormedText: Gen<WellFormedText> = map(array(scalar, { min: 0, max: 12 }), (scalars) => {
	const text = Arr.join(scalars, "")
	if (!isWellFormedText(text)) {
		throw new Error("a text of scalars is well-formed")
	}
	return text
})

/** A number of each kind JSON writes: safe integers of each sign and size, -0, the edges past them, fractions, and the
 * numbers JSON has none for. */
const number: Gen<number> = oneOf([
	int(-1000, 1000),
	int(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
	element([
		-0,
		2 ** 53,
		-(2 ** 53),
		1e21,
		1.5,
		-0.1,
		5e-324,
		1 / 3,
		Number.NaN,
		Number.POSITIVE_INFINITY
	])
])

const piece: Gen<Piece> = oneOf<Piece>([
	map(anyString, (value): Piece => ({ kind: "string", value })),
	map(number, (value): Piece => ({ kind: "number", value })),
	map(wellFormedText, (value): Piece => ({ kind: "text", value })),
	map(element(["[", "]", ",", ":"]), (value): Piece => ({ kind: "ascii", value }))
])

/** A case: the pieces written in order, and the chunk a drained writer drains at, or none for a growing one. */
export interface WriterCase {
	readonly pieces: ReadonlyArray<Piece>
	readonly chunk: number | "grow"
}

export const writerGen: Gen<WriterCase> = (source) => ({
	pieces: source.draw(array(piece, { min: 0, max: 16 })),
	chunk: source.draw(
		weighted<number | "grow">([
			[1, element(["grow"])],
			[3, int(1, 48)]
		])
	)
})

/** The text a piece writes, as JSON.stringify and the text itself spell it: the oracle. */
export const expectedText = (p: Piece): string => {
	switch (p.kind) {
		case "string":
		case "number":
			return jsonText(p.value)
		case "text":
		case "ascii":
			return p.value
	}
}

/** The UTF-8 the platform's encoder writes of a text, well-formed here: a lone surrogate's literal is its escape. */
export const platformBytes = (text: string): ReadonlyArray<number> => [...platform.encode(text)]

/** The most bytes a piece reserves at once: six a code unit of a string's literal and its quotes, three a code unit of
 * a text, one a character of a number's or of punctuation's text. */
export const reservedBytes = (p: Piece): number => {
	switch (p.kind) {
		case "string":
			return 6 * p.value.length + 2
		case "text":
			return 3 * p.value.length
		case "number":
		case "ascii":
			return expectedText(p).length
	}
}

/** The pieces written into a writer of `overflow`, with the bytes it drained, in order. */
export const written = (
	c: WriterCase
): { readonly out: Utf8Writer; readonly drained: ReadonlyArray<number> } => {
	const drained: Array<number> = []
	const overflow: Overflow =
		c.chunk === "grow"
			? { kind: "grow" }
			: {
					kind: "drain",
					chunk: c.chunk,
					into: (bytes) => {
						for (const byte of bytes) {
							drained.push(byte)
						}
					}
				}
	const out = new Utf8Writer(overflow)
	for (const p of c.pieces) {
		switch (p.kind) {
			case "string":
				out.jsonString(p.value)
				break
			case "number":
				out.jsonNumber(p.value)
				break
			case "text":
				out.text(p.value)
				break
			case "ascii":
				out.ascii(p.value)
				break
		}
	}
	return { out, drained }
}

/** Each code point of a string as the platform iterates it, a lone surrogate as itself. */
const pointsOf = (s: string): ReadonlyArray<number> =>
	Arr.map(Arr.fromIterable(s), (point) =>
		Option.getOrThrowWith(Str.codePointAt(point, 0), () => new Error("a code point"))
	)

/** The code units JSON.stringify writes by a short escape: the five controls, the quotation mark and the reverse solidus. */
const shortEscaped: ReadonlySet<number> = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x22, 0x5c])

/** The situations a piece reaches. */
export const featuresOf = (p: Piece, note: (f: WriterFeature) => void): void => {
	if (p.kind === "number") {
		const x = p.value
		note(
			Object.is(x, -0)
				? "negative zero"
				: !Number.isFinite(x)
					? "a number JSON writes as null"
					: !Number.isInteger(x)
						? "a fraction"
						: !Number.isSafeInteger(x)
							? "a number past the safe integers"
							: x < 0
								? "a negative integer"
								: "a safe integer"
		)
		return
	}
	if (p.kind === "text") {
		note("a text")
	}
	if (p.kind !== "string" && p.kind !== "text") {
		return
	}
	for (const point of pointsOf(p.value)) {
		if (point >= 0x1_0000) {
			note("a surrogate pair")
		} else if (point >= 0xd800 && point <= 0xdfff) {
			note("a lone surrogate escaped")
		} else if (shortEscaped.has(point) && p.kind === "string") {
			note("a short escape")
		} else if (point < 0x20 && p.kind === "string") {
			note("a control's \\u escape")
		} else if (point >= 0x80 && point < 0x800) {
			note("a two-byte point")
		} else if (point >= 0x800) {
			note("a three-byte point")
		}
	}
}
