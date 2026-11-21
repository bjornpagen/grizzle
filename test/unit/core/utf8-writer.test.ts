/**
 * The UTF-8 writer (grizzle-text utf8.ts Utf8Writer): the one writer of a canonical text's and a digest's bytes, each
 * piece written in place once, with no string built.
 *
 * - Any pieces, in any order: a string's JSON literal, a number's JSON text, a well-formed text, ASCII punctuation. The
 *   bytes it writes, drained and held, are the platform's UTF-8 of what JSON.stringify and the texts spell, and the
 *   code units it counts are that text's length. A drained writer holds at most its chunk or the piece it reserved
 *   most for, whatever all it writes.
 * - Oracle: JSON.stringify (grizzle-text jsonText) for every string and number, lone surrogates among the strings and
 *   NaN among the numbers, and the platform's UTF-8 encoder, TextEncoder, for the bytes: a second implementation of
 *   both.
 *
 * Features: each kind of escape a JSON string literal holds, each UTF-8 width, each kind of number JSON writes, a text,
 * a drained writer, and a piece longer than its chunk.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	expectedText,
	featuresOf,
	platformBytes,
	reservedBytes,
	type WriterFeature,
	writerGen,
	written
} from "#test/unit/core/utf8-writer.fixtures.ts"

/** The UTF-8 writer writes JSON.stringify's text of every string and number and every well-formed text as its UTF-8, each byte once, a drained writer holding at most a chunk or its longest piece. */
export const theUTF8WriterWritesJSONStringifysTextOfEveryStringAndNumberAndEveryWellFormedTextAsItsUTF8ADrainedWriterHoldingAtMostAChunkOrItsLongestPiece =
	property.explore(writerGen, {
		needs: {},
		situations: [
			"a short escape",
			"a control's \\u escape",
			"a lone surrogate escaped",
			"a surrogate pair",
			"a two-byte point",
			"a three-byte point",
			"a safe integer",
			"a negative integer",
			"negative zero",
			"a number past the safe integers",
			"a fraction",
			"a number JSON writes as null",
			"a text",
			"drained",
			"a piece longer than the chunk"
		] satisfies ReadonlyArray<Reached<WriterFeature>>,
		check: (_, c: Case<WriterFeature>) => (k) =>
			Effect.sync(() => {
				const { out, drained } = written(k)
				const text = Arr.join(Arr.map(k.pieces, expectedText), "")
				const bytes: ReadonlyArray<number> = [...drained, ...out.held()]
				assert.deepEqual(bytes, platformBytes(text), "the bytes written are the text's UTF-8")
				assert.equal(out.units, text.length, "the code units counted are the text's")
				assert.equal(out.length, bytes.length, "the bytes counted are the bytes written")
				for (const p of k.pieces) {
					featuresOf(p, (f) => c.note(f))
				}
				if (k.chunk === "grow") {
					return
				}
				c.note("drained")
				const longest = Arr.reduce(Arr.map(k.pieces, reservedBytes), 0, (a, b) => Math.max(a, b))
				if (longest > k.chunk) {
					c.note("a piece longer than the chunk")
				}
				assert.ok(
					out.capacity <= Math.max(k.chunk, longest),
					`a drained writer holds ${out.capacity} bytes at most, its chunk ${k.chunk} or its longest piece ${longest}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "JSON.stringify for the text of each string and number, TextEncoder for its bytes"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/utf8.ts",
				original: `\t\`\\\\u\${unit.toString(16).padStart(unicodeEscapeDigits, "0")}\``,
				replacement: `\t\`\\\\u\${unit.toString(16).toUpperCase().padStart(unicodeEscapeDigits, "0")}\``,
				why: "A \\u escape's hex digits are written uppercase, where JSON.stringify writes them lowercase: a control's or a lone surrogate's escape differs."
			},
			{
				file: "packages/text/src/utf8.ts",
				original: "\t\t\tif (width === 3 && unit >= 0xd800 && unit <= 0xdfff) {",
				replacement: "\t\t\tif (width === 3 && unit >= 0xd800 && unit <= 0xdbff) {",
				why: "A lone low surrogate is written as its three-byte sequence, where JSON.stringify escapes it: the bytes differ."
			},
			{
				file: "packages/text/src/utf8.ts",
				original:
					"\t\t\t\tescaped += escape.length - 1\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\tconst width",
				replacement: "\t\t\t\tescaped += 1\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\tconst width",
				why: "A control's \\u escape counts two code units, where it is six: the units counted are not the text's length."
			},
			{
				file: "packages/text/src/utf8.ts",
				original:
					"const asciiEscaped = Uint8Array.from(asciiEscapes, (escape) => (escape === undefined ? 0 : 1))",
				replacement: "const asciiEscaped = new Uint8Array(asciiEscapes.length)",
				why: "No ASCII unit is escaped: a quotation mark, a reverse solidus or a control is written as itself, and the literal is no longer JSON.stringify's."
			},
			{
				file: "packages/text/src/utf8.ts",
				original: "\t\t\tout[to] = 0x30 + digit\n",
				replacement: "\t\t\tout[to] = 0x31 + digit\n",
				why: "A safe integer's digits are written one past each: the bytes differ."
			},
			{
				file: "packages/text/src/utf8.ts",
				original:
					'\t\tif (overflow.kind === "drain" && this.#at > 0 && this.#at + bytes > overflow.chunk) {',
				replacement: '\t\tif (overflow.kind === "drain" && this.#at > 0 && false) {',
				why: "A drained writer never drains, its buffer grown to hold all it writes: the bytes it holds pass its chunk and its longest piece."
			}
		]
	})
