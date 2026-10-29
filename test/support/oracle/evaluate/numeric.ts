import * as Result from "#compiler/core/result.ts"
import { fromUnits, type NumericResult } from "#compiler/scalar/compute/numeric.ts"
import type { FailureCode } from "#compiler/scalar/compute/registry.ts"
import { compareDecimal, Decimal, roundedUnits } from "#compiler/scalar/values/decimal.ts"

/** numeric.c's constants. */
/** NUMERIC_MIN_SIG_DIGITS */
const minSigDigits = 16
/** NUMERIC_MAX_DISPLAY_SCALE */
const maxDisplayScale = 1000
/** NUMERIC_MAX_RESULT_SCALE */
const maxResultScale = 2000
/** DEC_DIGITS: one NBASE digit is four decimal digits */
const decDigits = 4

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** The signed unscaled value of a finite Decimal at its own display scale. */
const units = (d: Decimal): bigint => (d.negative ? -d.coefficient : d.coefficient)

const at = (d: Decimal, scale: number): bigint => units(d) * pow10(scale - d.scale)

const ok = (d: Decimal): NumericResult => Result.ok(d)

/**
 * The weight (in NBASE digits) of a finite nonzero value: |v| = first * 10000^weight + rest, first a nonzero NBASE
 * digit.
 */
const weightOf = (d: Decimal): number => {
	if (d.coefficient === 0n) {
		return 0
	}
	/** The decimal exponent of the leading digit. */
	const exponent = d.coefficient.toString().length - 1 - d.scale
	return Math.floor(exponent / decDigits)
}

const clampScale = (scale: number): number =>
	Math.min(Math.max(scale, -maxResultScale), maxResultScale)

/**
 * The oracle's numeric functions beyond the total fragment's arithmetic, over the exact Decimal carrier: rounding,
 * truncation, ceiling and floor, gcd and lcm, the square root, width_bucket and the scale functions.
 *
 * Each function computes exactly what the named function of src/backend/utils/adt/numeric.c returns, display scale
 * included, because scale(), min_scale() and the raw text observe it. sqrt rounds the exact root at the scale
 * numeric_sqrt picks; every other operation is exact. The total fragment's arithmetic (+, -, *, /, %, div, neg, abs,
 * sign) is src's (scalar/compute/numeric.ts), which the ContractLiteral check runs. test/pg/compute compares every
 * function with PostgreSQL on generated operands.
 *
 * numeric_round(a, s): half away from zero at scale s, displayed at max(s, 0).
 */
export const round = (a: Decimal, scale: number): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const s = clampScale(scale)
	const rounded = roundedUnits(a, s)
	return s >= 0 ? fromUnits(rounded, s) : fromUnits(rounded * pow10(-s), 0)
}

/** numeric_trunc(a, s): toward zero at scale s, displayed at max(s, 0). */
export const trunc = (a: Decimal, scale: number): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const s = clampScale(scale)
	const value = units(a)
	if (s >= a.scale) {
		return fromUnits(value * pow10(s - a.scale), Math.max(s, 0))
	}
	const divisor = pow10(a.scale - s)
	const truncated = value / divisor
	return s >= 0 ? fromUnits(truncated, s) : fromUnits(truncated * pow10(-s), 0)
}

/** numeric_ceil and numeric_floor: display scale 0. */
export const ceil = (a: Decimal): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const divisor = pow10(a.scale)
	const value = units(a)
	let q = value / divisor
	if (value % divisor !== 0n && value > 0n) {
		q += 1n
	}
	return fromUnits(q, 0)
}

export const floor = (a: Decimal): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const divisor = pow10(a.scale)
	const value = units(a)
	let q = value / divisor
	if (value % divisor !== 0n && value < 0n) {
		q -= 1n
	}
	return fromUnits(q, 0)
}

/** The nonnegative greatest common divisor of two integers. */
export const gcdBig = (x: bigint, y: bigint): bigint => {
	let a = x < 0n ? -x : x
	let b = y < 0n ? -y : y
	while (b !== 0n) {
		;[a, b] = [b, a % b]
	}
	return a
}

/** numeric_gcd: the largest positive value dividing both exactly, at the larger display scale; NaN for any special. */
export const gcd = (a: Decimal, b: Decimal): NumericResult => {
	if (!a.isFinite() || !b.isFinite()) {
		return ok(Decimal.nan)
	}
	const scale = Math.max(a.scale, b.scale)
	return fromUnits(gcdBig(at(a, scale), at(b, scale)), scale)
}

/** numeric_lcm: abs(a / gcd(a, b) * b), zero when either is zero, at the larger display scale. */
export const lcm = (a: Decimal, b: Decimal): NumericResult => {
	if (!a.isFinite() || !b.isFinite()) {
		return ok(Decimal.nan)
	}
	const scale = Math.max(a.scale, b.scale)
	const x = at(a, scale)
	const y = at(b, scale)
	if (x === 0n || y === 0n) {
		return fromUnits(0n, scale)
	}
	const product = (x / gcdBig(x, y)) * y
	return fromUnits(product < 0n ? -product : product, scale)
}

