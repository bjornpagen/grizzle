/**
 * The one encoder of a text's bytes (grizzle-text utf8.ts writeUtf8, utf8 and utf8Length) and the digest of a text
 * (sha256Hex).
 *
 * - Any UTF-16 string: writeUtf8 writes generalized UTF-8 (WTF-8) in place, from any offset of a larger array, each code
 *   point as the platform iterates the string, a lone surrogate as its own three bytes 0xE0 | cp >> 12,
 *   0x80 | (cp >> 6) & 0x3F, 0x80 | cp & 0x3F, where the platform's TextEncoder writes U+FFFD, and every other code point
 *   as TextEncoder writes it, so well-formed text is the platform's UTF-8; it touches no byte outside them and answers
 *   the offset past them; utf8 is those bytes alone, and utf8Length counts them. Oracle: that definition, code point by
 *   code point, a specification turned into a checker, TextEncoder's U+FFFD for a lone surrogate checked beside it.
 * - sha256Hex of a text is sha256Hex of its generalized UTF-8 bytes. Oracle: the differential between the text path and
 *   the bytes path, the bytes written by the definition above.
 *
 * Inputs: a string of code units drawn by class (ASCII, any BMP unit, a surrogate unit, a supplementary character's
 * pair), so lone surrogates appear and adjacent ones also pair up, and well-formed text is drawn among them.
 *
 * Features: each code point's UTF-8 width (one to four bytes), a lone surrogate, and an empty text.
 */

import { utf8, utf8Length, writeUtf8 } from "@bjornpagen/grizzle-text/utf8"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { assert } from "#test/support/assert.ts"
import {
	type Feature,
	generalized,
	noteText,
	platformLoneSurrogates,
	utf16
} from "#test/unit/core/sha256.fixtures.ts"

/** The one encoder writes any UTF-16 string in place as generalized UTF-8, a lone surrogate as its own three bytes. Its budget is its suite's before it was a property (test/unit/core/sha256.test.ts at 4ca3036a): 500 runs and 200 steered cases. */
export const theOneEncoderWritesAnyUTF16StringInPlaceAsGeneralizedUTF8ALoneSurrogateAsItsOwnThreeBytes =
	property.explore(utf16, {
		needs: {},
		budget: { runs: 500, steered: 200 },
		situations: [
			"a one-byte point",
			"a two-byte point",
			"a three-byte point",
			"a four-byte point",
			"a lone surrogate",
			"an empty text"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (text) =>
			Effect.sync(() => {
				const expected = generalized(text)
				assert.deepEqual(
					platformLoneSurrogates(text),
					[],
					"TextEncoder writes each lone surrogate as U+FFFD, which generalized UTF-8 does not"
				)
				/** An offset of 0, 1 or 2 into an array with a byte of 0xAA on each side of the text's bytes. */
				const at = text.length % 3
				const out = new Uint8Array(at + expected.length + 1).fill(0xaa)
				const past = writeUtf8(out, at, text)
				assert.equal(past, at + expected.length, "writeUtf8 answers the offset past its bytes")
				const inPlace: ReadonlyArray<number> = [...out.subarray(at, past)]
				assert.deepEqual(inPlace, expected, "writeUtf8's bytes in place")
				assert.deepEqual(
					[...out.subarray(0, at), ...out.subarray(past)],
					Array.from({ length: at + 1 }, () => 0xaa),
					"writeUtf8 touches no byte outside its own"
				)
				const alone: ReadonlyArray<number> = [...utf8(text)]
				assert.deepEqual(alone, expected, "utf8's bytes")
				assert.equal(utf8Length(text), expected.length)
				noteText(text, c)
			}),
		oracle: {
			kind: "specification",
			name: "generalized UTF-8, code point by code point, a lone surrogate as three bytes"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/utf8.ts",
				original: "\t\t\t: isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(at + 1))",
				replacement: "\t\t\t: isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(at))",
				why: "The one width rule reads a surrogate pair as two three-byte units, so utf8Length counts and writeUtf8 writes each half as a lone surrogate; the generalized UTF-8 property fails."
			},
			{
				file: "packages/text/src/utf8.ts",
				original:
					"\t\t\t\tconst point = ((unit - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00) + 0x10000",
				replacement:
					"\t\t\t\tconst point = ((unit - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00)",
				why: "writeUtf8 writes a supplementary code point's four bytes without its 0x10000 offset; the generalized UTF-8 property fails."
			},
			{
				file: "packages/text/src/utf8.ts",
				original: "\tlet to = at\n",
				replacement: "\tlet to = 0\n",
				why: "writeUtf8 writes from the array's start, whatever offset it is given, over the bytes before it; the in-place property fails."
			}
		]
	})

/** Sha256Hex hashes a text as its generalized UTF-8 bytes. Its budget is its suite's before it was a property (test/unit/core/sha256.test.ts at 4ca3036a): 300 runs and 200 steered cases. */
export const sha256HexHashesATextAsItsGeneralizedUTF8Bytes = property.explore(utf16, {
	needs: {},
	budget: { runs: 300, steered: 200 },
	situations: ["a lone surrogate", "a four-byte point"] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, c: Case<Feature>) => (text) =>
		Effect.sync(() => {
			assert.equal(sha256Hex(text), sha256Hex(Uint8Array.from(generalized(text))))
			noteText(text, c)
		}),
	oracle: {
		kind: "universal",
		name: "the text path against the bytes path over generalized UTF-8"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/sha256.ts",
			original: '\t\t.update(typeof input === "string" ? utf8(input) : input)',
			replacement: "\t\t.update(input)",
			why: "sha256Hex hashes a text as the platform's UTF-8; the digest's differential property fails."
		}
	]
})
