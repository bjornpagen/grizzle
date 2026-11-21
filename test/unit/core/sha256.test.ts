/**
 * The one encoder of a well-formed text's bytes (grizzle-text utf8.ts writeUtf8, utf8 and utf8Length) and the digest of
 * a text (sha256Hex), each typed over grizzle-text's WellFormedText, which no lone surrogate is.
 *
 * - Any well-formed text: writeUtf8 writes its UTF-8 in place, from any offset of a larger array, exactly as the
 *   platform's TextEncoder writes it, touches no byte outside them and answers the offset past them; utf8 is those
 *   bytes alone, and utf8Length counts them. Oracle: the platform's encoder, an implementation of its own.
 * - sha256Hex of a text is sha256Hex of its UTF-8 bytes. Oracle: the differential between the text path and the bytes
 *   path, the bytes the platform's encoder writes.
 *
 * Inputs: a text of scalars drawn by UTF-8 width (ASCII, two bytes, three bytes on either side of the surrogates, a
 * supplementary character's pair), through the brand's one door, isWellFormedText.
 *
 * Features: each code point's UTF-8 width (one to four bytes), and an empty text.
 */

import { utf8, utf8Length, writeUtf8 } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Sha256Messages, sha256Hex } from "#compiler/core/sha256.ts"
import {
	type Feature,
	type MessagesFeature,
	messagesGen,
	noteText,
	platformBytes,
	wellFormedTexts
} from "#test/unit/core/sha256.fixtures.ts"

/** The one encoder writes a well-formed text's UTF-8 in place, the platform's bytes of it. Its budget is its suite's before it was a property (test/unit/core/sha256.test.ts at 4ca3036a): 500 runs and 200 steered cases. */
export const theOneEncoderWritesAWellFormedTextsUTF8InPlaceThePlatformsBytesOfIt = property.explore(
	wellFormedTexts,
	{
		needs: {},
		budget: { runs: 500, steered: 200 },
		situations: [
			"a one-byte point",
			"a two-byte point",
			"a three-byte point",
			"a four-byte point",
			"an empty text"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (text) =>
			Effect.sync(() => {
				const expected = platformBytes(text)
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
			kind: "second-implementation",
			name: "the platform's UTF-8 encoder, TextEncoder"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/utf8.ts",
				original: "\t\t\t: isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(at + 1))",
				replacement: "\t\t\t: isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(at))",
				why: "The one width rule reads a surrogate pair as two three-byte units, so utf8Length counts and writeUtf8 writes each half as three bytes; the platform's bytes differ."
			},
			{
				file: "packages/text/src/utf8.ts",
				original:
					"\t\t\tconst point = ((unit - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00) + 0x10000",
				replacement:
					"\t\t\tconst point = ((unit - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00)",
				why: "writeUtf8 writes a supplementary code point's four bytes without its 0x10000 offset; the platform's bytes differ."
			},
			{
				file: "packages/text/src/utf8.ts",
				original: "\tlet to = at\n",
				replacement: "\tlet to = 0\n",
				why: "writeUtf8 writes from the array's start, whatever offset it is given, over the bytes before it; the in-place property fails."
			}
		]
	}
)

/** Sha256Hex hashes a text as its UTF-8 bytes. Its budget is its suite's before it was a property (test/unit/core/sha256.test.ts at 4ca3036a): 300 runs and 200 steered cases. */
export const sha256HexHashesATextAsItsUTF8Bytes = property.explore(wellFormedTexts, {
	needs: {},
	budget: { runs: 300, steered: 200 },
	situations: ["a two-byte point", "a four-byte point"] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, c: Case<Feature>) => (text) =>
		Effect.sync(() => {
			assert.equal(sha256Hex(text), sha256Hex(Uint8Array.from(platformBytes(text))))
			noteText(text, c)
		}),
	oracle: {
		kind: "universal",
		name: "the text path against the bytes path over the platform's UTF-8"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/sha256.ts",
			original: '\t\t.update(typeof input === "string" ? utf8(input) : input)',
			replacement: '\t\t.update(typeof input === "string" ? utf8(input).subarray(1) : input)',
			why: "sha256Hex hashes a text's bytes past its first; the digest's differential property fails."
		}
	]
})

/** SHA-256 messages written one after another into one writer are each the digest of their own bytes, and none is held whole: at most a chunk, or the longest piece written, at once. */
export const sha256MessagesWrittenOneAfterAnotherIntoOneWriterAreEachTheDigestOfTheirOwnBytesAndNoneIsHeldWhole =
	property.explore(messagesGen, {
		needs: {},
		situations: [
			"a message longer than its chunk",
			"messages one after another",
			"an empty message"
		] satisfies ReadonlyArray<Reached<MessagesFeature>>,
		check: (_, c: Case<MessagesFeature>) => (k) =>
			Effect.sync(() => {
				const messages = new Sha256Messages(k.chunk)
				for (const pieces of k.messages) {
					for (const piece of pieces) {
						messages.out.text(piece)
					}
					const bytes = Uint8Array.from(Arr.flatMap(pieces, platformBytes))
					assert.equal(messages.hex(), sha256Hex(bytes), "each message's digest is its own bytes'")
					if (bytes.length === 0) {
						c.note("an empty message")
					}
					if (bytes.length > k.chunk) {
						c.note("a message longer than its chunk")
					}
				}
				if (k.messages.length > 1) {
					c.note("messages one after another")
				}
				const longest = Arr.reduce(
					Arr.flatMap(k.messages, (m) => Arr.map(m, (p) => 3 * p.length)),
					0,
					(a, b) => Math.max(a, b)
				)
				assert.ok(
					messages.out.capacity <= Math.max(k.chunk, longest),
					`the writer holds ${messages.out.capacity} bytes at most, its chunk ${k.chunk} or its longest piece ${longest}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "sha256Hex of the platform's UTF-8 of each message, whole: the bytes path, which no message writer reaches"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/sha256.ts",
				original:
					'\t\tthis.out = new Utf8Writer({\n\t\t\tkind: "drain",\n\t\t\tchunk,\n\t\t\tinto: (bytes) => this.#current().update(bytes)\n\t\t})',
				replacement: '\t\tthis.out = new Utf8Writer({ kind: "grow" })',
				why: "Every message is held whole and hashed at its end, as a digest's text was: the writer holds a message longer than its chunk and its longest piece."
			},
			{
				file: "packages/engine/src/core/sha256.ts",
				original: '\t\tthis.#hash = undefined\n\t\treturn hash.digest("hex")',
				replacement: '\t\treturn hash.digest("hex")',
				why: "A message's hash goes on into the next, so the second message's digest is of both; the digests differ."
			}
		]
	})
