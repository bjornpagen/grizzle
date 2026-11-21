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
 */

import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { textArray } from "#compiler/codec/bytea.ts"
import { readArrayBinary } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	endsTwoByte,
	holdsTwoByte,
	type TextFeature,
	texts as textsSpace,
	twoByteRunThenAnother
} from "#test/unit/codec/text-array.fixtures.ts"

/**
 * A text column's binary array holds each text as its UTF-8 bytes, which a strict decoder reads back as the text.
 *
 * Budget: its suite's count before the conversion (unit/codec/text-array: 300 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const aTextColumnsBinaryArrayHoldsEachTextAsItsUTF8BytesWhichAStrictDecoderReadsBackAsTheText =
	property.explore(
		aimed(textsSpace, [
			[
				"a text of 53 units or more that holds U+0400 to U+07FF and ends in another scalar",
				twoByteRunThenAnother
			]
		]),
		{
			needs: {},
			situations: [
				"no text",
				"the empty text",
				"a long text",
				"an astral scalar",
				"a text of 53 units or more that ends in U+0400 to U+07FF",
				"a text of 53 units or more that holds U+0400 to U+07FF and ends in another scalar"
			] satisfies ReadonlyArray<Reached<TextFeature>>,
			check: (_, c: Case<TextFeature>) => (texts) =>
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
						const readBack: string | null | undefined = bytes === null ? null : utf8Text(bytes)
						assert.equal(
							readBack,
							defined(texts[i], "each text written"),
							`element ${i} reads back as its text`
						)
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "the array binary format read back, each element decoded as strict UTF-8"
			},
			budget: { runs: 300, steered: 0 },
			kept: [
				{
					token: ReplayToken(
						"test/unit/codec/text-array.test.ts#aTextColumnsBinaryArrayHoldsEachTextAsItsUTF8BytesWhichAStrictDecoderReadsBackAsTheText:20.5:76.0.2o"
					),
					reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 258 then 'a'",
					since: "2026-11-09"
				},
				{
					token: ReplayToken(
						"test/unit/codec/text-array.test.ts#aTextColumnsBinaryArrayHoldsEachTextAsItsUTF8BytesWhichAStrictDecoderReadsBackAsTheText:20.5:7b.0.2o"
					),
					reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 263 then 'a'",
					since: "2026-11-09"
				},
				{
					token: ReplayToken(
						"test/unit/codec/text-array.test.ts#aTextColumnsBinaryArrayHoldsEachTextAsItsUTF8BytesWhichAStrictDecoderReadsBackAsTheText:20.5:8t.0.2o"
					),
					reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 317 then 'a'",
					since: "2026-11-09"
				},
				{
					token: ReplayToken(
						"test/unit/codec/text-array.test.ts#aTextColumnsBinaryArrayHoldsEachTextAsItsUTF8BytesWhichAStrictDecoderReadsBackAsTheText:20.5:qe.0.2o"
					),
					reason: "nodejs/node#65994 on Node v26.13.0: U+0400 x 950 then 'a'",
					since: "2026-11-09"
				},
				{
					token: ReplayToken(
						"test/unit/codec/text-array.test.ts#aTextColumnsBinaryArrayHoldsEachTextAsItsUTF8BytesWhichAStrictDecoderReadsBackAsTheText:-:1.3.1h.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2"
					),
					reason: "nodejs/node#65994 on Node v26.13.0: 'a' x 52 then U+0400",
					since: "2026-11-09"
				},
				{
					token: ReplayToken(
						"test/unit/codec/text-array.test.ts#aTextColumnsBinaryArrayHoldsEachTextAsItsUTF8BytesWhichAStrictDecoderReadsBackAsTheText:-:1.3.8m.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2"
					),
					reason: "nodejs/node#65994 on Node v26.13.0: 'a' x 309 then U+0400",
					since: "2026-11-09"
				}
			],
			kills: [
				{
					file: "packages/engine/src/codec/bytea.ts",
					original: '\t\twriteUtf8(out, at, wellFormed(defined(texts[i], "each text counted")))',
					replacement:
						'\t\tnew TextEncoder().encodeInto(defined(texts[i], "each text counted"), out.subarray(at, at + defined(lengths[i], "each length counted")))',
					why: "Each element is written by TextEncoder.encodeInto into a destination of exactly its length, which Node underfills."
				}
			]
		}
	)
