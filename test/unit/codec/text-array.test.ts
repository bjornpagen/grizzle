/**
 * A text column's binary array (codec/bytea.ts textArray): a text[] in the array binary format whose every element is
 * its text's UTF-8 bytes, which PostgreSQL's textrecv reads back as the text the host holds. A case is a few texts:
 * the empty text, short runs of scalars of every plane, long runs of one scalar, and texts that end in a scalar of
 * U+0400 to U+07FF after a prefix of any length, the texts Node's TextEncoder.encodeInto underfilled a destination of
 * exactly their length with (nodejs/node#65994, upstream/node).
 *
 * Oracle: the array binary format read back by a second reader (test/support/arrays.ts readArrayBinary, array_recv's
 * layout), each element decoded by a strict UTF-8 decoder, which refuses a malformed byte, a 0x00 left where a
 * character was not written among them, as textrecv refuses one.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): text-array-encode-into (each element written by
 * TextEncoder.encodeInto into a destination of exactly its length, which Node underfills).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { textArray } from "#compiler/codec/bytea.ts"
import { readArrayBinary } from "#test/support/arrays.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

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

/** The texts of the lengths where nodejs/node#65994 underfilled on Node v26.13.0, each kept. */
const underfilled: ReadonlyArray<readonly [string, string]> = [
	["U+0400 x 258 then 'a'", `${Str.repeat(258)("Ѐ")}a`],
	["U+0400 x 263 then 'a'", `${Str.repeat(263)("Ѐ")}a`],
	["U+0400 x 317 then 'a'", `${Str.repeat(317)("Ѐ")}a`],
	["U+0400 x 950 then 'a'", `${Str.repeat(950)("Ѐ")}a`],
	["'a' x 52 then U+0400", `${Str.repeat(52)("a")}Ѐ`],
	["'a' x 309 then U+0400", `${Str.repeat(309)("a")}Ѐ`]
]

type TextFeature =
	| "no text"
	| "the empty text"
	| "a long text"
	| "an astral scalar"
	| "a text of 53 units or more that ends in U+0400 to U+07FF"
	| "a text of 53 units or more that holds U+0400 to U+07FF and ends in another scalar"

const decoder = new TextDecoder("utf-8", { fatal: true })

/** Whether a code point is one of U+0400 to U+07FF. */
const inTwoByteRange = (code: number): boolean => code >= 0x04_00 && code <= 0x07_ff

/** Whether a text ends in a scalar of U+0400 to U+07FF. */
const endsTwoByte = (t: string): boolean =>
	Option.exists(Str.codePointAt(t.length - 1)(t), inTwoByteRange)

/** Whether a text holds a scalar of U+0400 to U+07FF. */
const holdsTwoByte = (t: string): boolean =>
	Arr.some(Arr.fromIterable(t), (point) => Option.exists(Str.codePointAt(0)(point), inTwoByteRange))

describe("a text column's binary array", () => {
	it.effect(
		"holds each text as its UTF-8 bytes, which a strict decoder reads back as the text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/text-array",
						oracle: {
							kind: "second-implementation",
							name: "the array binary format read back, each element decoded as strict UTF-8"
						},
						draw: drawn(array(text, { min: 0, max: 5 })),
						literal: Formatter.format,
						coverage: required<TextFeature>(
							[
								"no text",
								"the empty text",
								"a long text",
								"an astral scalar",
								"a text of 53 units or more that ends in U+0400 to U+07FF",
								"a text of 53 units or more that holds U+0400 to U+07FF and ends in another scalar"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: Arr.map(underfilled, ([note, t]) => ({
							note: `nodejs/node#65994 on Node v26.13.0: ${note}`,
							sketch: [t],
							draws: "",
							reaches: [
								endsTwoByte(t)
									? "a text of 53 units or more that ends in U+0400 to U+07FF"
									: "a text of 53 units or more that holds U+0400 to U+07FF and ends in another scalar"
							]
						})),
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(texts, c) =>
						Effect.sync(() => {
							if (texts.length === 0) {
								c.note("no text")
							}
							for (const t of texts) {
								if (t === "") {
									c.note("the empty text")
								}
								if (t.length >= 2 ** 12) {
									c.note("a long text")
								}
								if (Arr.some(Arr.fromIterable(t), (point) => point.length === 2)) {
									c.note("an astral scalar")
								}
								if (t.length >= 53 && endsTwoByte(t)) {
									c.note("a text of 53 units or more that ends in U+0400 to U+07FF")
								}
								if (t.length >= 53 && holdsTwoByte(t) && !endsTwoByte(t)) {
									c.note(
										"a text of 53 units or more that holds U+0400 to U+07FF and ends in another scalar"
									)
								}
							}
							const read = readArrayBinary(
								succeeded(textArray("texts", "body", texts), "a short array fits a message")
							)
							assert.equal(read.elementType, 25, "a text[]")
							assert.equal(read.flags, 0, "no NULL")
							assert.equal(read.lowerBound, 1)
							assert.equal(read.elements.length, texts.length)
							for (const [i, bytes] of read.elements.entries()) {
								assert.equal(
									bytes === null ? null : decoder.decode(bytes),
									defined(texts[i], "each text written"),
									`element ${i} reads back as its text`
								)
							}
						})
				)
			)
	)
})
