import * as Result from "#compiler/core/result.ts"
import type { FailureCode } from "#compiler/scalar/compute/registry.ts"
import { Decimal, numericMaxDisplayScale, roundedUnits } from "#compiler/scalar/values/decimal.ts"

/**
 * PostgreSQL numeric arithmetic over the exact Decimal carrier: the total fragment's operations and the conversion to
 * an integer.
 *
 * Each function computes exactly what the named function of src/backend/utils/adt/numeric.c returns, display scale
 * included, because division observes the display scale and raw-text results carry it. Special values follow
 * PostgreSQL 14's rules: NaN absorbs, infinities combine as numeric.c's special-value branches say, and a finite
 * division by an infinity is zero. Division rounds half away from zero at the result scale select_div_scale picks;
 * every other operation is exact. The host never substitutes JavaScript arithmetic for a SQL expression: these
 * functions exist so the compiler can evaluate a literal against a contract predicate (ContractLiteral) and cast a
 * value.
 */
export type NumericResult = Result.Result<Decimal, FailureCode>

/** numeric.c's constants. */
/** NUMERIC_MIN_SIG_DIGITS */
const minSigDigits = 16
/** NUMERIC_MAX_DISPLAY_SCALE */
const maxDisplayScale = 1000
/** DEC_DIGITS: one NBASE digit is four decimal digits. */
const decDigits = 4

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** The signed unscaled value of a finite Decimal at its own display scale. */
const units = (d: Decimal): bigint => (d.negative ? -d.coefficient : d.coefficient)

const at = (d: Decimal, scale: number): bigint => units(d) * pow10(scale - d.scale)

/** A finite Decimal from signed units at a display scale, or 22003 outside numeric's format. */
export const fromUnits = (value: bigint, scale: number): NumericResult => {
	const made = Decimal.fromParts(value < 0n, value < 0n ? -value : value, scale)
	return made.ok ? Result.ok(made.value) : Result.err("22003")
}

const ok = (d: Decimal): NumericResult => Result.ok(d)

const isPosInf = (d: Decimal): boolean => d.kind === "infinity"
const isNegInf = (d: Decimal): boolean => d.kind === "-infinity"

/** The sign of a value: -1, 0 or 1; NaN has none. */
const signOf = (d: Decimal): -1 | 0 | 1 => {
	if (isPosInf(d)) {
		return 1
	}
	if (isNegInf(d)) {
		return -1
	}
	if (d.coefficient === 0n) {
		return 0
	}
	return d.negative ? -1 : 1
}

const infinityOf = (sign: number): Decimal =>
	sign > 0 ? Decimal.infinity : Decimal.negativeInfinity

/** numeric_add. */
export const add = (a: Decimal, b: Decimal): NumericResult => {
	if (a.isNaN() || b.isNaN()) {
		return ok(Decimal.nan)
	}
	if (a.isInfinite() || b.isInfinite()) {
		if (a.isInfinite() && b.isInfinite() && a.kind !== b.kind) {
			return ok(Decimal.nan)
		}
		return ok(a.isInfinite() ? a : b)
	}
	const scale = Math.max(a.scale, b.scale)
	return fromUnits(at(a, scale) + at(b, scale), scale)
}

/** numeric_uminus. */
export const neg = (a: Decimal): NumericResult => {
	if (a.isNaN()) {
		return ok(a)
	}
	if (isPosInf(a)) {
		return ok(Decimal.negativeInfinity)
	}
	if (isNegInf(a)) {
		return ok(Decimal.infinity)
	}
	return fromUnits(-units(a), a.scale)
}

/** numeric_sub. */
export const sub = (a: Decimal, b: Decimal): NumericResult => {
	if (a.isNaN() || b.isNaN()) {
		return ok(Decimal.nan)
	}
	if (a.isInfinite() || b.isInfinite()) {
		if (a.isInfinite() && b.isInfinite() && a.kind === b.kind) {
			return ok(Decimal.nan)
		}
		if (a.isInfinite()) {
			return ok(a)
		}
		return neg(b)
	}
	const scale = Math.max(a.scale, b.scale)
	return fromUnits(at(a, scale) - at(b, scale), scale)
}

/** numeric_mul: the exact product at the sum of the display scales, rounded only past NUMERIC_DSCALE_MAX. */
export const mul = (a: Decimal, b: Decimal): NumericResult => {
	if (a.isNaN() || b.isNaN()) {
		return ok(Decimal.nan)
	}
	if (a.isInfinite() || b.isInfinite()) {
		const s = signOf(a) * signOf(b)
		return ok(s === 0 ? Decimal.nan : infinityOf(s))
	}
	const scale = a.scale + b.scale
	const product = units(a) * units(b)
	if (scale <= numericMaxDisplayScale) {
		return fromUnits(product, scale)
	}
	/**
	 * The exact product has more fractional digits than a numeric stores: round_var to NUMERIC_DSCALE_MAX, half away
	 * from zero, before make_result.
	 */
	const divisor = pow10(scale - numericMaxDisplayScale)
	const magnitude = product < 0n ? -product : product
	const rounded = magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n)
	return fromUnits(product < 0n ? -rounded : rounded, numericMaxDisplayScale)
}

