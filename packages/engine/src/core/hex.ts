import { defined } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * Hex, the one spelling of every bit string grizzle writes: a set's literal and its parameter text, a roster's live
 * codes and a closed relation's constant. A string is whole hex digits, four bits a digit, most significant first, in
 * the digits 0-9 and A-F. Every bit string grizzle writes is a whole number of digits long: a set's width and a
 * constant's length are rounded up to whole digits, and the bits past the last code or cell, the padding, are 0, so no
 * string has a binary tail and none is ever joined from parts.
 */

/**
 * The bits one hex digit spells.
 *
 * @formatConstant a hex digit: 4 bits
 */
export const hexDigitBits = 4

/** Hex's sixteen digits, in their values' order. */
const alphabet = "0123456789ABCDEF"

/** The first, most significant, of a digit's four bits: the one that holds the digit's first position. */
const firstBit = 0b1000

/** The platform's UTF-8 decoder, which reads ASCII bytes as the characters they are. */
const ascii = new TextDecoder()

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
export const hexDigitsFor = (bits: number): number => Math.ceil(bits / hexDigitBits)

/** `bits` rounded up to whole hex digits: the length of the string that holds them, its last digit padded with 0s. */
export const wholeDigitBits = (bits: number): number => hexDigitsFor(bits) * hexDigitBits

/** The digits of a string of `bits` bits, each 0: one value from 0 to 15 per whole hex digit, which setBit fills. */
export const zeroDigits = (bits: number): Uint8Array => new Uint8Array(hexDigitsFor(bits))

/** Sets bit `position` of `digits`, a position within them, to 1, position 0 the first digit's most significant bit. */
export const setBit = (digits: Uint8Array, position: number): void => {
	const at = Math.floor(position / hexDigitBits)
	digits[at] =
		defined(digits[at], "a bit position within its string's digits") |
		(firstBit >> (position % hexDigitBits))
}

/** Whether bit `bit` of one digit's value, 0 its most significant, is 1. */
const digitHolds = (value: number, bit: number): boolean => (value & (firstBit >> bit)) !== 0

/** Bit `position` of `digits`, a position within them: 0 or 1. */
export const bitAt = (digits: Uint8Array, position: number): number =>
	digitHolds(
		defined(
			digits[Math.floor(position / hexDigitBits)],
			"a bit position within its string's digits"
		),
		position % hexDigitBits
	)
		? 1
		: 0

/** A digit's character, as its ASCII byte. */
const digitByte = (digit: number): number => alphabet.charCodeAt(digit)

/** The hex text of `digits`: one character of 0-9 or A-F per digit, in order. */
export const hexText = (digits: Uint8Array): string => ascii.decode(digits.map(digitByte))

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

/**
 * The value of one hex digit's character, by its UTF-16 code unit: 0-9 and A-F alone, the one spelling grizzle writes,
 * so a lowercase digit, which PostgreSQL would read as the same bits, is none.
 */
const digitValue = (code: number): number | undefined => {
	if (code >= 0x30 && code <= 0x39) {
		return code - 0x30
	}
	if (code >= 0x41 && code <= 0x46) {
		return code - 0x41 + 10
	}
	return undefined
}

/** The digits a hex text spells, or the position of its first character that is no digit (digitValue). */
export const hexDigitsOf = (text: string): Result.Result<Uint8Array, number> => {
	const digits = new Uint8Array(text.length)
	for (let i = 0; i < text.length; i += 1) {
		const value = digitValue(text.charCodeAt(i))
		if (value === undefined) {
			return Result.err(i)
		}
		digits[i] = value
	}
	return Result.ok(digits)
}
