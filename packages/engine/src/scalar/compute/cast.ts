import * as Result from "#compiler/core/result.ts"
import { fromUnits, toInteger } from "#compiler/scalar/compute/numeric.ts"
import type { Undefined } from "#compiler/scalar/compute/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { fround } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"

export type IntCarrier = "int2" | "int4" | "int8"

const intRange: { readonly [C in IntCarrier]: readonly [bigint, bigint] } = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-(2n ** 63n), 2n ** 63n - 1n]
}

type IntResult = Result.Result<bigint, Undefined>

/** An exact integer narrowed into an integer carrier: defined where it fits. */
const inIntRange = (value: bigint, c: IntCarrier): IntResult => {
	const [lo, hi] = intRange[c]
	return value < lo || value > hi ? Result.err("fits") : Result.ok(value)
}

const pow2 = (n: number): bigint => 1n << BigInt(n)

const bitLength = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length)

const floatFormat = {
	float4: { bits: 24, minExp: -126, maxExp: 127 },
	float8: { bits: 53, minExp: -1022, maxExp: 1023 }
} as const

/**
 * The nearest binary value of `width` to the positive rational num / den, ties to even, subnormals included; Infinity
 * past the largest finite value and 0 below half the smallest subnormal.
 */
const roundRational = (num: bigint, den: bigint, width: "float4" | "float8"): number => {
	if (num === 0n) {
		return 0
	}
	const { bits, minExp, maxExp } = floatFormat[width]
	/** e such that 2^e <= num/den < 2^(e+1). */
	let e = bitLength(num) - bitLength(den)
	if (e >= 0 ? num < den << BigInt(e) : num << BigInt(-e) < den) {
		e--
	}
	/** The exponent of the last kept bit: normal values keep `bits` bits, subnormals stop at minExp - bits + 1. */
	const lsb = Math.max(e, minExp) - (bits - 1)
	/** q = num / den / 2^lsb, rounded half to even. */
	const n = lsb >= 0 ? num : num << BigInt(-lsb)
	const d = lsb >= 0 ? den << BigInt(lsb) : den
	let q = n / d
	const r = n % d
	if (r * 2n > d || (r * 2n === d && (q & 1n) === 1n)) {
		q += 1n
	}
	/** Rounding can carry into the next binade. */
	const top = lsb + bitLength(q) - 1
	if (top > maxExp) {
		return Number.POSITIVE_INFINITY
	}
	/** q and 2^lsb are both exact doubles here, and so is their product, the target value. */
	const value = lsb >= 0 ? Number(q * pow2(lsb)) : Number(q) * 2 ** lsb
	return width === "float4" ? Math.fround(value) : value
}

/**
 * An exact signed rational as a float of `width`, rounded once as IEEE 754 rounds: ±Infinity past the largest finite
 * value, the correctly rounded subnormal, and the one zero below half the least subnormal.
 */
const toFloat = (
	negative: boolean,
	num: bigint,
	den: bigint,
	width: "float4" | "float8"
): number => {
	const magnitude = roundRational(num, den, width)
	return magnitude === 0 ? 0 : negative ? -magnitude : magnitude
}

/** The exact rational value of a finite double: sign, numerator, denominator (a power of two). */
export const doubleParts = (
	x: number
): { readonly negative: boolean; readonly num: bigint; readonly den: bigint } => {
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, x)
	const hi = view.getUint32(0)
	const lo = view.getUint32(4)
	const negative = hi >>> 31 === 1
	const exponent = (hi >>> 20) & 0x7ff
	const mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
	const significand = exponent === 0 ? mantissa : mantissa | (1n << 52n)
	const e = (exponent === 0 ? 1 : exponent) - 1075
	return e >= 0
		? { negative, num: significand << BigInt(e), den: 1n }
		: { negative, num: significand, den: pow2(-e) }
}

/** Whether a >= b * 10^p, for any integer p. */
const ge = (a: bigint, b: bigint, p: number): boolean =>
	p >= 0 ? a >= b * 10n ** BigInt(p) : a * 10n ** BigInt(-p) >= b

/**
 * %.*g of a finite double as an exact Decimal: `digits` significant digits rounded half to even on the exact binary
 * value, read back by numeric_in, in the Decimal's one form.
 */
