/**
 * SHA-256 for fingerprints, the policy digest and truncated identifiers: node:crypto's native synchronous digest.
 * Fingerprints and identifier digests are pure compile-time functions, so this module reads node:crypto directly; it is
 * the one module of the engine that imports a node builtin.
 */
import { createHash, type Hash } from "node:crypto"
import { Utf8Writer, utf8, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"
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
 * most a chunk, or the longest piece written, at once. One writer serves every message, its buffer grown once.
 */
export class Sha256Messages {
	/** The hash of the message being written, begun at its first byte. */
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
		const hash = this.#current()
		this.out.drain((bytes) => hash.update(bytes))
		this.#hash = undefined
		return hash.digest("hex")
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

/** A message's bytes: bytes, or a well-formed text (grizzle-text WellFormedText) as its UTF-8 (`utf8`). */
const messageBytes = (input: Uint8Array | WellFormedText): Uint8Array =>
	typeof input === "string" ? utf8(input) : input

/**
 * The SHA-256 digest of a message, its sha256Octets bytes in a fresh array over its own buffer: bytes, or a well-formed
 * text hashed as its UTF-8, as PostgreSQL's `sha256(convert_to(x, 'UTF8'))` hashes a text of a UTF8 database.
 */
export const sha256Digest = (input: Uint8Array | WellFormedText): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(createHash("sha256").update(messageBytes(input)).digest())

/** The SHA-256 digest of a message, as lowercase hex: bytes, or a well-formed text hashed as its UTF-8. */
export const sha256Hex = (input: Uint8Array | WellFormedText): string =>
	createHash("sha256").update(messageBytes(input)).digest("hex")

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
