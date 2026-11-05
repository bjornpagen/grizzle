import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import {
	binary32Digits,
	binary32LeastExponent,
	binary32Max,
	binary32Precision,
	type CanonicalFloat,
	canonicalZero
} from "#compiler/ir/carriers.ts"

export { type CanonicalFloat, canonicalZero }

/**
 * Binary32 rounding with the one zero: Math.fround, then -0 as +0. NaN and the infinities are kept. This is the
 * float8-to-float4 cast on every value the cast admits; where the cast raises 22003, fround yields the IEEE result
 * instead (a signed infinity on overflow, +0 on underflow), and `toReal` turns that into the refusal.
 */
export const fround = (x: number): CanonicalFloat => canonicalZero(Math.fround(x))

/** A double precision value: any JavaScript number, -0 as +0. */
export const toDouble = (x: unknown): Result.Result<CanonicalFloat, ValueFault> =>
	typeof x === "number" ? Result.ok(canonicalZero(x)) : Result.err("floatType")

/** A real value: the binary32 number PostgreSQL's float8-to-float4 cast stores for `x`, or its refusal. */
export const toReal = (x: unknown): Result.Result<CanonicalFloat, ValueFault> => {
	if (typeof x !== "number") {
		return Result.err("floatType")
	}
	const rounded = fround(x)
	if (!Number.isFinite(rounded) && Number.isFinite(x)) {
		return Result.err("realOverflow")
	}
	if (rounded === 0 && x !== 0) {
		return Result.err("realUnderflow")
	}
	return Result.ok(rounded)
}

/**
 * Float semantics of pg.real and pg["double precision"].
 *
 * grizzle follows PostgreSQL, not IEEE 754 and not JavaScript:
 *
 * - NaN = NaN, and NaN sorts above every other value, +Infinity included (float4_cmp_internal, float8_cmp_internal).
 * - -0 = +0, and they are one value for keys, DISTINCT and grouping. The carrier canonicalizes -0 to +0, so the host
 *   never holds the second spelling of the one value (-0 is canonicalized on encode).
 *
 * A real is binary32. A host binary64 number is not the final real value: `toReal` rounds it to nearest
 * even as PostgreSQL's float8-to-float4 cast does (dtof), and refuses what that cast refuses: a finite value that
 * overflows to infinity and a nonzero value that underflows to zero. Subnormal binary32 results are admitted. The real
 * value is then exactly a binary32 number, so its shortest JavaScript text names it exactly to PostgreSQL's float4
 * input, and the double-rounding of a binary64 decimal through strtof never arises.
 *
 * PostgreSQL's float total order: -Infinity < finite values < +Infinity < NaN, NaN = NaN, -0 = +0.
 */