const gDecimal = (x: number, digits: number): Result.Result<Decimal, Undefined> => {
	if (x === 0) {
		return fromUnits(0n, 0)
	}
	const { negative, num, den } = doubleParts(x)
	/** k = floor(log10(num / den)). */
	let k = num.toString().length - den.toString().length
	if (!ge(num, den, k)) {
		k--
	} else if (ge(num, den, k + 1)) {
		k++
	}
	/** Scale so that the kept digits are the integer part: q = num / den * 10^(digits - 1 - k). */
	const p = digits - 1 - k
	const n = p >= 0 ? num * 10n ** BigInt(p) : num
	const d = p >= 0 ? den : den * 10n ** BigInt(-p)
	let q = n / d
	const r = n % d
	if (r * 2n > d || (r * 2n === d && (q & 1n) === 1n)) {
		q += 1n
	}
	return p >= 0
		? fromUnits(negative ? -q : q, p)
		: fromUnits((negative ? -q : q) * 10n ** BigInt(-p), 0)
}

/**
 * A host value for a cast's operand and result: integers as bigint, numeric as Decimal, floats as number, money as
 * Money.
 */
export type CastValue = bigint | Decimal | number | Money

type CastResult = Result.Result<CastValue, Undefined>

type FloatCarrier = "float4" | "float8"

/**
 * PostgreSQL's casts among the numeric family, money and the exact carriers, each defined on every value or where its
 * precondition holds (registry.ts castOverloads), the precondition a value fails named:
 *
 * - integer narrowing, an exact integer and numeric to an integer are defined where the value fits ("fits"); numeric
 *   rounds half away from zero (numeric_int4) and is defined on finite values only ("finite"), a float rounds half to
 *   even (rint in dtoi4) and likewise;
 * - an integer, an exact integer, numeric or float8 to a float rounds the exact value once to the target's binary
 *   precision as IEEE 754 does, half to even: past the largest finite value it is ±Infinity, below half the least
 *   subnormal the one zero, and NaN and the infinities are themselves;
 * - a float to numeric is the decimal its %.*g text names, FLT_DIG = 6 or DBL_DIG = 15 significant digits rounded
 *   half to even, NaN and the infinities kept (float4_numeric, float8_numeric);
 * - money is the signed 64-bit count of minor units in the fixed C.UTF-8 monetary context, two fractional digits:
 *   numeric to money rounds amount * 100 half away from zero, money to numeric is the amount exactly, and an exact
 *   integer or an exact amount into money is defined where it fits the count;
 * - an integer into an exact integer, and money into exact money, is the value itself.
 *
 * A cast's host conversion, over the host value of its source's family (literal.ts CarrierValue): each registered
 * cast carries its own (registry.ts castOverloads), and the evaluator calls it on the operand's value of that family.
 */
export type HostCast =
	| { readonly from: "integer"; readonly convert: (x: bigint) => CastResult }
	| { readonly from: "numeric"; readonly convert: (d: Decimal) => CastResult }
	| { readonly from: "float"; readonly convert: (x: number) => CastResult }
	| { readonly from: "money"; readonly convert: (m: Money) => CastResult }

/** rint: round half to even. */
const rint = (x: number): number => {
	const f = Math.floor(x)
	const diff = x - f
	if (diff < 0.5) {
		return f
	}
	if (diff > 0.5) {
		return f + 1
	}
	return f % 2 === 0 ? f : f + 1
}

/**
 * FLOAT8_FITS_IN_INT: lo <= r < -lo, compared in binary64.
 */
const floatToInt = (x: number, c: IntCarrier): IntResult => {
	if (!Number.isFinite(x)) {
		return Result.err("finite")
	}
	const r = rint(x)
	const [lo, hi] = intRange[c]
	if (r < Number(lo) || r >= -Number(lo)) {
		return Result.err("fits")
	}
	const value = BigInt(r)
	return value < lo || value > hi ? Result.err("fits") : Result.ok(value)
}

