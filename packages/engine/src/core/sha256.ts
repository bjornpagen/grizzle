/**
 * SHA-256 for fingerprints, the policy digest and truncated identifiers: node:crypto's native synchronous digest.
 * Fingerprints and identifier digests are pure compile-time functions, so this module reads node:crypto directly; it is
 * the one module of the engine that imports a node builtin.
 */
import { createHash } from "node:crypto"
import { utf8, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"

/** The SHA-256 digest of a message, as lowercase hex: bytes, or a well-formed text (grizzle-text WellFormedText) hashed
 * as its UTF-8 (`utf8`). */
export const sha256Hex = (input: Uint8Array | WellFormedText): string =>
	createHash("sha256")
		.update(typeof input === "string" ? utf8(input) : input)
		.digest("hex")

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
