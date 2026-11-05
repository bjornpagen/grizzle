/**
 * The cursor's byte layer, a hot path: every page encodes and every request decodes a cursor through it, so it is
 * native code over bounded loops, reading code units with charCodeAt and allocating nothing per byte or character.
 */

/**
 * The most bytes one varint of the layout spans (layout.ts): a digest's or a value's length, or the tuple's count, is
 * written in at most four bytes, and a longer varint is malformed. It is the layout's own definition, from which every
 * bound of a token derives (varintMax, codec.ts cursorTokenMaxLength).
 *
 * @formatConstant the cursor layout's varint: unsigned LEB128 of at most four bytes
 */
const varintMaxBytes = 4

/**
 * The largest value a varint of the layout writes, a length's in bytes or the tuple's count: unsigned LEB128 carries 7
 * bits of the value in each byte, and a varint spans at most varintMaxBytes bytes, so the largest is
 * 2^(7 * varintMaxBytes) - 1, and a length or a count above it has no encoding.
 *
 * @formatConstant the cursor layout's varint: its largest value, of a digest's or a value's length or the tuple's count
 */
export const varintMax = 2 ** (7 * varintMaxBytes) - 1

/** The number of bytes a varint of `value` spans. */
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
 * What a layout is written to: the one description of its bytes (layout.ts writeCursor), which `written` reads twice,
 * once to count them and once to write them.
 */
export interface ByteSink {
	/**
	 * A length or a count, a nonnegative integer at most varintMax: a token holds no more bytes than its characters,
	 * which cursorCodec keeps at most codec.ts cursorTokenMaxLength.
	 */
	varint(value: number): this
	/** A varint length, then the bytes. */
	field(bytes: Uint8Array): this
}

/** The sink that counts the bytes a layout writes. */
class ByteCounter implements ByteSink {
	#length = 0

	get length(): number {
		return this.#length
	}

	varint(value: number): this {
		this.#length += varintLength(value)
		return this
	}

	field(bytes: Uint8Array): this {
		this.#length += varintLength(bytes.length) + bytes.length
		return this
	}
}

/** The sink that writes a layout into one buffer of the length its ByteCounter counted. */
class ByteWriter implements ByteSink {
	readonly bytes: Uint8Array
	#offset = 0

	constructor(length: number) {
		this.bytes = new Uint8Array(length)
	}

	varint(value: number): this {
		let rest = value
		while (rest >= 0x80) {
			this.bytes[this.#offset++] = (rest & 0x7f) | 0x80
			rest >>>= 7
		}
		this.bytes[this.#offset++] = rest
		return this
	}

	field(bytes: Uint8Array): this {
		this.varint(bytes.length)
		this.bytes.set(bytes, this.#offset)
		this.#offset += bytes.length
		return this
	}
}

/**
 * The bytes `lay` writes to its sink: counted first, then written once into one buffer of exactly that length, so no
 * byte is pushed, grown or copied twice, at any length up to the layout's bound.
 */
export const written = (lay: (sink: ByteSink) => void): Uint8Array => {
	const counter = new ByteCounter()
	lay(counter)
	const writer = new ByteWriter(counter.length)
	lay(writer)
	return writer.bytes
}

/**
 * Why the reader refused: a varint that is not the minimal encoding of at most varintMaxBytes bytes, a truncated one
 * included; or a length or count that claims more than the bytes after it hold, refused before anything it claims is
 * read. Neither carries a byte it refused.
 */
export type ReadFault =
	| { readonly kind: "varint" }
	| { readonly kind: "claim"; readonly claimed: number; readonly remaining: number }

const varintFault: ReadFault = Object.freeze({ kind: "varint" })

/**
 * Byte-level primitives of the cursor layout: unsigned LEB128 varints in their one
 * minimal form, an exact writer (written) and a strict reader, and strict UTF-8.
 *
 * Everything here is canonical in both directions. A varint has exactly one encoding (the shortest), so a reader
 * refuses a redundant continuation byte; UTF-8 has exactly one encoding per scalar, so the reader refuses overlong
 * forms, surrogate code points, values above U+10FFFF, and truncated sequences rather than substituting U+FFFD. A
 * token that decodes is therefore the only token for what it decodes to.
 *
 * The reader is total over untrusted bytes and copies none: a field it reads is a view of its input, one it skips is
 * not viewed at all, and a length or count is compared with the bytes that remain before anything is read for it, so
 * no reading allocates in proportion to what the bytes claim. A refusal is a ReadFault, which the layout reports as one
 * fixed CursorError word (fault.ts).
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
	#byte(): number | undefined {
		const b = this.#bytes[this.#offset]
		if (b === undefined) {
			return undefined
		}
		this.#offset++
		return b
	}

	/** A minimal unsigned LEB128 varint of at most varintMaxBytes bytes, or undefined. */
	varint(): number | undefined {
		let value = 0
		for (let i = 0; i < varintMaxBytes; i++) {
			const b = this.#byte()
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

	/**
	 * A varint that the bytes after it can hold, each thing it counts taking at least one of them: a field's length, or
	 * the tuple's count of fields.
	 */
	claim(): number | ReadFault {
		const n = this.varint()
		if (n === undefined) {
			return varintFault
		}
		const remaining = this.remaining
		return n > remaining ? { kind: "claim", claimed: n, remaining } : n
	}

	/** A claimed length, then that many bytes, as a view of the input. */
	field(): Uint8Array | ReadFault {
		const n = this.claim()
		if (typeof n !== "number") {
			return n
		}
		const view = this.#bytes.subarray(this.#offset, this.#offset + n)
		this.#offset += n
		return view
	}

	/** A claimed length, then past that many bytes, none of them viewed: the length. */
	skip(): number | ReadFault {
		const n = this.claim()
		if (typeof n === "number") {
			this.#offset += n
		}
		return n
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
