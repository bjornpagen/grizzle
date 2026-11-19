/**
 * The one reader of UTF-8 bytes as text (packages/text/src/utf8.ts), whole (utf8Text) and in chunks
 * (utf8Chunks): the text the bytes spell, exactly as they arrived, and nothing for bytes that are no UTF-8.
 *
 * - Property: over drawn texts of a palette of scalars (U+FEFF among them, at the start or after it, an astral scalar,
 *   U+FFFD itself), their UTF-8 bytes read whole are the text, every character kept, a leading U+FEFF too; with one
 *   fault spliced in at a scalar boundary (a lone continuation byte, an overlong form, an encoded surrogate, a byte no
 *   UTF-8 holds, a sequence the bytes end inside) they are refused. Read in chunks cut at drawn places, inside a
 *   scalar's sequence among them, the answer is the whole reading's.
 * - Oracle: the platform's UTF-8 encoder, whose bytes are the text's by definition, and faults that no UTF-8 holds by
 *   the Unicode Standard's table of well-formed byte sequences (3.9, table 3-7), wherever they are spliced.
 *
 * Features: a text that begins with U+FEFF, a text holding U+FEFF after its start, bytes that are no UTF-8 refused,
 * a sequence cut between chunks, an astral scalar.
 */

import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	BYTE_ORDER_MARK,
	bytesOf,
	caseGen,
	chunksOf,
	readInChunks,
	type Utf8Feature
} from "#test/unit/core/utf8.fixtures.ts"

/** The one reader of UTF-8 bytes as text reads well-formed bytes as exactly their text, a leading U+FEFF kept, refuses every fault, and reads chunks as it reads the whole. Its budget is its suite's before it was a property (test/unit/core/utf8.test.ts at 4ca3036a): 300 runs and 40 steered cases. */
export const theOneReaderOfUTF8BytesAsTextReadsWellFormedBytesAsExactlyTheirTextALeadingUFEFFKeptRefusesEveryFaultAndReadsChunksAsItReadsTheWhole =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 300, steered: 40 },
		situations: [
			"a text that begins with U+FEFF",
			"a text holding U+FEFF after its start",
			"bytes that are no UTF-8 refused",
			"a sequence cut between chunks",
			"an astral scalar"
		] satisfies ReadonlyArray<Reached<Utf8Feature>>,
		check: (_, c: Case<Utf8Feature>) => (k) =>
			Effect.sync(() => {
				const text = Arr.join(k.scalars, "")
				if (k.scalars[0] === BYTE_ORDER_MARK) {
					c.note("a text that begins with U+FEFF")
				}
				if (k.scalars.slice(1).includes(BYTE_ORDER_MARK)) {
					c.note("a text holding U+FEFF after its start")
				}
				if (k.scalars.includes("😀")) {
					c.note("an astral scalar")
				}
				const parts = bytesOf(k.scalars, k.fault, k.at)
				const bytes = Uint8Array.from(Arr.flatten(parts))
				const chunks = chunksOf(bytes, k.cuts)
				/** The byte offsets where a part begins or the bytes end: a cut anywhere else is inside a sequence. */
				const boundaries = new Set(Arr.scan(parts, 0, (offset, part) => offset + part.length))
				const cutAt = Arr.scan(chunks, 0, (offset, chunk) => offset + chunk.length)
				if (Arr.some(cutAt, (offset) => !boundaries.has(offset))) {
					c.note("a sequence cut between chunks")
				}
				const expected = k.fault === "none" ? text : undefined
				if (expected === undefined) {
					c.note("bytes that are no UTF-8 refused")
				}
				const whole: string | undefined = utf8Text(bytes)
				assert.equal(whole, expected, `the bytes of ${Formatter.format(k)} read whole`)
				assert.equal(
					readInChunks(chunks),
					expected,
					`the bytes of ${Formatter.format(k)} read in ${chunks.length} chunks`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the platform's UTF-8 encoder for the text's bytes, and faults no UTF-8 holds (Unicode 3.9, table 3-7)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/core/utf8.test.ts#theOneReaderOfUTF8BytesAsTextReadsWellFormedBytesAsExactlyTheirTextALeadingUFEFFKeptRefusesEveryFaultAndReadsChunksAsItReadsTheWhole:-:2.0.1.0.0.0"
				),
				reason:
					"a text after a byte order mark, which a TextDecoder's defaults read without the mark",
				since: "2026-11-14"
			}
		],
		kills: [
			{
				file: "packages/text/src/utf8.ts",
				original:
					'const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })',
				replacement: 'const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true })',
				why: "The decoder strips a leading byte order mark, as a TextDecoder does by default, so a text that begins with U+FEFF reads without it."
			},
			{
				file: "packages/text/src/utf8.ts",
				original:
					'const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })',
				replacement:
					'const strict = (): TextDecoder => new TextDecoder("utf-8", { ignoreBOM: true })',
				why: "The decoder is not fatal, so bytes that are no UTF-8 read as text with U+FFFD in place of the fault."
			}
		]
	})
