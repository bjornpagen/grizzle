/**
 * SHA-256 for fingerprints, the policy digest and truncated identifiers: node:crypto's native synchronous digest.
 * Fingerprints and identifier digests are pure compile-time functions, so this module reads node:crypto directly; it is
 * the one module of the engine that imports a node builtin.
 */
import { createHash, type Hash, hash as hashOnce } from "node:crypto"
import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { Utf8Writer, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { sha256Octets } from "#compiler/core/digest.ts"

/**
 * How many bytes of a message a Sha256Messages writer holds before it passes them to the hash: the hash reads its
 * message in pieces, so a message of any length is held a chunk at a time, never whole. It is the chunk Node's byte
 * streams carry by default, on the platforms grizzle builds on, which a digest's writer is: a stream of bytes into a
 * hash.
 *
 * @limitKind published
 * @owner Node 26.13.1's streams (lib/internal/streams/state.js)
 * @unit bytes
 * @scope the buffer of one Sha256Messages writer, between two updates of its hash
 * @constraint configurable default
 * @source https://github.com/nodejs/node/blob/v26.13.1/lib/internal/streams/state.js#L12
 * @quote let defaultHighWaterMarkBytes = process.platform === 'win32' ? 16 * 1024 : 64 * 1024;
 * @verified 2026-11-20
 */
export const messageChunk = 64 * 1024

/**
 * SHA-256 messages written as UTF-8 (`out`, grizzle-text Utf8Writer) one after another, each piece's bytes written in
 * place once and passed to the hash a chunk at a time (`chunk` bytes, Overflow drain), so no message is held whole: at
 * most a chunk, or the longest piece written, at once. One writer serves every message, its buffer grown once. A
 * message the writer holds whole when it ends, one no longer than a chunk, is hashed in one call (node:crypto's
 * one-shot hash), with no hash object made for it: a Merkle identity hashes one short message for each container.
 */
export class Sha256Messages {
	/** The hash of the message being written, begun where the writer first drained it: none while it holds it whole. */
	#hash: Hash | undefined
	readonly out: Utf8Writer

	constructor(chunk: number) {
		this.out = new Utf8Writer({
			kind: "drain",
			chunk,
			into: (bytes) => this.#current().update(bytes)
		})
	}

	/** The digest of every byte written since the last digest, as lowercase hex: the message ends, and the next begins. */
	hex(): string {
		const streamed = this.#hash
		if (streamed === undefined) {
			const hex = hashOnce("sha256", this.out.held(), "hex")
			this.out.clear()
			return hex
		}
		this.out.drain((bytes) => streamed.update(bytes))
		this.#hash = undefined
		return streamed.digest("hex")
	}

	/** The message being written left unread: its bytes and its hash dropped, and the next message begins. */
	discard(): void {
		this.out.drain(() => undefined)
		this.#hash = undefined
	}

	#current(): Hash {
		const hash = this.#hash ?? createHash("sha256")
		this.#hash = hash
		return hash
	}
}

/**
 * The SHA-256 digest of a message, its sha256Octets bytes in a fresh array over its own buffer: bytes, or a well-formed
 * text hashed as its UTF-8, as PostgreSQL's `sha256(convert_to(x, 'UTF8'))` hashes a text of a UTF8 database. A text is
 * passed to node:crypto as it is, which hashes a string as its UTF-8: a well-formed text's UTF-8 is grizzle-text's
 * (writeUtf8), the platform's, since no lone surrogate is one, so no byte of it is written here first.
 */
export const sha256Digest = (input: Uint8Array | WellFormedText): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(hashOnce("sha256", input, "buffer"))

/** The SHA-256 digest of a message, as lowercase hex: bytes, or a well-formed text hashed as its UTF-8 (sha256Digest). */
export const sha256Hex = (input: Uint8Array | WellFormedText): string =>
	hashOnce("sha256", input, "hex")

/**
 * The SHA-256 digest of a text held as its chunks (grizzle-text TextChunks), as lowercase hex: its UTF-8 hashed a chunk at
 * a time, each chunk passed to the hash as it is (sha256Digest), so the text is never joined; sha256Hex's digest of the
 * text they make.
 */
export const sha256ChunksHex = (chunks: TextChunks): string => {
	const hash = createHash("sha256")
	for (const chunk of chunks) {
		hash.update(chunk)
	}
	return hash.digest("hex")
}

/** RFC 4648's base32 alphabet, lowercase. */
const base32 = "abcdefghijklmnopqrstuvwxyz234567"

/**
 * The bits one byte holds.
 *
 * @formatConstant a byte: 8 bits
 */
const byteBits = 8

/**
 * The bits one base32 character holds.
 *
 * @formatConstant RFC 4648 base32: 5 bits a character
 */
const base32Bits = 5

/** The characters of a whole SHA-256 digest in base32 (sha256Base32), all ASCII. */
export const sha256Base32Chars = Math.ceil((sha256Octets * byteBits) / base32Bits)

/**
 * The whole SHA-256 digest of a message in lowercase RFC 4648 base32, unpadded, its last character's low bits zero: a
 * name two messages share only where SHA-256 collides. A text is hashed as its UTF-8 (`sha256Digest`).
 */
export const sha256Base32 = (input: Uint8Array | WellFormedText): string => {
	let out = ""
	let held = 0
	let bits = 0
	for (const byte of sha256Digest(input)) {
		held = (held << byteBits) | byte
		bits += byteBits
		while (bits >= base32Bits) {
			bits -= base32Bits
			out += base32.charAt(held >> bits)
			held &= (1 << bits) - 1
		}
	}
	return bits > 0 ? out + base32.charAt(held << (base32Bits - bits)) : out
}