/** A numeric as a float of `width`, rounded once as IEEE 754 rounds; NaN and the infinities are themselves. */
const decimalToFloat = (d: Decimal, width: FloatCarrier): number => {
	const p = d.parts
	switch (p.kind) {
		case "nan":
			return Number.NaN
		case "infinity":
			return Number.POSITIVE_INFINITY
		case "-infinity":
			return Number.NEGATIVE_INFINITY
		case "finite":
			return toFloat(p.negative, p.coefficient, 10n ** BigInt(p.minScale), width)
	}
}

const floatToDecimal = (x: number, width: FloatCarrier): Result.Result<Decimal, Undefined> => {
	if (Number.isNaN(x)) {
		return Result.ok(Decimal.nan)
	}
	if (x === Number.POSITIVE_INFINITY) {
		return Result.ok(Decimal.infinity)
	}
	if (x === Number.NEGATIVE_INFINITY) {
		return Result.ok(Decimal.negativeInfinity)
	}
	return gDecimal(x, width === "float4" ? 6 : 15)
}

/** A count of minor units as money: defined where it fits the signed 64-bit count. */
const storedMoney = (minor: bigint): CastResult =>
	minor < intRange.int8[0] || minor > intRange.int8[1]
		? Result.err("fits")
		: Result.ok(Money.of(minor))

/** The cast of an integer or an exact integer to `target`. */
export const integerCast = (
	target: IntCarrier | "numeric" | FloatCarrier | "money" | "exactInteger"
): HostCast => {
	switch (target) {
		case "int2":
		case "int4":
		case "int8":
			return { from: "integer", convert: (x) => inIntRange(x, target) }
		case "exactInteger":
			return { from: "integer", convert: Result.ok }
		case "numeric":
			return { from: "integer", convert: (x) => fromUnits(x, 0) }
		case "float4":
		case "float8":
			return {
				from: "integer",
				convert: (x) => Result.ok(toFloat(x < 0n, x < 0n ? -x : x, 1n, target))
			}
		case "money":
			return { from: "integer", convert: (x) => storedMoney(x * 100n) }
	}
}

/**
 * The cast of a numeric to `target`. Numeric to numeric is the length coercion, the value itself: the target's typmod
 * rounds it to its scale and refuses what overflows its precision.
 */
export const numericCast = (target: IntCarrier | "numeric" | FloatCarrier | "money"): HostCast => {
	switch (target) {
		case "int2":
		case "int4":
		case "int8": {
			const [lo, hi] = intRange[target]
			return { from: "numeric", convert: (d) => toInteger(d, lo, hi) }
		}
		case "numeric":
			return { from: "numeric", convert: Result.ok }
		case "float4":
		case "float8":
			return { from: "numeric", convert: (d) => Result.ok(decimalToFloat(d, target)) }
		case "money":
			return {
				from: "numeric",
				convert: (d) => {
					/** amount * 100, then numeric_int8's rounding and its preconditions. */
					const scaled = d.isFinite()
						? Decimal.fromParts(d.parts.negative, d.parts.coefficient * 100n, d.parts.minScale)
						: Result.ok(d)
					if (!scaled.ok) {
						return Result.err("fits")
					}
					const minor = toInteger(scaled.value, intRange.int8[0], intRange.int8[1])
					return Result.map(minor, (m) => Money.of(m))
				}
			}
	}
}

/** The cast of a float of `source` to `target`. */
export const floatCast = (
	source: FloatCarrier,
	target: IntCarrier | "numeric" | FloatCarrier
): HostCast => {
	switch (target) {
		case "int2":
		case "int4":
		case "int8":
			return { from: "float", convert: (x) => floatToInt(x, target) }
		case "numeric":
			return { from: "float", convert: (x) => floatToDecimal(x, source) }
		case "float8":
			return { from: "float", convert: Result.ok }
		case "float4":
			return { from: "float", convert: (x) => Result.ok(fround(x)) }
	}
}

/**
 * The cast of money or exact money to `target`: numeric, the amount exactly, in its one form; exact money, the amount
 * itself; money, the amount where it fits the signed 64-bit count.
 */
export const moneyCast = (target: "numeric" | "money" | "exactMoney"): HostCast => {
	switch (target) {
		case "numeric":
			return { from: "money", convert: (m) => fromUnits(m.minorUnits, 2) }
		case "exactMoney":
			return { from: "money", convert: Result.ok }
		case "money":
			return { from: "money", convert: (m) => storedMoney(m.minorUnits) }
	}
}
