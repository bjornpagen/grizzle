/**
 * SHA-256 for fingerprints, the policy digest and truncated identifiers: node:crypto's native synchronous digest.
 * Fingerprints and identifier digests are pure compile-time functions, so this module reads node:crypto directly; it is
 * the one module of the engine that imports a node builtin.
 */
import { createHash, type Hash } from "node:crypto"
import { Utf8Writer, utf8, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"

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

/** The SHA-256 digest of a message, as lowercase hex: bytes, or a well-formed text (grizzle-text WellFormedText) hashed
 * as its UTF-8 (`utf8`). */
export const sha256Hex = (input: Uint8Array | WellFormedText): string =>
	createHash("sha256")
		.update(typeof input === "string" ? utf8(input) : input)
		.digest("hex")

/**
 * The SHA-256 digest of a well-formed text's UTF-8, its 32 bytes: the image a key holds a text of no byte bound by
 * (physical/ddl/library.ts textDigest, `sha256(convert_to(t, 'UTF8'))`), as the host computes it for a column it writes.
 */
export const textDigest = (text: WellFormedText): Uint8Array<ArrayBuffer> =>
	new Uint8Array(createHash("sha256").update(utf8(text)).digest())

/** RFC 4648's base32 alphabet, lowercase. */
const base32 = "abcdefghijklmnopqrstuvwxyz234567"

/**
 * The bits of a SHA-256 digest.
 *
 * @formatConstant SHA-256's digest: 256 bits
 */
const digestBits = 256

/**
 * The bits one base32 character holds.
 *
 * @formatConstant RFC 4648 base32: 5 bits a character
 */
const base32Bits = 5

/**
 * The bits one hex digit holds.
 *
 * @formatConstant a hex digit: 4 bits
 */
const hexBits = 4

/** The characters of a whole SHA-256 digest in base32 (sha256Base32), all ASCII. */
export const sha256Base32Chars = Math.ceil(digestBits / base32Bits)

/**
 * The whole SHA-256 digest of a message in lowercase RFC 4648 base32, unpadded, its last character's low bits zero: a
 * name two messages share only where SHA-256 collides. A text is hashed as its UTF-8 (`sha256Hex`).
 */
export const sha256Base32 = (input: Uint8Array | WellFormedText): string => {
	const hex = sha256Hex(input)
	let out = ""
	let held = 0
	let bits = 0
	for (let at = 0; at < hex.length; at++) {
		held = (held << hexBits) | Number.parseInt(hex.charAt(at), 16)
		bits += hexBits
		if (bits < base32Bits) {
			continue
		}
		bits -= base32Bits
		out += base32.charAt(held >> bits)
		held &= (1 << bits) - 1
	}
	return bits > 0 ? out + base32.charAt(held << (base32Bits - bits)) : out
}
