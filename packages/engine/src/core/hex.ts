import { defined } from "@bjornpagen/grizzle-text/base/invariant"

/**
 * Hex, the one spelling of every bit string grizzle writes: a set's literal and its parameter text, and a roster's live
 * codes. A string is whole hex digits, four bits a digit, most significant first, in the digits 0-9 and A-F. Every bit
 * string grizzle writes is a whole number of digits long: a set's width is rounded up to whole bytes, two digits a
 * byte, and the bits past the last code, the padding, are 0, so no string has a binary tail and none is ever joined from
 * parts.
 */

/**
 * The bits one hex digit spells.
 *
 * @formatConstant a hex digit: 4 bits
 */
const hexDigitBits = 4

/** Hex's sixteen digits, in their values' order. */
const alphabet = "0123456789ABCDEF"

/** The first, most significant, of a digit's four bits: the one that holds the digit's first position. */
const firstBit = 0b1000

/**
 * What begins a bit string's text as bit's input function reads it, hex digits following: `X`, as the SQL constant
 * X'…' begins.
 */
const bitInputPrefix = "X"

/**
 * A bit string's text as bit's input function reads it, `X` then its hex digits: a set's parameter text and array
 * element, which PostgreSQL reads into a bit(n) only at exactly n bits, so its whole digits are its type's width.
 */
export const bitInputText = (hex: string): string => `${bitInputPrefix}${hex}`

/** The whole hex digits that hold `bits` bits. */
const hexDigitsFor = (bits: number): number => Math.ceil(bits / hexDigitBits)

/**
 * The bits one byte holds: PostgreSQL stores a bit string's bits in whole bytes (utils/varbit.h VARBITBYTES), its
 * length rounded up to them.
 *
 * @formatConstant a byte: 8 bits
 */
const byteBits = 8

/**
 * `bits` rounded up to whole bytes: a set's width (ir/codes.ts RosterCodec). PostgreSQL stores a bit(n) in whole bytes,
 * so the padding up to the byte costs no storage, and a roster grows into it without a wider type, which would rewrite
 * every table that stores a set over it; a whole byte is two whole hex digits.
 */
export const wholeByteBits = (bits: number): number => Math.ceil(bits / byteBits) * byteBits

/** The digits of a string of `bits` bits, each 0: one value from 0 to 15 per whole hex digit, which setBit fills. */
export const zeroDigits = (bits: number): Uint8Array => new Uint8Array(hexDigitsFor(bits))

/** Sets bit `position` of `digits`, a position within them, to 1, position 0 the first digit's most significant bit. */
export const setBit = (digits: Uint8Array, position: number): void => {
	const at = Math.floor(position / hexDigitBits)
	digits[at] =
		defined(digits[at], "a bit position within its string's digits") |
		(firstBit >> (position % hexDigitBits))
}

/** The hex text of `digits`: one character of 0-9 or A-F per digit, in order, each its value's in the alphabet. */
export const hexText = (digits: Uint8Array): string => {
	let text = ""
	for (const digit of digits) {
		text += alphabet.charAt(digit)
	}
	return text
}

/**
 * PostgreSQL's output text of a bit string, a 0 or a 1 per position, as its hex digits: each four characters one digit,
 * a last shorter run padded with 0s. The text is PostgreSQL's own output, so a character other than 1 reads as 0.
 */
export const hexOfBitText = (text: string): string => {
	const digits = zeroDigits(text.length)
	for (let position = 0; position < text.length; position += 1) {
		if (text.charCodeAt(position) === 0x31) {
			setBit(digits, position)
		}
	}
	return hexText(digits)
}
