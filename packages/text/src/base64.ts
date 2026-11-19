/**
 * base64 as RFC 4648 §4 spells bytes, the one reader of it for grizzle and every program beside it: a text spells bytes
 * exactly where it is the one spelling of them, whole groups of four digits of the standard alphabet, the last padded
 * with at most two `=`, its padding bits zero, which is the text those bytes' own `toBase64` writes. Any other text, one
 * with whitespace, a digit of another alphabet, padding elsewhere or a nonzero padding bit, spells none. It imports
 * nothing and runs wherever JavaScript does, a browser included.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc4648#section-4 | RFC 4648, §4 Base 64 Encoding}
 */

/**
 * The shape of base64's text: four digits to a group, and the most `=` the last group pads with.
 *
 * @formatConstant RFC 4648 §4: four digits to a group, at most two of its last padding
 */
const groups = { digits: 4, padding: 2 } as const

/** The code unit of base64's pad, `=`. */
const pad = "=".charCodeAt(0)

/**
 * Whether a code unit is a digit of base64's standard alphabet: A to Z, a to z, 0 to 9, `+` and `/`.
 *
 * @formatConstant RFC 4648 §4's base64 alphabet
 */
const isDigit = (unit: number): boolean =>
	(unit >= 0x41 && unit <= 0x5a) ||
	(unit >= 0x61 && unit <= 0x7a) ||
	(unit >= 0x30 && unit <= 0x39) ||
	unit === 0x2b ||
	unit === 0x2f

/** Whether a text is whole groups of digits, its last padded by at most two `=`, so fromBase64 reads it whole. */
const isShaped = (text: string): boolean => {
	if (text.length % groups.digits !== 0) {
		return false
	}
	let end = text.length
	while (end > 0 && text.length - end < groups.padding && text.charCodeAt(end - 1) === pad) {
		end--
	}
	for (let at = 0; at < end; at++) {
		if (!isDigit(text.charCodeAt(at))) {
			return false
		}
	}
	return true
}

/** The bytes `text` spells in base64's one spelling (see the header), or undefined where it spells none. */
export const base64Bytes = (text: string): Uint8Array<ArrayBuffer> | undefined => {
	if (!isShaped(text)) {
		return undefined
	}
	const bytes = Uint8Array.fromBase64(text)
	return bytes.toBase64() === text ? bytes : undefined
}