/** The integer square root: Newton's method from a power of two at or above the root, which descends to the floor. */
export const isqrt = (n: bigint): bigint => {
	if (n < 2n) {
		return n
	}
	let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2))
	for (;;) {
		const y = (x + n / x) >> 1n
		if (y >= x) {
			return x
		}
		x = y
	}
}

/**
 * numeric_sqrt: the root rounded half up at the scale that gives NUMERIC_MIN_SIG_DIGITS significant digits, never
 * less than the input's display scale; a negative operand is 2201F.
 */
export const sqrt = (a: Decimal): NumericResult => {
	if (a.isNaN()) {
		return ok(a)
	}
	if (a.kind === "-infinity") {
		return Result.err("2201F")
	}
	if (a.kind === "infinity") {
		return ok(a)
	}
	if (a.negative && a.coefficient !== 0n) {
		return Result.err("2201F")
	}
	const weight = weightOf(a)
	/** sweight = (weight + 1) * DEC_DIGITS / 2 - 1, in C integer arithmetic. */
	const sweight = Math.trunc(((weight + 1) * decDigits) / 2) - 1
	let rscale = minSigDigits - sweight
	rscale = Math.max(rscale, a.scale, 0)
	rscale = Math.min(rscale, maxDisplayScale)
	/**
	 * sqrt(A / 10^sa) * 10^r = sqrt(A * 10^(2r - sa)). The exponent is negative when the display scale was capped at
	 * NUMERIC_MAX_DISPLAY_SCALE below the input's: floor(sqrt(x)) is isqrt(floor(x)), and the half-up test compares
	 * 4x with (2s + 1)^2 exactly.
	 */
	const k = 2 * rscale - a.scale
	const divisor = k < 0 ? pow10(-k) : 1n
	const m = k >= 0 ? a.coefficient * pow10(k) : a.coefficient
	const s = isqrt(m / divisor)
	const rounded = 4n * m >= (2n * s + 1n) * (2n * s + 1n) * divisor ? s + 1n : s
	return fromUnits(rounded, rscale)
}

/** The same finite value at its minimal display scale: trailing fractional zeros dropped. */
const minimalScale = (a: Decimal): number => {
	let c = a.coefficient
	let s = a.scale
	if (c === 0n) {
		return 0
	}
	while (s > 0 && c % 10n === 0n) {
		c /= 10n
		s--
	}
	return s
}

/** numeric_trim_scale: the same value at its minimal display scale; NaN and the infinities unchanged. */
export const trimScale = (a: Decimal): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const s = minimalScale(a)
	return fromUnits(units(a) / pow10(a.scale - s), s)
}

/**
 * numeric_scale and numeric_min_scale: the display scale and the minimal one, NULL (the "null" failure) for NaN and
 * the infinities.
 */
export const scaleOf = (a: Decimal): Result.Result<number, FailureCode> =>
	a.isFinite() ? Result.ok(a.scale) : Result.err("null")

export const minScaleOf = (a: Decimal): Result.Result<number, FailureCode> =>
	a.isFinite() ? Result.ok(minimalScale(a)) : Result.err("null")

const int4Min = -2147483648n
const int4Max = 2147483647n

/**
 * width_bucket_numeric(operand, low, high, count): the 1-based bucket of an equi-width histogram, 0 below the range
 * and count + 1 at or above it, for either bound order; 2201G for a nonpositive count, a NaN, an infinite bound or
 * equal bounds, and 22003 when count + 1 leaves integer.
 *
 * PostgreSQL 19 admits a NaN or infinite operand, which cmp_numerics orders above (or at the ends of) the range.
 */
export const widthBucket = (
	x: Decimal,
	low: Decimal,
	high: Decimal,
	count: bigint
): Result.Result<bigint, FailureCode> => {
	if (count <= 0n) {
		return Result.err("2201G")
	}
	if (low.isNaN() || high.isNaN()) {
		return Result.err("2201G")
	}
	if (low.isInfinite() || high.isInfinite()) {
		return Result.err("2201G")
	}
	const order = compareDecimal(low, high)
	if (order === 0) {
		return Result.err("2201G")
	}
	let bucket: bigint
	const xl = compareDecimal(x, low)
	const xh = compareDecimal(x, high)
	if (order < 0 ? xl < 0 : xl > 0) {
		bucket = 0n
	} else if (order < 0 ? xh >= 0 : xh <= 0) {
		bucket = count + 1n
	} else {
		/** floor((x - low) * count / (high - low)) + 1, both factors finite here; the quotient is nonnegative. */
		const scale = Math.max(x.scale, low.scale, high.scale)
		const num = (at(x, scale) - at(low, scale)) * count
		const den = at(high, scale) - at(low, scale)
		bucket = num / den + 1n
	}
	return bucket < int4Min || bucket > int4Max ? Result.err("22003") : Result.ok(bucket)
}
