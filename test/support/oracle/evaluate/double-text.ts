/**
 * The decimal-to-binary64 conversion as IEEE 754-2019 defines it, written here from that definition alone, sharing no
 * code with grizzle's engine, ECMAScript's Number or PostgreSQL: a decimal text's exact rational value rounded to the
 * nearest binary64 value, ties to the one whose significand is even, an infinity of the text's sign where that rounding
 * with an unbounded exponent reaches 2^1024, and a zero of the text's sign where it reaches zero. The result is the
 * value's encoding, 64 bits, so -0 and +0 are two answers and every NaN is the one quiet NaN.
 *
 * The text is read by its own scan of the grammar of every decimal text of a double, the grammar of XML Schema 1.1's
 * xs:double lexical space: `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?`, `INF`, `+INF`, `-INF`, `NaN`.
 */

import { String as Str } from "effect"

/** binary64's precision, its least normal exponent and its greatest, as IEEE 754 states them. */
const precision = 53n
const leastExponent = -1022n
const greatestExponent = 1023n

/** A normal significand's leading bit, 2^(p - 1): a significand below it is a subnormal's, of exponent field zero. */
const hidden = 1n << (precision - 1n)
const exponentBias = 1023n
const signBit = 1n << 63n
const infinityBits = 0x7ff0000000000000n
const nanBits = 0x7ff8000000000000n

/**
 * Decimal exponents past which no rounding is needed: a value of at least 10^400 is above 2^1024, as 2^1024 < 10^309,
 * and one below 10^-400 is below 2^-1075, half the least subnormal, as 2^-1075 > 10^-324.
 */
const decimalReach = 400n

/** A decimal text's value: its sign, a nonnegative integer of its digits, and the power of ten that scales it. */
interface DecimalValue {
	readonly negative: boolean
	readonly digits: bigint
	readonly scale: bigint
}

/** What a text is under the grammar: a finite decimal, an infinity, NaN, or no member. */
type DecimalText =
	| { readonly kind: "finite"; readonly value: DecimalValue }
	| { readonly kind: "infinity"; readonly negative: boolean }
	| { readonly kind: "nan" }

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

/** A text read by the grammar, or undefined where it is no member. */
export const decimalTextOf = (text: string): DecimalText | undefined => {
	if (text === "NaN") {
		return { kind: "nan" }
	}
	if (text === "INF" || text === "+INF" || text === "-INF") {
		return { kind: "infinity", negative: text === "-INF" }
	}
	const negative = Str.startsWith("-")(text)
	let i = negative || Str.startsWith("+")(text) ? 1 : 0
	const integerEnd = digitsEnd(text, i)
	const integer = Str.slice(i, integerEnd)(text)
	i = integerEnd
	let fraction = ""
	if (text[i] === ".") {
		const fractionEnd = digitsEnd(text, i + 1)
		fraction = Str.slice(i + 1, fractionEnd)(text)
		i = fractionEnd
	}
	if (integer.length + fraction.length === 0) {
		return undefined
	}
	let exponent = 0n
	if (text[i] === "e" || text[i] === "E") {
		const sign = text[i + 1] === "-" || text[i + 1] === "+" ? 1 : 0
		const exponentEnd = digitsEnd(text, i + 1 + sign)
		if (exponentEnd === i + 1 + sign) {
			return undefined
		}
		const magnitude = BigInt(Str.slice(i + 1 + sign, exponentEnd)(text))
		exponent = text[i + 1] === "-" ? -magnitude : magnitude
		i = exponentEnd
	}
	return i === text.length
		? {
				kind: "finite",
				value: {
					negative,
					digits: BigInt(`0${integer}${fraction}`),
					scale: exponent - BigInt(fraction.length)
				}
			}
		: undefined
}

const bitLength = (n: bigint): bigint => (n === 0n ? 0n : BigInt(n.toString(2).length))

/** floor(log2(num / den)) of a positive rational, exactly. */
const floorLog2 = (num: bigint, den: bigint): bigint => {
	const guess = bitLength(num) - bitLength(den)
	const scaledNum = guess >= 0n ? num : num << -guess
	const scaledDen = guess >= 0n ? den << guess : den
	return scaledNum >= scaledDen ? guess : guess - 1n
}

/** The integer nearest num / den, a tie to the even one. */
const nearestEven = (num: bigint, den: bigint): bigint => {
	const q = num / den
	const twice = (num % den) * 2n
	return twice > den || (twice === den && q % 2n === 1n) ? q + 1n : q
}

/**
 * A conversion's result: the binary64 encoding, and whether the exact value lay halfway between its two neighbours,
 * which the rule ties to even decided.
 */
export interface Conversion {
	readonly bits: bigint
	readonly tie: boolean
}

/** The conversion of the positive rational num / den: to nearest, ties to even, an infinity past the greatest double. */
const rounded = (num: bigint, den: bigint): Conversion => {
	const e = floorLog2(num, den)
	const k = (e > leastExponent ? e : leastExponent) - (precision - 1n)
	const n = k >= 0n ? num : num << -k
	const d = k >= 0n ? den << k : den
	const nearest = nearestEven(n, d)
	const tie = (n % d) * 2n === d
	const carried = nearest === 1n << precision
	const m = carried ? hidden : nearest
	const weight = carried ? k + 1n : k
	if (weight + precision - 1n > greatestExponent) {
		return { bits: infinityBits, tie }
	}
	return {
		bits:
			m < hidden
				? m
				: ((weight + precision - 1n + exponentBias) << (precision - 1n)) | (m - hidden),
		tie
	}
}

/** The IEEE 754 conversion of a finite decimal value, its sign the value's own. */
const conversionOf = (value: DecimalValue): Conversion => {
	const sign = value.negative ? signBit : 0n
	const reach = BigInt(value.digits.toString().length) + value.scale
	const magnitude =
		value.digits === 0n || reach < -decimalReach
			? { bits: 0n, tie: false }
			: reach > decimalReach
				? { bits: infinityBits, tie: false }
				: value.scale >= 0n
					? rounded(value.digits * 10n ** value.scale, 1n)
					: rounded(value.digits, 10n ** -value.scale)
	return { bits: sign | magnitude.bits, tie: magnitude.tie }
}

/** The IEEE 754 conversion of a decimal text of a double, or undefined where the text is no member of the grammar. */
export const referenceConversion = (text: string): Conversion | undefined => {
	const read = decimalTextOf(text)
	if (read === undefined) {
		return undefined
	}
	switch (read.kind) {
		case "nan":
			return { bits: nanBits, tie: false }
		case "infinity":
			return { bits: (read.negative ? signBit : 0n) | infinityBits, tie: false }
		case "finite":
			return conversionOf(read.value)
	}
}

/** A number's binary64 encoding. */
export const bitsOfNumber = (x: number): bigint => {
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, x)
	return view.getBigUint64(0)
}

/** The number a binary64 encoding is. */
const numberOfBits = (bits: bigint): number => {
	const view = new DataView(new ArrayBuffer(8))
	view.setBigUint64(0, bits)
	return view.getFloat64(0)
}

/** Whether two encodings are one double: the same 64 bits, or both a NaN, whatever their payloads. */
export const sameDouble = (a: bigint, b: bigint): boolean =>
	a === b || (Number.isNaN(numberOfBits(a)) && Number.isNaN(numberOfBits(b)))

/** The double the IEEE 754 conversion gives a decimal text of one, or undefined where the text is none. */
export const referenceDouble = (text: string): number | undefined => {
	const conversion = referenceConversion(text)
	return conversion === undefined ? undefined : numberOfBits(conversion.bits)
}
