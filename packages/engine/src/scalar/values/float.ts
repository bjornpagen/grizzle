import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isAsciiDigit } from "@bjornpagen/grizzle-text/text"
import type { ValueFault } from "#compiler/core/errors.ts"

/**
 * IEEE 754-2019's binary32 format, the real, a vector component and pgvector's accumulators: its precision p, the bits
 * of its significand.
 *
 * @limitKind published
 * @owner IEEE 754-2019 binary32
 * @unit bits
 * @scope the significand of every real value and vector component
 * @constraint protocol constant
 * @source https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html#jls-4.2.3
 * @quote Table 4.2.3-A. Floating-point parameters. N: float 24, double 53
 * @verified 2026-11-05
 */
export const binary32Precision = 24

/**
 * binary32's greatest exponent, emax.
 *
 * @limitKind published
 * @owner IEEE 754-2019 binary32
 * @unit a binary exponent
 * @scope the exponent of every finite real value and vector component
 * @constraint protocol constant
 * @source https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html#jls-4.2.3
 * @quote Table 4.2.3-A. Floating-point parameters. Emax: float +127, double +1023
 * @verified 2026-11-05
 */
export const binary32MaxExponent = 127

/**
 * binary32's least normal exponent, emin.
 *
 * @limitKind published
 * @owner IEEE 754-2019 binary32
 * @unit a binary exponent
 * @scope the exponent of every normal real value and vector component
 * @constraint protocol constant
 * @source https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html#jls-4.2.3
 * @quote Table 4.2.3-A. Floating-point parameters. Emin: float -126, double -1022
 * @verified 2026-11-05
 */
export const binary32MinExponent = -126

/** The greatest finite value of a format of precision p and greatest exponent emax: (2 - 2^(1-p)) * 2^emax, exactly. */
export const greatestFinite = (p: number, emax: number): bigint =>
	2n ** BigInt(emax + 1) - 2n ** BigInt(emax + 1 - p)

/**
 * The greatest finite binary32 value, (2 - 2^-23) * 2^127.
 *
 * @limitKind derived
 * @owner IEEE 754-2019 binary32
 * @unit a real value
 * @scope every finite real value and vector component
 * @derivation (2 - 2^(1-p)) * 2^emax, the all-ones significand at the greatest exponent
 * @from {@link binary32Precision}, {@link binary32MaxExponent}
 */
export const binary32Max = Number(greatestFinite(binary32Precision, binary32MaxExponent))

/**
 * The binary exponent of binary32's least subnormal's one bit, emin - p + 1: 2^-149.
 *
 * @limitKind derived
 * @owner IEEE 754-2019 binary32
 * @unit a binary exponent
 * @scope the least nonzero magnitude of a real value and vector component
 * @derivation emin - p + 1: the least significant bit of a subnormal at the least exponent
 * @from {@link binary32Precision}, {@link binary32MinExponent}
 */
export const binary32LeastExponent = binary32MinExponent - binary32Precision + 1

/**
 * The integer digits of every finite binary32 value, |x| < 10^binary32Digits.
 *
 * @limitKind derived
 * @owner IEEE 754-2019 binary32
 * @unit decimal digits
 * @scope the integer digits of every finite real value
 * @derivation the decimal length of the greatest finite value, an integer
 * @from {@link binary32Precision}, {@link binary32MaxExponent}
 */
export const binary32Digits = String(greatestFinite(binary32Precision, binary32MaxExponent)).length

/**
 * Binary32 rounding: Math.fround, each zero its own sign, NaN and the infinities kept. This is the float8-to-float4
 * cast on every value the cast admits; where the cast raises 22003, fround yields the IEEE result instead (a signed
 * infinity on overflow, a signed zero on underflow), and `toReal` turns that into the refusal.
 */
export const fround = (x: number): number => Math.fround(x)

/** A double precision value: any JavaScript number, -0 a value of its own. */
export const toDouble = (x: unknown): Result.Result<number, ValueFault> =>
	typeof x === "number" ? Result.ok(x) : Result.err("floatType")

/**
 * A caller's real parsed exactly: a number that is a binary32 value as it is, NaN, the infinities and either zero
 * included; any other is realInexact, never rounded as PostgreSQL's float8-to-float4 cast would round it (toReal).
 */
export const parseReal = (x: unknown): Result.Result<number, ValueFault> => {
	if (typeof x !== "number") {
		return Result.err("floatType")
	}
	const real = fround(x)
	return real === x || Number.isNaN(x) ? Result.ok(real) : Result.err("realInexact")
}

