import * as Result from "#compiler/core/result.ts"
import { fromUnits, type NumericResult } from "#compiler/scalar/compute/numeric.ts"
import type { Undefined } from "#compiler/scalar/compute/registry.ts"
import {
	compareDecimal,
	Decimal,
	type DecimalParts,
	type FiniteParts,
	roundedUnits
} from "#compiler/scalar/values/decimal.ts"

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

/** The signed unscaled value of a finite value at its least scale. */
const units = (p: FiniteParts): bigint => (p.negative ? -p.coefficient : p.coefficient)

const at = (p: FiniteParts, scale: number): bigint => units(p) * pow10(scale - p.minScale)

const ok = (d: Decimal): NumericResult => Result.ok(d)

/**
 * The weight (in NBASE digits) of a finite nonzero value: |v| = first * 10000^weight + rest, first a nonzero NBASE
 * digit.
 */
const weightOf = (p: FiniteParts): number => {
	if (p.coefficient === 0n) {
		return 0
	}
	/** The decimal exponent of the leading digit. */
	const exponent = p.coefficient.toString().length - 1 - p.minScale
	return Math.floor(exponent / decDigits)
}

const clampScale = (scale: number): number =>
	Math.min(Math.max(scale, -maxResultScale), maxResultScale)

/**
 * The oracle's numeric functions beyond the total fragment's arithmetic, over the exact Decimal carrier: rounding,
 * truncation, ceiling and floor, gcd and lcm, the square root, width_bucket and min_scale.
 *
 * Each function computes the value the named function of src/backend/utils/adt/numeric.c returns over operands in
 * their one form, trim_scale(x), the operands SQL rendering gives every display-scale reading (registry.ts
 * OperandReading): where numeric.c reads a display scale (sqrt's result scale) this reads the least scale. sqrt rounds
 * the exact root at the scale numeric_sqrt picks; every other operation is exact. The total fragment's arithmetic
 * (+, -, *, /, %, div, neg, abs, sign) is src's (scalar/compute/numeric.ts), which the ContractLiteral check runs.
 * test/pg/compute compares every function with PostgreSQL on generated operands, padded ones among them.
 *
 * numeric_round(a, s): half away from zero at scale s.
 */
export const round = (a: Decimal, scale: number): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const s = clampScale(scale)
	const rounded = roundedUnits(a, s)
	return s >= 0 ? fromUnits(rounded, s) : fromUnits(rounded * pow10(-s), 0)
}

/** numeric_trunc(a, s): toward zero at scale s. */
export const trunc = (a: Decimal, scale: number): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const p = a.parts
	const s = clampScale(scale)
	const value = units(p)
	if (s >= p.minScale) {
		return fromUnits(value * pow10(s - p.minScale), Math.max(s, 0))
	}
	const divisor = pow10(p.minScale - s)
	const truncated = value / divisor
	return s >= 0 ? fromUnits(truncated, s) : fromUnits(truncated * pow10(-s), 0)
}

