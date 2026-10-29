import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import { array, codePoint, int, map, oneOf, string } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import { sha256Hex, utf8, utf8Length } from "#compiler/core/sha256.ts"
import { assert } from "#test/support/assert.ts"

const platform = new TextEncoder()

/**
 * The bytes of `text` by the definition of the encoding fingerprints hash (core/sha256.ts utf8), one code point at a
 * time as the platform iterates a string: a surrogate code point is 0xE0 | cp >> 12, 0x80 | (cp >> 6) & 0x3F,
 * 0x80 | cp & 0x3F; every other code point is the platform encoder's. That is the platform's UTF-8 on well-formed text
 * and generalized UTF-8 (WTF-8) on any UTF-16 string, a lone surrogate written as its own three-byte sequence rather
 * than replaced by U+FFFD, so two different strings never hash as the same bytes.
 */
const generalized = (text: string): ReadonlyArray<number> =>
	Arr.flatMap(Arr.fromIterable(text), (point) => {
		const cp = Option.getOrThrowWith(Str.codePointAt(point, 0), () => new Error("a code point"))
		return cp >= 0xd800 && cp <= 0xdfff
			? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)]
			: [...platform.encode(point)]
	})

/**
 * Arbitrary UTF-16: any code unit (lone surrogates included, so adjacent ones may also pair up), weighted toward
 * ASCII, surrogates, and well-formed supplementary pairs, so it reaches strings a string of code points never does.
 */
const utf16 = map(
	array(
		oneOf([
			map(int(0, 0x7f), (c) => String.fromCharCode(c)),
			map(int(0, 0xffff), (c) => String.fromCharCode(c)),
			map(int(0xd800, 0xdfff), (c) => String.fromCharCode(c)),
			map(int(0x10000, 0x10ffff), (c) => String.fromCodePoint(c))
		]),
		{ min: 0, max: 10 }
	),
	(units) => Arr.join(units, "")
)

describe("utf8", () => {
	it.effect(
		"equals the platform encoder on well-formed text, supplementary planes included",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/utf8-well-formed",
						draw: drawn(
							string(
								oneOf([
									codePoint(0x20, 0x7e),
									codePoint(0xa0, 0xd7_ff),
									codePoint(0xe0_00, 0x10_ffff)
								]),
								{ min: 0, max: 10 }
							)
						),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							const expected = [...platform.encode(text)]
							assert.deepEqual([...utf8(text)], expected)
							assert.equal(utf8Length(text), expected.length)
						})
				)
			)
	)

	it.effect(
		"writes any UTF-16 string as generalized UTF-8, a lone surrogate as its own three bytes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/utf8-generalized",
						draw: drawn(utf16),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							const expected = generalized(text)
							const written: ReadonlyArray<number> = [...utf8(text)]
							assert.deepEqual(written, expected)
							assert.equal(utf8Length(text), expected.length)
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
					suite: "unit/core/sha256-text",
					draw: drawn(utf16),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				(text) =>
					Effect.sync(() => {
						assert.equal(sha256Hex(text), sha256Hex(Uint8Array.from(generalized(text))))
					})
			)
		)
	)
})