/**
 * The weight (in NBASE digits) and leading NBASE digit of a finite nonzero value: |v| = first * 10000^weight + rest.
 */
const weightAndFirst = (d: Decimal): { readonly weight: number; readonly first: bigint } => {
	if (d.coefficient === 0n) {
		return { weight: 0, first: 0n }
	}
	/** The decimal exponent of the leading digit. */
	const exponent = d.coefficient.toString().length - 1 - d.scale
	const weight = Math.floor(exponent / decDigits)
	const shift = weight * decDigits - -d.scale
	/** first = floor(coefficient / 10^(weight*4 + scale)). */
	const first = shift >= 0 ? d.coefficient / pow10(shift) : d.coefficient * pow10(-shift)
	return { weight, first }
}

/** select_div_scale: at least NUMERIC_MIN_SIG_DIGITS significant digits, and never less than either display scale. */
const divScale = (a: Decimal, b: Decimal): number => {
	const x = weightAndFirst(a)
	const y = weightAndFirst(b)
	let qweight = x.weight - y.weight
	if (x.first <= y.first) {
		qweight--
	}
	let rscale = minSigDigits - qweight * decDigits
	rscale = Math.max(rscale, a.scale, b.scale, 0)
	return Math.min(rscale, maxDisplayScale)
}

/**
 * The quotient of two finite values at `scale` decimal places: rounded half away from zero, or truncated toward zero.
 */
const quotient = (a: Decimal, b: Decimal, scale: number, round: boolean): bigint => {
	/** a / b * 10^scale = (A / 10^sa) / (B / 10^sb) * 10^scale = A * 10^(sb + scale) / (B * 10^sa) */
	let num = a.coefficient
	let den = b.coefficient
	const shift = b.scale + scale - a.scale
	if (shift >= 0) {
		num *= pow10(shift)
	} else {
		den *= pow10(-shift)
	}
	let q = num / den
	if (round && (num % den) * 2n >= den) {
		q += 1n
	}
	return a.negative !== b.negative ? -q : q
}

/**
 * The special-value rules numeric_div and numeric_div_trunc share.
 *
 * A finite value over an infinity is zero.
 */
const divSpecial = (a: Decimal, b: Decimal): NumericResult | undefined => {
	if (a.isNaN() || b.isNaN()) {
		return ok(Decimal.nan)
	}
	if (a.isInfinite()) {
		if (b.isInfinite()) {
			return ok(Decimal.nan)
		}
		const s = signOf(b)
		if (s === 0) {
			return Result.err("22012")
		}
		return ok(infinityOf(signOf(a) * s))
	}
	if (b.isInfinite()) {
		return ok(Decimal.zero)
	}
	if (b.coefficient === 0n) {
		return Result.err("22012")
	}
	return undefined
}

/** numeric_div. */
export const div = (a: Decimal, b: Decimal): NumericResult => {
	const special = divSpecial(a, b)
	if (special !== undefined) {
		return special
	}
	const scale = divScale(a, b)
	return fromUnits(quotient(a, b, scale, true), scale)
}

/** numeric_div_trunc, the function div(a, b): the quotient truncated toward zero, display scale 0. */
export const divTrunc = (a: Decimal, b: Decimal): NumericResult => {
	const special = divSpecial(a, b)
	if (special !== undefined) {
		return special
	}
	return fromUnits(quotient(a, b, 0, false), 0)
}

/**
 * numeric_mod, the operator % and the function mod(a, b): a - trunc(a / b) * b, with the dividend's sign,
 * at the larger display scale.
 */
export const mod = (a: Decimal, b: Decimal): NumericResult => {
	if (a.isNaN() || b.isNaN()) {
		return ok(Decimal.nan)
	}
	if (a.isInfinite()) {
		return signOf(b) === 0 && b.isFinite() ? Result.err("22012") : ok(Decimal.nan)
	}
	if (b.isInfinite()) {
		return ok(a)
	}
	if (b.coefficient === 0n) {
		return Result.err("22012")
	}
	const scale = Math.max(a.scale, b.scale)
	const x = at(a, scale)
	const y = at(b, scale)
	return fromUnits(x % y, scale)
}

/** numeric_abs. */
export const abs = (a: Decimal): NumericResult => {
	if (a.isNaN()) {
		return ok(a)
	}
	if (a.isInfinite()) {
		return ok(Decimal.infinity)
	}
	return fromUnits(a.coefficient, a.scale)
}

/** numeric_sign: -1, 0 or 1 at display scale 0; NaN for NaN. */
export const sign = (a: Decimal): NumericResult => {
	if (a.isNaN()) {
		return ok(a)
	}
	return fromUnits(BigInt(signOf(a)), 0)
}

/**
 * numeric to an integer type (numeric_int2, numeric_int4, numeric_int8): round half away from zero; 0A000 ("cannot
 * convert NaN to integer", "cannot convert infinity") for the special values, 22003 out of range.
 */
export const toInteger = (
	a: Decimal,
	lo: bigint,
	hi: bigint
): Result.Result<bigint, FailureCode> => {
	if (!a.isFinite()) {
		return Result.err("0A000")
	}
	const value = roundedUnits(a, 0)
	return value < lo || value > hi ? Result.err("22003") : Result.ok(value)
}
