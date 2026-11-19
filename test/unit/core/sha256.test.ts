/**
 * The bytes a fingerprint hashes for a text (grizzle-text utf8.ts utf8, utf8Length) and the digest of a text (sha256Hex).
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
 */

import { utf8, utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { assert } from "#test/support/assert.ts"
import { type Feature, generalized, noteText, utf16 } from "#test/unit/core/sha256.fixtures.ts"

/** Utf8 writes any UTF-16 string as generalized UTF-8, a lone surrogate as its own three bytes. Its budget is its suite's before it was a property (test/unit/core/sha256.test.ts at 4ca3036a): 500 runs and 200 steered cases. */
export const utf8WritesAnyUTF16StringAsGeneralizedUTF8ALoneSurrogateAsItsOwnThreeBytes =
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
				const written: ReadonlyArray<number> = [...utf8(text)]
				assert.deepEqual(written, expected)
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
				original: "\ttext.isWellFormed() ? encoder.encode(text) : wtf8(text)",
				replacement: "\tencoder.encode(text)",
				why: "utf8 writes a lone surrogate as the platform writes it, U+FFFD; the generalized UTF-8 property fails."
			},
			{
				file: "packages/text/src/utf8.ts",
				original:
					"\t\t} else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(at + 1))) {",
				replacement:
					"\t\t} else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(at))) {",
				why: "utf8Length counts a surrogate pair as two three-byte units; the generalized UTF-8 property fails."
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
