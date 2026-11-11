/**
 * The bytes a fingerprint hashes for a text (core/sha256.ts utf8, utf8Length) and the digest of a text (sha256Hex).
 *
 * - Any UTF-16 string: utf8 writes generalized UTF-8 (WTF-8), each code point as the platform iterates the string, a
 *   lone surrogate as its own three bytes 0xE0 | cp >> 12, 0x80 | (cp >> 6) & 0x3F, 0x80 | cp & 0x3F, never U+FFFD, and
 *   every other code point as the platform's TextEncoder writes it, so well-formed text is the platform's UTF-8; and
 *   utf8Length counts them. Oracle: that definition, code point by code point, a specification turned into a checker.
 * - sha256Hex of a text is sha256Hex of its generalized UTF-8 bytes. Oracle: the differential between the text path and
 *   the bytes path, the bytes written by the definition above.
 *
 * Inputs: a string of code units drawn by class (ASCII, any BMP unit, a surrogate unit, a supplementary character's
 * pair), so lone surrogates appear and adjacent ones also pair up, and well-formed text is drawn among them.
 *
 * Features: each code point's UTF-8 width (one to four bytes), a lone surrogate, and an empty text.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): sha256-replacement-char (a lone surrogate written as the platform
 * writes it, U+FFFD), sha256-length-pair (a surrogate pair counted as two three-byte units) and sha256-text-platform (a
 * text hashed as the platform's UTF-8).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { sha256Hex, utf8, utf8Length } from "#compiler/core/sha256.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const platform = new TextEncoder()

type Feature =
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
const generalized = (text: string): ReadonlyArray<number> =>
	Arr.flatMap(pointsOf(text), (cp) =>
		isSurrogate(cp)
			? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)]
			: [...platform.encode(String.fromCodePoint(cp))]
	)

/** The situation each code point of a text is, by its UTF-8 width or as a lone surrogate. */
const noteText = (text: string, c: Case<Feature>): void => {
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
const utf16: Gen<string> = map(
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

const steered = { cases: 200, sense: notesOnly }

describe("utf8", () => {
	it.effect(
		"writes any UTF-16 string as generalized UTF-8, a lone surrogate as its own three bytes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "generalized UTF-8, code point by code point, a lone surrogate as three bytes"
						},
						suite: "unit/core/utf8-generalized",
						draw: drawn(utf16),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a one-byte point",
								"a two-byte point",
								"a three-byte point",
								"a four-byte point",
								"a lone surrogate",
								"an empty text"
							],
							steered
						),
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(text, c) =>
						Effect.sync(() => {
							const expected = generalized(text)
							const written: ReadonlyArray<number> = [...utf8(text)]
							assert.deepEqual(written, expected)
							assert.equal(utf8Length(text), expected.length)
							noteText(text, c)
						})
				)
			)
	)
})

describe("sha256Hex", () => {
	it.effect("hashes a text as its generalized UTF-8 bytes", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "universal",
						name: "the text path against the bytes path over generalized UTF-8"
					},
					suite: "unit/core/sha256-text",
					draw: drawn(utf16),
					literal: Formatter.format,
					coverage: required<Feature>(["a lone surrogate", "a four-byte point"], steered),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(text, c) =>
					Effect.sync(() => {
						assert.equal(sha256Hex(text), sha256Hex(Uint8Array.from(generalized(text))))
						noteText(text, c)
					})
			)
		)
	)
})
