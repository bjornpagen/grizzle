/**
 * generate writes each file's text as its chunks (grizzle-text TextChunks), each UTF-8 encoded alone and written before
 * the next is encoded (cli/files.ts writeText), and the text is never joined into one string: no chunk is longer than a
 * chunk's bound, none ends between the two halves of a surrogate pair, which encoded apart are two U+FFFD, never the
 * character, and the file's bytes are exactly the whole text's UTF-8.
 *
 * Property, per case: a text drawn as pieces, each a run of one character from ASCII, the two-byte, three-byte or astral
 * planes, long enough that the text spans several chunks and a bound falls inside a pair, written piece by piece into a
 * ChunkWriter, and the same text built whole and cut (chunksOf): each chunk is nonempty, well-formed, at most chunkUnits
 * code units, and every chunk but the last holds a full chunk, or one unit less where the bound would part a pair; the
 * chunks joined are the text; their encodings together are the text's UTF-8; and the chunks written by writeText to a
 * file read back as those bytes. Oracle: specification, the text's UTF-8 as TextEncoder writes it whole. Kills: a cut
 * wherever the bound falls, between a pair's halves among them; a writer that never cuts, which joins the whole text
 * into one string, as a rope's first read flattens it.
 *
 * Features: a cut that would split a surrogate pair; a piece longer than a chunk; a text of several chunks.
 */

import {
	chunkBytes,
	chunksOf,
	chunkUnits,
	ChunkWriter,
	type TextChunks
} from "@bjornpagen/grizzle-text/chunks"
import { assert } from "@bjornpagen/testing/assert"
import { array, codePoint, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { writeText } from "#cli/files.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { joined } from "#test/support/chunked.ts"

/** A piece of a drawn text: one character repeated. */
interface Run {
	readonly character: string
	readonly count: number
}

const runGen: Gen<Run> = (source) => ({
	character: source.draw(
		oneOf([
			codePoint(0x20, 0x7e),
			codePoint(0x80, 0x7ff),
			codePoint(0x800, 0xd7ff),
			codePoint(0x10000, 0x10ffff)
		])
	),
	count: source.draw(oneOf([int(1, 8), int(chunkUnits / 4, chunkUnits + 7)]))
})

const piecesGen: Gen<ReadonlyArray<Run>> = array(runGen, { min: 0, max: 6 })

type Situation =
	| "a cut that would split a surrogate pair"
	| "a piece longer than a chunk"
	| "a text of several chunks"

const utf8 = new TextEncoder()

/** The bytes of `parts`, one after another. */
const concatenated = (parts: Iterable<Uint8Array>): Uint8Array => {
	const all = [...parts]
	const out = new Uint8Array(Arr.reduce(all, 0, (n, p) => n + p.length))
	let at = 0
	for (const p of all) {
		out.set(p, at)
		at += p.length
	}
	return out
}

/** A text's chunks as the bound wants them, joined to the text, encoded to its UTF-8; the situations they meet. */
const holdsChunks = (
	chunks: TextChunks,
	text: string,
	whole: Uint8Array,
	note: (situation: Situation) => void
): void => {
	for (const [i, chunk] of chunks.entries()) {
		assert.ok(chunk.length > 0, `chunk ${i} holds a unit`)
		assert.ok(chunk.length <= chunkUnits, `chunk ${i} holds at most a chunk: ${chunk.length}`)
		assert.ok(chunk.isWellFormed(), `chunk ${i} is well-formed`)
		if (i < chunks.length - 1) {
			assert.ok(
				chunk.length >= chunkUnits - 1,
				`chunk ${i}, not the last, is full: ${chunk.length}`
			)
			if (chunk.length === chunkUnits - 1) {
				note("a cut that would split a surrogate pair")
			}
		}
	}
	if (chunks.length > 1) {
		note("a text of several chunks")
	}
	assert.equal(joined(chunks), text, "the chunks joined are the text")
	assert.deepEqual(
		concatenated(chunkBytes(chunks)),
		whole,
		"the chunks' encodings together are the text's UTF-8"
	)
}

/** A text written as its chunks is its UTF-8, chunk by chunk and on disk. */
export const aTextWrittenAsItsChunksIsItsUtf8ChunkByChunkAndOnDisk = property.explore(piecesGen, {
	needs: {},
	situations: [
		"a cut that would split a surrogate pair",
		"a piece longer than a chunk",
		"a text of several chunks"
	],
	check: (_, c: Case<Situation>) => (runs) =>
		Effect.gen(function* () {
			const writer = new ChunkWriter()
			const pieces = Arr.map(runs, (run) => wellFormed(Str.repeat(run.count)(run.character)))
			for (const piece of pieces) {
				if (piece.length > chunkUnits) {
					c.note("a piece longer than a chunk")
				}
				writer.append(piece)
			}
			const text = Arr.join(pieces, "")
			assert.equal(writer.length, text.length, "the writer counts the text's units")
			const written = writer.chunks()
			const whole = utf8.encode(text)
			holdsChunks(written, text, whole, c.note)
			holdsChunks(chunksOf(wellFormed(text)), text, whole, c.note)
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const read = yield* Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-write-text-" })
					const file = path.join(directory, "text")
					yield* writeText(file, written)
					return yield* fs.readFile(file)
				})
			)
			assert.deepEqual(new Uint8Array(read), whole, "the file holds the text's UTF-8")
		}),
	oracle: { kind: "specification", name: "the text's UTF-8 as TextEncoder writes it whole" },
	kept: [],
	kills: [
		{
			file: "packages/text/src/chunks.ts",
			original: "\tat < text.length && isHighSurrogate(text.charCodeAt(at - 1)) ? at - 1 : at",
			replacement: "\tat < 0 && isHighSurrogate(text.charCodeAt(at - 1)) ? at - 1 : at",
			why: "A cut falls wherever the bound does, between a surrogate pair's halves among them, so a chunk ends in a lone half: no chunk of it is well-formed text, and its halves encode apart as U+FFFD."
		},
		{
			file: "packages/text/src/chunks.ts",
			original: "\t\twhile (piece.length - at > chunkUnits - this.#openUnits) {",
			replacement: "\t\twhile (piece.length - at > Number.POSITIVE_INFINITY) {",
			why: "The writer never cuts: every piece joins one chunk, sealed as the whole text joined into one string, the one allocation a rope's first read makes and edullm's qti generate could not."
		}
	]
})