export const compareFloat = (a: number, b: number): -1 | 0 | 1 => {
	const aNaN = Number.isNaN(a)
	const bNaN = Number.isNaN(b)
	if (aNaN || bNaN) {
		return aNaN === bNaN ? 0 : aNaN ? 1 : -1
	}
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The text form of pg.real, pg["double precision"] and vector components, and the value's one text: "NaN",
 * "Infinity", "-Infinity", or the shortest round-trip decimal, -0 written as 0. Equal floats have equal texts, and
 * distinct binary64 values distinct texts, so it is the float's fact identity.
 *
 * A double precision value travels as its shortest round-trip decimal (JavaScript's number text), which PostgreSQL's
 * float8in (strtod) reads back as exactly the same binary64 value. A real value is binary32-exact on the host
 * (toReal), so the shortest round-trip text of that value read as a double names it exactly; float4in and pgvector's
 * vector_in (strtof) read the text as exactly the binary32 value, never double-rounding a float32 midpoint.
 */
export const floatText = (x: number): string => String(canonicalZero(x))

/** 2^p and 2^(p - 1): a normal binary32 significand q lies in [2^(p - 1), 2^p). */
const significandEnd = 1n << BigInt(binary32Precision.value)
const significandStart = 1n << BigInt(binary32Precision.value - 1)

/**
 * The decimal exponent at or below which a decimal of `digits + exponent` lies below half the least subnormal,
 * 2^(least - 1), and rounds to zero: floor((least - 1) · log10(2)).
 */
const zeroExponent = Math.floor((binary32LeastExponent.value - 1) * Math.log10(2))

const bitLength = (x: bigint): number => (x === 0n ? 0 : x.toString(2).length)

/**
 * The binary32 value nearest to `coefficient * 10^exponent` (coefficient >= 0), ties to even, as a JavaScript number:
 * a subnormal when the value is that small, 0 when it rounds below the smallest subnormal's half, and Infinity when it
 * rounds above the largest finite value. The sign is the caller's.
 *
 * A value of more integer digits than binary32Digits, at least 10^binary32Digits, lies past the greatest finite value
 * and rounds to infinity; one below 10^zeroExponent lies below half the least subnormal and rounds to zero. Otherwise
 * the binary exponent e is the one with 2^(p - 1) <= num / (den · 2^e) < 2^p, or the least for a subnormal, and the
 * quotient q, at most 2^p, is rounded half to even; q · 2^e is then exact in binary64.
 *
 * Reading PostgreSQL's float output. PostgreSQL writes floats as the shortest decimal that round-trips in the column's
 * own precision only when extra_float_digits is positive; at 0 or below it writes a valid float text of fewer digits
 * that names a different value, which no reader can detect, so every login pins extra_float_digits = 1 and
 * session verification checks it. Under that setting a real's text is the shortest text naming its binary32 value,
 * which is usually not the binary64 text of that value. Number(text) followed by Math.fround would round twice, so a
 * real text is converted exactly: the decimal is a rational, and it is rounded once, to nearest even binary32, with
 * subnormals (decimalToBinary32). A double precision text is read by Number, which rounds correctly to binary64.
 *
 * The conversions trust the text: it is PostgreSQL's own float4out, float8out or vector_out spelling of a stored value,
 * so nothing is checked.
 */
export const decimalToBinary32 = (coefficient: bigint, exponent: number): number => {
	if (coefficient === 0n) {
		return 0
	}
	const digits = coefficient.toString().length
	if (digits + exponent > binary32Digits.value) {
		return Number.POSITIVE_INFINITY
	}
	if (digits + exponent < zeroExponent) {
		return 0
	}
	const num = exponent >= 0 ? coefficient * 10n ** BigInt(exponent) : coefficient
	const den = exponent >= 0 ? 1n : 10n ** BigInt(-exponent)
	let e = Math.max(
		bitLength(num) - bitLength(den) - binary32Precision.value,
		binary32LeastExponent.value
	)
	for (;;) {
		const n = e < 0 ? num << BigInt(-e) : num
		const d = e > 0 ? den << BigInt(e) : den
		let q = n / d
		if (q >= significandEnd) {
			e++
			continue
		}
		if (q < significandStart && e > binary32LeastExponent.value) {
			e--
			continue
		}
		const r2 = (n - q * d) * 2n
		if (r2 > d || (r2 === d && (q & 1n) === 1n)) {
			q++
		}
		const value = Number(q) * 2 ** e
		return value > binary32Max.value ? Number.POSITIVE_INFINITY : value
	}
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39

/**
 * The binary32 value of the finite decimal text text[from, to): an optional minus sign, digits, an optional fraction
 * and an optional exponent (e, an optional sign, digits), -0 as +0.
 *
 * A per-row hot path, run on every real and every vector component a statement returns: it reads code units in place
 * and allocates only the digit text the exact binary32 rounding reads.
 */
const finiteBinary32 = (text: string, from: number, to: number): number => {
	let i = from
	const negative = text.charCodeAt(i) === 0x2d
	if (negative) {
		i++
	}
	const intStart = i
	while (i < to && isDigit(text.charCodeAt(i))) {
		i++
	}
	let digits = text.slice(intStart, i)
	/**
	 * The exponent marker, then its optional sign.
	 */
	let exponent = 0
	if (i < to && text.charCodeAt(i) === 0x2e) {
		const fracStart = ++i
		while (i < to && isDigit(text.charCodeAt(i))) {
			i++
		}
		digits += text.slice(fracStart, i)
		exponent = fracStart - i
	}
	if (i < to) {
		i++
		const expNegative = text.charCodeAt(i) === 0x2d
		if (expNegative || text.charCodeAt(i) === 0x2b) {
			i++
		}
		let magnitude = 0
		for (; i < to; i++) {
			magnitude = magnitude * 10 + (text.charCodeAt(i) - 0x30)
		}
		exponent += expNegative ? -magnitude : magnitude
	}
	const magnitude = decimalToBinary32(BigInt(digits), exponent)
	return canonicalZero(negative ? -magnitude : magnitude)
}

/** float8out text: its binary64 value, -0 as +0. Number reads NaN, Infinity and -Infinity as those values. */
export const convertDouble = (text: string): number => canonicalZero(Number(text))

/** float4out text: its binary32 value exactly, -0 as +0; NaN, Infinity and -Infinity by their first letter. */
export const convertReal = (text: string): number => {
	const negative = text.charCodeAt(0) === 0x2d
	const lead = text.charCodeAt(negative ? 1 : 0)
	if (lead === 0x4e) {
		return Number.NaN
	}
	if (lead === 0x49) {
		return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
	}
	return finiteBinary32(text, 0, text.length)
}

/**
 * A vector_out component text, text[from, to): its binary32 value exactly, -0 as +0 (pgvector writes finite components
 * only).
 */
export const convertComponent = (text: string, from: number, to: number): number =>
	finiteBinary32(text, from, to)