/** numeric_ceil and numeric_floor: an integer. */
export const ceil = (a: Decimal): NumericResult => {
	if (!a.isFinite()) {
		return ok(a)
	}
	const divisor = pow10(a.parts.minScale)
	const value = units(a.parts)
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
	const divisor = pow10(a.parts.minScale)
	const value = units(a.parts)
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

/** numeric_gcd: the largest positive value dividing both exactly; NaN for any special. */
export const gcd = (a: Decimal, b: Decimal): NumericResult => {
	if (!a.isFinite() || !b.isFinite()) {
		return ok(Decimal.nan)
	}
	const scale = Math.max(a.parts.minScale, b.parts.minScale)
	return fromUnits(gcdBig(at(a.parts, scale), at(b.parts, scale)), scale)
}

/** numeric_lcm: abs(a / gcd(a, b) * b), zero when either is zero. */
export const lcm = (a: Decimal, b: Decimal): NumericResult => {
	if (!a.isFinite() || !b.isFinite()) {
		return ok(Decimal.nan)
	}
	const scale = Math.max(a.parts.minScale, b.parts.minScale)
	const x = at(a.parts, scale)
	const y = at(b.parts, scale)
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
 * numeric_sqrt of trim_scale(a): the root rounded half up at the scale that gives NUMERIC_MIN_SIG_DIGITS significant
 * digits, never less than the operand's least scale; a negative operand is undefined ("nonnegative").
 */
export const sqrt = (a: Decimal): NumericResult => {
	const p = a.parts
	switch (p.kind) {
		case "nan":
		case "infinity":
			return ok(a)
		case "-infinity":
			return Result.err("nonnegative")
		case "finite":
			break
	}
	if (p.negative) {
		return Result.err("nonnegative")
	}
	const weight = weightOf(p)
	/** sweight = (weight + 1) * DEC_DIGITS / 2 - 1, in C integer arithmetic. */
	const sweight = Math.trunc(((weight + 1) * decDigits) / 2) - 1
	let rscale = minSigDigits - sweight
	rscale = Math.max(rscale, p.minScale, 0)
	rscale = Math.min(rscale, maxDisplayScale)
	/**
	 * sqrt(A / 10^sa) * 10^r = sqrt(A * 10^(2r - sa)). The exponent is negative when the scale was capped at
	 * NUMERIC_MAX_DISPLAY_SCALE below the operand's: floor(sqrt(x)) is isqrt(floor(x)), and the half-up test compares
	 * 4x with (2s + 1)^2 exactly.
	 */
	const k = 2 * rscale - p.minScale
	const divisor = k < 0 ? pow10(-k) : 1n
	const m = k >= 0 ? p.coefficient * pow10(k) : p.coefficient
	const s = isqrt(m / divisor)
	const rounded = 4n * m >= (2n * s + 1n) * (2n * s + 1n) * divisor ? s + 1n : s
	return fromUnits(rounded, rscale)
}

/** numeric_min_scale: the least scale that writes the value exactly, undefined ("finite") for NaN and the infinities. */
export const minScaleOf = (a: Decimal): Result.Result<number, Undefined> =>
	a.isFinite() ? Result.ok(a.parts.minScale) : Result.err("finite")

const int4Min = -2147483648n
const int4Max = 2147483647n

/**
 * width_bucket_numeric(operand, low, high, count): the 1-based bucket of an equi-width histogram, 0 below the range
 * and count + 1 at or above it, for either bound order; undefined ("bucketDomain") for a nonpositive count, an
 * infinite or NaN bound, equal bounds, and a count + 1 that leaves integer.
 *
 * PostgreSQL 19 admits a NaN or infinite operand, which cmp_numerics orders above (or at the ends of) the range.
 */
export const widthBucket = (
	x: Decimal,
	low: Decimal,
	high: Decimal,
	count: bigint
): Result.Result<bigint, Undefined> => {
	if (count <= 0n) {
		return Result.err("bucketDomain")
	}
	const l = low.parts
	const h = high.parts
	if (l.kind !== "finite" || h.kind !== "finite") {
		return Result.err("bucketDomain")
	}
	const order = compareDecimal(low, high)
	if (order === 0) {
		return Result.err("bucketDomain")
	}
	const bucket = bucketOf(x.parts, l, h, order, count)
	return bucket < int4Min || bucket > int4Max ? Result.err("bucketDomain") : Result.ok(bucket)
}

/**
 * The bucket of `x` between finite bounds of `order`: NaN and +Infinity, ordered above every finite value, past the
 * high end of an ascending range and below a descending one's start, and -Infinity the other way. A finite `x`
 * strictly inside the range is in bucket floor((x - low) * count / (high - low)) + 1, whose quotient is nonnegative.
 */
const bucketOf = (
	x: DecimalParts,
	low: FiniteParts,
	high: FiniteParts,
	order: -1 | 1,
	count: bigint
): bigint => {
	switch (x.kind) {
		case "nan":
		case "infinity":
			return order < 0 ? count + 1n : 0n
		case "-infinity":
			return order < 0 ? 0n : count + 1n
		case "finite": {
			const scale = Math.max(x.minScale, low.minScale, high.minScale)
			const xl = at(x, scale) - at(low, scale)
			const xh = at(x, scale) - at(high, scale)
			if (order < 0 ? xl < 0n : xl > 0n) {
				return 0n
			}
			if (order < 0 ? xh >= 0n : xh <= 0n) {
				return count + 1n
			}
			return (xl * count) / (at(high, scale) - at(low, scale)) + 1n
		}
	}
}