/**
 * A real value: the binary32 number PostgreSQL's float8-to-float4 cast stores for `x`, or its refusal. This is the
 * coercion of a value PostgreSQL computes or a literal it casts; a caller's value is parsed exactly instead (parseReal).
 */
export const toReal = (x: unknown): Result.Result<number, ValueFault> => {
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
 * Float semantics of float4 and float8.
 *
 * grizzle follows PostgreSQL, not IEEE 754 and not JavaScript:
 *
 * - NaN = NaN, and NaN sorts above every other value, +Infinity included (float4_cmp_internal, float8_cmp_internal).
 * - -0 = +0 for every comparison, the evaluator's `=` and order, a law's, a match's, PostgreSQL's float8eq and
 *   float8_cmp_internal; yet -0 is a value of its own, distinct from +0 as IEEE 754 and xs:double (XSD 1.1, which sets
 *   equality apart from identity) hold it: the host keeps its sign end to end, admitted, sent ("-0"), read back and
 *   computed, so 1/x, min and max read the value stored. A fact's identity is its values', so a fact of -0 and one of
 *   +0 are two facts. A stored response value is never NaN, so NaN's identity, one of many bit patterns, is none
 *   grizzle states.
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
 * The text form of float4 and float8, and the value's one text: "NaN", "Infinity", "-Infinity", "-0",
 * or the shortest round-trip decimal. Distinct binary64 values have distinct texts, -0 and +0 among them, NaN one text,
 * so it is the float's fact identity, and float4in and float8in read it as exactly the value, its zero's sign kept.
 *
 * A double precision value travels as its shortest round-trip decimal (JavaScript's number text), which PostgreSQL's
 * float8in (strtod) reads back as exactly the same binary64 value. A real value is binary32-exact on the host
 * (toReal), so the shortest round-trip text of that value read as a double names it exactly; float4in and pgvector's
 * vector_in (strtof) read the text as exactly the binary32 value, never double-rounding a float32 midpoint.
 */
export const floatText = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))

/** 2^p and 2^(p - 1): a normal binary32 significand q lies in [2^(p - 1), 2^p). */
const significandEnd = 1n << BigInt(binary32Precision)
const significandStart = 1n << BigInt(binary32Precision - 1)

/**
 * The decimal exponent at or below which a decimal of `digits + exponent` lies below half the least subnormal,
 * 2^(least - 1), and rounds to zero: floor((least - 1) · log10(2)).
 */
const zeroExponent = Math.floor((binary32LeastExponent - 1) * Math.log10(2))

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
	if (digits + exponent > binary32Digits) {
		return Number.POSITIVE_INFINITY
	}
	if (digits + exponent < zeroExponent) {
		return 0
	}
	const num = exponent >= 0 ? coefficient * 10n ** BigInt(exponent) : coefficient
	const den = exponent >= 0 ? 1n : 10n ** BigInt(-exponent)
	let e = Math.max(bitLength(num) - bitLength(den) - binary32Precision, binary32LeastExponent)
	for (;;) {
		const n = e < 0 ? num << BigInt(-e) : num
		const d = e > 0 ? den << BigInt(e) : den
		let q = n / d
		if (q >= significandEnd) {
			e++
			continue
		}
		if (q < significandStart && e > binary32LeastExponent) {
			e--
			continue
		}
		const r2 = (n - q * d) * 2n
		if (r2 > d || (r2 === d && (q & 1n) === 1n)) {
			q++
		}
		const value = Number(q) * 2 ** e
		return value > binary32Max ? Number.POSITIVE_INFINITY : value
	}
}

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
	while (i < to && isAsciiDigit(text.charCodeAt(i))) {
		i++
	}
	let digits = text.slice(intStart, i)
	/**
	 * The exponent marker, then its optional sign.
	 */
	let exponent = 0
	if (i < to && text.charCodeAt(i) === 0x2e) {
		const fracStart = ++i
		while (i < to && isAsciiDigit(text.charCodeAt(i))) {
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
	return negative ? -magnitude : magnitude
}

/** float8out text: its binary64 value, -0 its own. Number reads NaN, Infinity and -Infinity as those values. */
export const convertDouble = (text: string): number => Number(text)

/** float4out text: its binary32 value exactly, -0 its own; NaN, Infinity and -Infinity by their first letter. */
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
 * A vector_out component text, text[from, to): its binary32 value exactly, -0 as +0, since a vector component's -0 is a
 * spelling of 0 (scalar/values/vector.ts), where a real's is a value of its own (pgvector writes finite components
 * only).
 */
export const convertComponent = (text: string, from: number, to: number): number => {
	const x = finiteBinary32(text, from, to)
	return x === 0 ? 0 : x
}
