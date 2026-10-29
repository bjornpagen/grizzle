/**
 * The cursor token's base64url text, a hot path: every page writes a token and every request reads one, so it is
 * native code over bounded loops, reading code units with charCodeAt and allocating nothing per character.
 */

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** The value of one base64url character's code unit, undefined for any other. */
const sextet = (code: number): number | undefined => {
	if (code >= 0x41 && code <= 0x5a) {
		return code - 0x41
	}
	if (code >= 0x61 && code <= 0x7a) {
		return code - 0x61 + 26
	}
	if (code >= 0x30 && code <= 0x39) {
		return code - 0x30 + 52
	}
	if (code === 0x2d) {
		return 62
	}
	if (code === 0x5f) {
		return 63
	}
	return undefined
}

/**
 * base64url text of the cursor bytes (RFC 4648 section 5), canonical in both directions.
 *
 * The token is the unpadded URL-safe alphabet A-Z a-z 0-9 - _. Decoding is strict, so every byte string has exactly
 * one token: padding '=' is refused, any character outside the alphabet is refused (including '+', '/', whitespace
 * and line breaks), a length of 1 mod 4 is refused, and the unused low bits of a final partial group must be zero
 * (RFC 4648 section 3.5), so two spellings of one byte string cannot both decode.
 */
export const base64urlEncode = (bytes: Uint8Array): string => {
	let out = ""
	for (let i = 0, b0 = bytes[0]; b0 !== undefined; i += 3, b0 = bytes[i]) {
		const b1 = bytes[i + 1]
		if (b1 === undefined) {
			const n = b0 << 16
			return out + alphabet.charAt(n >> 18) + alphabet.charAt((n >> 12) & 63)
		}
		const b2 = bytes[i + 2]
		if (b2 === undefined) {
			const n = (b0 << 16) | (b1 << 8)
			return (
				out +
				alphabet.charAt(n >> 18) +
				alphabet.charAt((n >> 12) & 63) +
				alphabet.charAt((n >> 6) & 63)
			)
		}
		const n = (b0 << 16) | (b1 << 8) | b2
		out += alphabet.charAt(n >> 18) + alphabet.charAt((n >> 12) & 63)
		out += alphabet.charAt((n >> 6) & 63) + alphabet.charAt(n & 63)
	}
	return out
}

/** The length of the token of `n` bytes. */
export const base64urlLength = (n: number): number =>
	Math.floor(n / 3) * 4 + (n % 3 === 0 ? 0 : (n % 3) + 1)

/** The bytes a canonical token spells, or undefined. */
export const base64urlDecode = (text: string): Uint8Array | undefined => {
	const rest = text.length % 4
	if (rest === 1) {
		return undefined
	}
	const out = new Uint8Array(Math.floor(text.length / 4) * 3 + (rest === 0 ? 0 : rest - 1))
	let o = 0
	let i = 0
	for (; i + 4 <= text.length; i += 4) {
		const a = sextet(text.charCodeAt(i))
		const b = sextet(text.charCodeAt(i + 1))
		const c = sextet(text.charCodeAt(i + 2))
		const d = sextet(text.charCodeAt(i + 3))
		if (a === undefined || b === undefined || c === undefined || d === undefined) {
			return undefined
		}
		const n = (a << 18) | (b << 12) | (c << 6) | d
		out[o++] = n >> 16
		out[o++] = (n >> 8) & 0xff
		out[o++] = n & 0xff
	}
	if (rest === 2) {
		const a = sextet(text.charCodeAt(i))
		const b = sextet(text.charCodeAt(i + 1))
		if (a === undefined || b === undefined || (b & 0x0f) !== 0) {
			return undefined
		}
		out[o++] = (a << 2) | (b >> 4)
	} else if (rest === 3) {
		const a = sextet(text.charCodeAt(i))
		const b = sextet(text.charCodeAt(i + 1))
		const c = sextet(text.charCodeAt(i + 2))
		if (a === undefined || b === undefined || c === undefined || (c & 0x03) !== 0) {
			return undefined
		}
		const n = (a << 10) | (b << 4) | (c >> 2)
		out[o++] = n >> 8
		out[o++] = n & 0xff
	}
	return out
}
