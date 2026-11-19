/**
 * UTF-8, the one codec of text and its bytes for grizzle and every program beside it: a text's bytes and its byte
 * length, a lone surrogate as its three-byte WTF-8 sequence so the encoding stays injective, and the one reader of
 * bytes as text (oxlint.config.ts refuses a TextDecoder anywhere else), which spells exactly the text the bytes hold. A
 * malformed sequence is refused, never replaced by U+FFFD (`fatal`), and a byte order mark is a character of the text,
 * never stripped (`ignoreBOM`). U+FEFF is a scalar like any other, which a stored text, a JSON body or a token may begin
 * with, and a TextDecoder's defaults would drop it from the start of every decode, so the text read would be another
 * value than the one the bytes hold. It imports nothing but the code points of #text/text.ts and runs wherever
 * JavaScript does, a browser included.
 */
import { codePoints } from "#text/text.ts"

/** The platform's UTF-8 encoder, which writes well-formed text exactly as `wtf8` below does. */
const encoder = new TextEncoder()

/** The UTF-8 bytes of one code point, a surrogate code point as its three-byte WTF-8 sequence. */
const pointBytes = (code: number): ReadonlyArray<number> =>
	code < 0x80
		? [code]
		: code < 0x800
			? [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
			: code < 0x10000
				? [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
				: [
						0xf0 | (code >> 18),
						0x80 | ((code >> 12) & 0x3f),
						0x80 | ((code >> 6) & 0x3f),
						0x80 | (code & 0x3f)
					]

/**
 * UTF-8, a lone surrogate as its three-byte WTF-8 sequence. A string iterates by code point, a lone surrogate as a code
 * point of its own, so each step writes one code point's bytes.
 */
const wtf8 = (text: string): Uint8Array =>
	Uint8Array.from(codePoints(text).flatMap((point) => pointBytes(point)))

/**
 * The bytes SHA-256 hashes for a text: UTF-8 for well-formed text, and WTF-8 for a lone surrogate, which keeps the
 * encoding injective. A lone surrogate is written as its three-byte WTF-8 sequence rather than replaced by U+FFFD, as
 * the platform's UTF-8 encoding would, so two different strings never hash as the same bytes. Well-formed text, nearly
 * every text hashed, is the platform encoder's; one with a lone surrogate is written by `wtf8`.
 */
export const utf8 = (text: string): Uint8Array =>
	text.isWellFormed() ? encoder.encode(text) : wtf8(text)

/**
 * The UTF-8 byte length of a text, lone surrogates counting three bytes, as in `utf8`, counted from its code units
 * without encoding it: one byte below U+0080, two below U+0800, four for a surrogate pair, and three for any other unit.
 */
export const utf8Length = (text: string): number => {
	let bytes = 0
	for (let at = 0; at < text.length; at += 1) {
		const unit = text.charCodeAt(at)
		if (unit < 0x80) {
			bytes += 1
		} else if (unit < 0x800) {
			bytes += 2
		} else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(at + 1))) {
			bytes += 4
			at += 1
		} else {
			bytes += 3
		}
	}
	return bytes
}

/** Whether a code unit is a low surrogate, the second of a pair; NaN, past a text's end, is none. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** A decoder that refuses a malformed sequence and keeps a byte order mark (see the header). */
const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** What `decode` reads, or undefined where it refused the bytes: the TypeError a fatal decoder throws is its one signal. */
const readWith = (decode: () => string): string | undefined => {
	try {
		return decode()
	} catch {
		return undefined
	}
}

/** The decoder of whole texts: a decode that is not streamed starts afresh, so one serves every call. */
const whole = strict()

/** The text `bytes` spell in UTF-8, every byte read as it is; undefined where they are no UTF-8. */
export const utf8Text = (bytes: Uint8Array): string | undefined =>
	readWith(() => whole.decode(bytes))

/**
 * A reader of UTF-8 text that arrives in chunks: each chunk's text, a sequence a chunk boundary cuts carried into the
 * next chunk, and the end, which refuses a sequence the last chunk left cut. Where the bytes are cut changes nothing it
 * reads.
 */
export interface Utf8Chunks {
	readonly chunk: (bytes: Uint8Array) => string | undefined
	readonly end: () => string | undefined
}

/** A reader of chunked UTF-8 text from its first byte (Utf8Chunks), with a decoder of its own. */
export const utf8Chunks = (): Utf8Chunks => {
	const decoder = strict()
	return {
		chunk: (bytes) => readWith(() => decoder.decode(bytes, { stream: true })),
		end: () => readWith(() => decoder.decode())
	}
}
