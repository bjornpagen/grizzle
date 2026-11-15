/**
 * The one reader of UTF-8 bytes as text (oxlint.config.ts refuses a TextDecoder anywhere else): the text the bytes
 * spell, exactly as they arrived. A malformed sequence is refused, never replaced by U+FFFD (`fatal`), and a byte
 * order mark is a character of the text, never stripped (`ignoreBOM`). U+FEFF is a scalar like any other, which a stored
 * text, a JSON body or a token may begin with, and a TextDecoder's defaults would drop it from the start of every
 * decode, so the text read would be another value than the one the bytes hold.
 */

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
