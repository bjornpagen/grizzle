/**
 * The decimal datatype's lexical and canonical mappings as XML Schema 1.1 Part 2 defines them (§3.3.3, decimalLexicalMap
 * and decimalCanonicalMap), written here from that definition alone, sharing no code with grizzle's engine or
 * PostgreSQL: a decimal text's value is its digits, signed, over ten to the count of its fraction digits, exactly, and
 * the value's canonical text is the one numeral of it with no leading zero but a lone one before the point, no
 * trailing zero after it, no point at all for an integer, and a minus sign for a negative value, zero having none.
 *
 * The text is read by its own scan of the grammar of xs:decimal's lexical space,
 * `(\+|-)?([0-9]+(\.[0-9]*)?|\.[0-9]+)`, of any digits.
 */

import { String as Str } from "effect"

/** A decimal value: its sign, a nonnegative integer of its digits, and the count of digits past its point. */
export interface DecimalValue {
	readonly negative: boolean
	readonly digits: bigint
	readonly scale: bigint
}

/** Whether the character at `i` is an ASCII digit. */
const isDigitAt = (text: string, i: number): boolean => {
	const c = text[i]
	return c !== undefined && c >= "0" && c <= "9"
}

/** The end of the run of digits that starts at `i`. */
const digitsEnd = (text: string, i: number): number => {
	let j = i
	while (isDigitAt(text, j)) {
		j++
	}
	return j
}

/** The value a text names by decimalLexicalMap, or undefined where it is no member of the grammar. */
export const referenceDecimal = (text: string): DecimalValue | undefined => {
	const negative = Str.startsWith("-")(text)
	const start = negative || Str.startsWith("+")(text) ? 1 : 0
	const integerEnd = digitsEnd(text, start)
	const point = text[integerEnd] === "."
	const fractionEnd = point ? digitsEnd(text, integerEnd + 1) : integerEnd
	const integer = Str.slice(start, integerEnd)(text)
	const fraction = point ? Str.slice(integerEnd + 1, fractionEnd)(text) : ""
	return fractionEnd !== text.length || integer.length + fraction.length === 0
		? undefined
		: {
				negative,
				digits: BigInt(`0${integer}${fraction}`),
				scale: BigInt(fraction.length)
			}
}

/** The value with its trailing zeros past the point divided away: the least scale that writes it. */
const reduced = (value: DecimalValue): DecimalValue => {
	let { digits, scale } = value
	while (scale > 0n && digits % 10n === 0n) {
		digits /= 10n
		scale--
	}
	return { negative: value.negative && digits !== 0n, digits, scale }
}

/** The canonical text of a value by decimalCanonicalMap: one value, one text. */
export const canonicalDecimal = (value: DecimalValue): string => {
	const { negative, digits, scale } = reduced(value)
	const sign = negative ? "-" : ""
	if (scale === 0n) {
		return `${sign}${digits}`
	}
	const written = Str.padStart(Number(scale) + 1, "0")(digits.toString())
	const cut = written.length - Number(scale)
	return `${sign}${Str.slice(0, cut)(written)}.${Str.slice(cut)(written)}`
}

/** -1, 0 or 1 as a is below, equal to or above b, by their exact values. */
export const decimalOrder = (a: DecimalValue, b: DecimalValue): -1 | 0 | 1 => {
	const scale = a.scale > b.scale ? a.scale : b.scale
	const signed = (v: DecimalValue): bigint =>
		(v.negative ? -v.digits : v.digits) * 10n ** (scale - v.scale)
	const [x, y] = [signed(a), signed(b)]
	return x < y ? -1 : x > y ? 1 : 0
}

/** The digits of a value before its point, past leading zeros, and after it, before trailing zeros. */
export const significantDigits = (
	value: DecimalValue
): { readonly integer: number; readonly fraction: number } => {
	const { digits, scale } = reduced(value)
	const whole = digits / 10n ** scale
	return {
		integer: whole === 0n ? 0 : whole.toString().length,
		fraction: Number(scale)
	}
}
