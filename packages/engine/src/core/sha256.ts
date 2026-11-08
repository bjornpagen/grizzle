/**
 * SHA-256 for fingerprints, the policy digest and truncated identifiers: node:crypto's native synchronous digest.
 * Fingerprints and identifier digests are pure compile-time functions, so this module reads node:crypto directly; it is
 * the one module of the engine that imports a node builtin.
 */
import { createHash } from "node:crypto"
import { codePoints } from "#compiler/core/text.ts"

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

/** The SHA-256 digest of a message, as lowercase hex. A text is hashed as the bytes `utf8` writes. */
export const sha256Hex = (input: Uint8Array | string): string =>
	createHash("sha256")
		.update(typeof input === "string" ? utf8(input) : input)
		.digest("hex")
