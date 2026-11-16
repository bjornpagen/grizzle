/** What the properties of utf8.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { utf8Chunks } from "#compiler/core/utf8.ts"

export const BYTE_ORDER_MARK = "\uFEFF"

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

export const caseGen: Gen<Utf8Case> = (source) => ({
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

export type Utf8Feature =
	| "a text that begins with U+FEFF"
	| "a text holding U+FEFF after its start"
	| "bytes that are no UTF-8 refused"
	| "a sequence cut between chunks"
	| "an astral scalar"

const encoder = new TextEncoder()

/** The bytes of `scalars`, each its UTF-8, with `fault`'s bytes between scalar `at` and the one before it. */
export const bytesOf = (
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
export const chunksOf = (
	bytes: Uint8Array,
	cuts: ReadonlyArray<number>
): ReadonlyArray<Uint8Array> => {
	const places = Arr.sort(
		Arr.dedupe(Arr.map(cuts, (cut) => cut % (bytes.length + 1))),
		Order.Number
	)
	const ends = [...places, bytes.length]
	return Arr.map(ends, (end, i) => bytes.subarray(i === 0 ? 0 : (ends[i - 1] ?? 0), end))
}

/** The text a chunked reading gives: every chunk's text and the end's, none from the first chunk refused on. */
export const readInChunks = (chunks: ReadonlyArray<Uint8Array>): string | undefined => {
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
