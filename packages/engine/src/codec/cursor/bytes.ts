/**
 * The cursor's byte layer, a hot path: every page encodes and every request decodes a cursor through it, so it is
 * native code over bounded loops, reading code units with charCodeAt and allocating nothing per byte or character.
 */

/**
 * The largest varint the layout admits: lengths and counts are bounded by cursorMaxBytes, which cursorCodec refuses
 * above it (codec.ts), so a varint above 2^28 - 1 (four bytes) is malformed whatever the policy.
 */
export const varintMax = 0x0fffffff
const varintMaxBytes = 4

export class ByteWriter {
	readonly #bytes: Array<number> = []

	byte(value: number): this {
		this.#bytes.push(value & 0xff)
		return this
	}

	/**
	 * A length, a nonnegative integer at most varintMax: a field's or a tuple's, within the token bound cursorCodec
	 * keeps at most varintMax.
	 */
	varint(value: number): this {
		let rest = value
		while (rest >= 0x80) {
			this.#bytes.push((rest & 0x7f) | 0x80)
			rest >>>= 7
		}
		this.#bytes.push(rest)
		return this
	}

	/** A varint length, then the bytes. */
	field(bytes: Uint8Array): this {
		this.varint(bytes.length)
		this.#bytes.push(...bytes)
		return this
	}

	finish(): Uint8Array {
		return Uint8Array.from(this.#bytes)
	}
}

/** The number of bytes `ByteWriter.varint(value)` writes. */
export const varintLength = (value: number): number => {
	let n = 1
	let rest = value
	while (rest >= 0x80) {
		n++
		rest >>>= 7
	}
	return n
}

/**
 * Byte-level primitives of the cursor layout: unsigned LEB128 varints in their one
 * minimal form, a bounded writer and a strict reader, and strict UTF-8.
 *
 * Everything here is canonical in both directions. A varint has exactly one encoding (the shortest), so a reader
 * refuses a redundant continuation byte; UTF-8 has exactly one encoding per scalar, so the reader refuses overlong
 * forms, surrogate code points, values above U+10FFFF, and truncated sequences rather than substituting U+FFFD. A
 * token that decodes is therefore the only token for what it decodes to.
 *
 * The reader never throws: every refusal is `undefined` at the call site, which the layout turns into one fixed
 * CursorError word (fault.ts). No refusal carries the bytes it refused.
 */
export class ByteReader {
	readonly #bytes: Uint8Array
	#offset = 0

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes
	}

	get remaining(): number {
		return this.#bytes.length - this.#offset
	}

	get done(): boolean {
		return this.#offset === this.#bytes.length
	}

	/** One byte, or undefined at the end. */
	byte(): number | undefined {
		const b = this.#bytes[this.#offset]
		if (b === undefined) {
			return undefined
		}
		this.#offset++
		return b
	}

	/** A minimal unsigned LEB128 varint of at most four bytes, or undefined. */
	varint(): number | undefined {
		let value = 0
		for (let i = 0; i < varintMaxBytes; i++) {
			const b = this.byte()
			if (b === undefined) {
				return undefined
			}
			value += (b & 0x7f) * 2 ** (7 * i)
			if ((b & 0x80) === 0) {
				if (i > 0 && b === 0) {
					return undefined
				}
				return value
			}
		}
		return undefined
	}

	/** Exactly `n` bytes, or undefined when fewer remain. */
	take(n: number): Uint8Array | undefined {
		if (n > this.remaining) {
			return undefined
		}
		const out = this.#bytes.slice(this.#offset, this.#offset + n)
		this.#offset += n
		return out
	}

	/** A varint length no larger than `max`, then that many bytes. */
	field(max: number): Uint8Array | undefined {
		const n = this.varint()
		if (n === undefined || n > max) {
			return undefined
		}
		return this.take(n)
	}
}

/** The platform's UTF-8 encoder and decoder: a leading U+FEFF is text, never a byte order mark to drop. */
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })

/**
 * The UTF-8 bytes of well-formed text, a codec's text of an admitted value: the platform encoder's, which writes them
 * exactly.
 */
export const utf8Bytes = (text: string): Uint8Array => encoder.encode(text)

/** Whether `b` is a continuation byte, 10xxxxxx; an index past the end reads undefined, which is none. */
const continuation = (b: number | undefined): b is number => b !== undefined && (b & 0xc0) === 0x80

/**
 * The width of the multi-byte UTF-8 sequence led by `b0` at `i` when it is the one minimal form of a scalar value, 0
 * for a truncated sequence, an overlong form, a surrogate code point or a value above U+10FFFF.
 */
const sequenceWidth = (bytes: Uint8Array, i: number, b0: number): number => {
	if (b0 >= 0xc2 && b0 <= 0xdf) {
		return continuation(bytes[i + 1]) ? 2 : 0
	}
	if (b0 >= 0xe0 && b0 <= 0xef) {
		const b1 = bytes[i + 1]
		const b2 = bytes[i + 2]
		if (!continuation(b1) || !continuation(b2)) {
			return 0
		}
		const code = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)
		return code < 0x800 || (code >= 0xd800 && code <= 0xdfff) ? 0 : 3
	}
	if (b0 >= 0xf0 && b0 <= 0xf4) {
		const b1 = bytes[i + 1]
		const b2 = bytes[i + 2]
		const b3 = bytes[i + 3]
		if (!continuation(b1) || !continuation(b2) || !continuation(b3)) {
			return 0
		}
		const code = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)
		return code < 0x10000 || code > 0x10ffff ? 0 : 4
	}
	return 0
}

/** Whether `bytes` are the one shortest encoding of a sequence of Unicode scalar values, checked without allocating. */
const strictUtf8 = (bytes: Uint8Array): boolean => {
	for (let i = 0, b0 = bytes[0]; b0 !== undefined; b0 = bytes[i]) {
		const width = b0 < 0x80 ? 1 : sequenceWidth(bytes, i, b0)
		if (width === 0) {
			return false
		}
		i += width
	}
	return true
}

/**
 * The string strict UTF-8 bytes spell, or undefined for any byte sequence that is not the one shortest encoding of
 * a sequence of Unicode scalar values. The bytes are checked first, so the platform decoder never replaces one.
 */
export const utf8Text = (bytes: Uint8Array): string | undefined =>
	strictUtf8(bytes) ? decoder.decode(bytes) : undefined

/** The UTF-8 length of well-formed text, without allocating: a surrogate pair is one four-byte code point. */
export const utf8ByteLength = (text: string): number => {
	let n = 0
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i)
		if (unit < 0x80) {
			n += 1
		} else if (unit < 0x800) {
			n += 2
		} else if (
			unit >= 0xd800 &&
			unit <= 0xdbff &&
			i + 1 < text.length &&
			(text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
		) {
			n += 4
			i++
		} else {
			n += 3
		}
	}
	return n
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) {
		return false
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false
		}
	}
	return true
}
