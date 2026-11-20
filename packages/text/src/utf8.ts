/**
 * UTF-8, the one codec of text and its bytes for grizzle and every program beside it: a well-formed text's bytes
 * (`WellFormedText`, which no lone surrogate is, so its UTF-8 is defined) and a text's byte length, and the one reader
 * of bytes as text (oxlint.config.ts refuses a TextDecoder anywhere else), which spells exactly the text the bytes hold. A
 * malformed sequence is refused, never replaced by U+FFFD (`fatal`), and a byte order mark is a character of the text,
 * never stripped (`ignoreBOM`). U+FEFF is a scalar like any other, which a stored text, a JSON body or a token may begin
 * with, and a TextDecoder's defaults would drop it from the start of every decode, so the text read would be another
 * value than the one the bytes hold. Its one encoder, `writeUtf8`, writes a text's bytes in place, where its caller
 * counted them (`utf8Length`, by the same rule), so a text written into a larger array is copied from nowhere. It
 * imports nothing and runs wherever JavaScript does, a browser included.
 */

declare const wellFormedBrand: unique symbol

/**
 * A text of Unicode scalar values alone, no lone surrogate: a text UTF-8 writes (`writeUtf8`) and every text a decode
 * of UTF-8 reads (`utf8Text`). Minted only here: by `isWellFormedText`, the one check of a text's form, which a boundary
 * that admits a text, or holds one TypeScript cannot prove, reads; and, unchecked, where the making of a text is its
 * proof: the strict decoder's every text, JSON.stringify's (`jsonText`) and a join of well-formed texts
 * (`joinWellFormed`).
 */
export type WellFormedText = string & { readonly [wellFormedBrand]: true }

/** Whether a text is well-formed (`WellFormedText`): it holds no lone surrogate. */
export const isWellFormedText = (text: string): text is WellFormedText => text.isWellFormed()

/** A text well-formed by how it was made (`WellFormedText`): read by the strict decoder, written by JSON.stringify, or
 * joined of well-formed texts. Unchecked: each of its callers is the proof. */
const proved: (text: string) => asserts text is WellFormedText = () => undefined

/**
 * Well-formed texts as one, in order: well-formed too, since no part ends with a high surrogate or begins with a low one,
 * so no seam pairs or parts a surrogate (`WellFormedText`). Unchecked: the parts are the proof.
 */
export const joinWellFormed = (...parts: ReadonlyArray<WellFormedText>): WellFormedText => {
	const text = parts.join("")
	proved(text)
	return text
}

/**
 * A well-formed text written piece by piece, each piece well-formed, so the whole is (`joinWellFormed`): appended in
 * place, never joined anew at each piece. Unchecked: the pieces are the proof.
 */
export class WellFormedWriter {
	#text = ""

	/** How many UTF-16 code units the text holds so far. */
	get length(): number {
		return this.#text.length
	}

	append(piece: WellFormedText): void {
		this.#text += piece
	}

	/** The text written so far. */
	text(): WellFormedText {
		const text = this.#text
		proved(text)
		return text
	}
}

/**
 * A JSON value (RFC 8259): what JSON text spells, and nothing it cannot. An object member that may be absent is
 * optional, never `undefined`, so a value of this type has exactly one text.
 */
export type Json =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<Json>
	| { readonly [member: string]: Json }

/**
 * The JSON text of a value, JSON.stringify's, compact, each object's members in the value's own order: the one door
 * every JSON text grizzle and its packages write from a value of their own goes through. Well-formed, since
 * JSON.stringify writes a lone surrogate as its \u escape (ECMA-262 QuoteJSONString, well-formed JSON.stringify), and
 * every other text it writes as it is. Unchecked: JSON.stringify is the proof.
 */
export const jsonText = (value: Json): WellFormedText => {
	const text = JSON.stringify(value)
	proved(text)
	return text
}

/** Whether a code unit is a high surrogate, the first of a pair. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff

/** Whether a code unit is a low surrogate, the second of a pair; NaN, past a text's end, is none. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** How many bytes UTF-8 writes one code point in: a code unit's sequence, or a surrogate pair's. */
type Width = 1 | 2 | 3 | 4

/**
 * How many bytes the code point at code unit `at` of `text` takes, the one rule `utf8Length` counts by and `writeUtf8`
 * writes by: one below U+0080, two below U+0800, four for a surrogate pair, which takes the unit after it too, and three
 * for any other unit, a lone surrogate's among them, the three bytes of the U+FFFD an encoder writes in its place.
 */
