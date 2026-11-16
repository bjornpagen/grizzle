/**
 * The one reader of UTF-8 bytes as text (packages/engine/src/core/utf8.ts), whole (utf8Text) and in chunks
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
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { utf8Chunks, utf8Text } from "#compiler/core/utf8.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const BYTE_ORDER_MARK = "\uFEFF"

/** The scalars a drawn text is made of: the byte order mark, one of each UTF-8 length, and U+FFFD itself. */
const palette = [BYTE_ORDER_MARK, "a", "é", "€", "😀", "\uFFFD"] as const

/**
 * A fault spliced into well-formed bytes, each no UTF-8 wherever it stands between two scalars (Unicode 3.9, table
 * 3-7): a continuation byte with no lead, the overlong two-byte form of U+0000, the three-byte form of a surrogate, a
 * byte no UTF-8 holds, and the first two bytes of a four-byte sequence, which no byte after them completes.
 */
type Fault =
	| "none"
	| "a lone continuation byte"
	| "an overlong form"
	| "an encoded surrogate"
	| "a byte no UTF-8 holds"
	| "a sequence the bytes end inside"

const faultBytes: { readonly [F in Exclude<Fault, "none">]: ReadonlyArray<number> } = {
	"a lone continuation byte": [0x80],
	"an overlong form": [0xc0, 0x80],
	"an encoded surrogate": [0xed, 0xa0, 0x80],
	"a byte no UTF-8 holds": [0xff],
	"a sequence the bytes end inside": [0xf0, 0x9f]
}

/** A case: the text's scalars, its fault and the scalar boundary it stands at, and where the bytes are cut. */
interface Utf8Case {
	readonly scalars: ReadonlyArray<string>
	readonly fault: Fault
	readonly at: number
	readonly cuts: ReadonlyArray<number>
}

const caseGen: Gen<Utf8Case> = (source) => ({
	scalars: source.draw(array(element(palette), { min: 0, max: 6 })),
	fault: source.draw(
		element<Fault>([
			"none",
			"a lone continuation byte",
			"an overlong form",
			"an encoded surrogate",
			"a byte no UTF-8 holds",
			"a sequence the bytes end inside"
		])
	),
	at: source.draw(int(0, 6)),
	cuts: source.draw(array(int(0, 24), { min: 0, max: 4 }))
})

type Utf8Feature =
	| "a text that begins with U+FEFF"
	| "a text holding U+FEFF after its start"
	| "bytes that are no UTF-8 refused"
	| "a sequence cut between chunks"
	| "an astral scalar"

const encoder = new TextEncoder()

/** The bytes of `scalars`, each its UTF-8, with `fault`'s bytes between scalar `at` and the one before it. */
const bytesOf = (
	scalars: ReadonlyArray<string>,
	fault: Fault,
	at: number
): ReadonlyArray<ReadonlyArray<number>> => {
	const parts = Arr.map(scalars, (s) => Arr.fromIterable(encoder.encode(s)))
	if (fault === "none") {
		return parts
	}
	const place = fault === "a sequence the bytes end inside" ? parts.length : at % (parts.length + 1)
	return [...parts.slice(0, place), faultBytes[fault], ...parts.slice(place)]
}

/** The bytes cut at `cuts`, each place within them once, in order. */
const chunksOf = (bytes: Uint8Array, cuts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
	const places = Arr.sort(
		Arr.dedupe(Arr.map(cuts, (cut) => cut % (bytes.length + 1))),
		Order.Number
	)
	const ends = [...places, bytes.length]
	return Arr.map(ends, (end, i) => bytes.subarray(i === 0 ? 0 : (ends[i - 1] ?? 0), end))
}

/** The text a chunked reading gives: every chunk's text and the end's, none from the first chunk refused on. */
const readInChunks = (chunks: ReadonlyArray<Uint8Array>): string | undefined => {
	const reader = utf8Chunks()
	const texts = Arr.map(chunks, (chunk) => Option.fromNullishOr(reader.chunk(chunk)))
	return Arr.every(texts, Option.isSome)
		? Option.getOrUndefined(
				Option.map(Option.fromNullishOr(reader.end()), (last) =>
					Arr.join([...Arr.getSomes(texts), last], "")
				)
			)
		: undefined
}

describe("the one reader of UTF-8 bytes as text", () => {
	it.effect(
		"reads well-formed bytes as exactly their text, a leading U+FEFF kept, refuses every fault, and reads chunks as it reads the whole",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/utf8",
						oracle: {
							kind: "specification",
							name: "the platform's UTF-8 encoder for the text's bytes, and faults no UTF-8 holds (Unicode 3.9, table 3-7)"
						},
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Utf8Feature>(
							[
								"a text that begins with U+FEFF",
								"a text holding U+FEFF after its start",
								"bytes that are no UTF-8 refused",
								"a sequence cut between chunks",
								"an astral scalar"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [
							{
								note: "a text after a byte order mark, which a TextDecoder's defaults read without the mark",
								sketch: { scalars: [BYTE_ORDER_MARK, "a"], fault: "none", at: 0, cuts: [] },
								draws: "",
								reaches: ["a text that begins with U+FEFF"]
							}
						],
						runs: 300,
						shrink: completeShrink,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
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
							assert.equal(
								utf8Text(bytes),
								expected,
								`the bytes of ${Formatter.format(k)} read whole`
							)
							assert.equal(
								readInChunks(chunks),
								expected,
								`the bytes of ${Formatter.format(k)} read in ${chunks.length} chunks`
							)
						})
				)
			)
	)
})