const widthAt = (text: string, at: number): Width => {
	const unit = text.charCodeAt(at)
	return unit < 0x80
		? 1
		: unit < 0x800
			? 2
			: isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(at + 1))
				? 4
				: 3
}

/** How many code units a code point of `width` bytes takes: a surrogate pair's two, any other one. */
const unitsOf = (width: Width): 1 | 2 => (width === 4 ? 2 : 1)

/**
 * The UTF-8 byte length of a text, as `writeUtf8` writes a well-formed one, counted from its code units without writing
 * it (`widthAt`), a lone surrogate counting three bytes.
 */
export const utf8Length = (text: string): number => {
	let bytes = 0
	for (let at = 0; at < text.length;) {
		const width = widthAt(text, at)
		bytes += width
		at += unitsOf(width)
	}
	return bytes
}

/**
 * The one encoder of text as bytes: writes a well-formed text's UTF-8 into `out` from `at`, each code point's bytes in
 * place, as many as `widthAt` gives it, and answers the position past its last byte, `at` plus its utf8Length, which
 * `out` holds from `at` (its caller counted them): exactly the platform's UTF-8 (TextEncoder). A lone surrogate, which
 * has no UTF-8, is no WellFormedText, so it never reaches here.
 */
export const writeUtf8 = (out: Uint8Array, at: number, text: WellFormedText): number => {
	let to = at
	for (let i = 0; i < text.length;) {
		const width = widthAt(text, i)
		const unit = text.charCodeAt(i)
		switch (width) {
			case 1:
				out[to] = unit
				break
			case 2:
				out[to] = 0xc0 | (unit >> 6)
				out[to + 1] = 0x80 | (unit & 0x3f)
				break
			case 3:
				out[to] = 0xe0 | (unit >> 12)
				out[to + 1] = 0x80 | ((unit >> 6) & 0x3f)
				out[to + 2] = 0x80 | (unit & 0x3f)
				break
			case 4: {
				const point = ((unit - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00) + 0x10000
				out[to] = 0xf0 | (point >> 18)
				out[to + 1] = 0x80 | ((point >> 12) & 0x3f)
				out[to + 2] = 0x80 | ((point >> 6) & 0x3f)
				out[to + 3] = 0x80 | (point & 0x3f)
				break
			}
		}
		to += width
		i += unitsOf(width)
	}
	return to
}

/** A well-formed text's bytes, the ones SHA-256 hashes for it: its UTF-8 (`writeUtf8`), in an array of their own. */
export const utf8 = (text: WellFormedText): Uint8Array => {
	const out = new Uint8Array(utf8Length(text))
	writeUtf8(out, 0, text)
	return out
}

/** A decoder that refuses a malformed sequence and keeps a byte order mark (see the header). */
const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** What `decode` reads, a well-formed text (`proved`), or undefined where it refused the bytes: the TypeError a fatal
 * decoder throws is its one signal. */
const readWith = (decode: () => string): WellFormedText | undefined => {
	try {
		const text = decode()
		proved(text)
		return text
	} catch {
		return undefined
	}
}

/** The decoder of whole texts: a decode that is not streamed starts afresh, so one serves every call. */
const whole = strict()

/** The text `bytes` spell in UTF-8, every byte read as it is; undefined where they are no UTF-8. */
export const utf8Text = (bytes: Uint8Array): WellFormedText | undefined =>
	readWith(() => whole.decode(bytes))

/**
 * A reader of UTF-8 text that arrives in chunks: each chunk's text, a sequence a chunk boundary cuts carried into the
 * next chunk, and the end, which refuses a sequence the last chunk left cut. Where the bytes are cut changes nothing it
 * reads.
 */
export interface Utf8Chunks {
	readonly chunk: (bytes: Uint8Array) => WellFormedText | undefined
	readonly end: () => WellFormedText | undefined
}

/** A reader of chunked UTF-8 text from its first byte (Utf8Chunks), with a decoder of its own. */
export const utf8Chunks = (): Utf8Chunks => {
	const decoder = strict()
	return {
		chunk: (bytes) => readWith(() => decoder.decode(bytes, { stream: true })),
		end: () => readWith(() => decoder.decode())
	}
}
