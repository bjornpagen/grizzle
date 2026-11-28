import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Undefined } from "#compiler/scalar/compute/registry.ts"
import { Numeric, type FiniteParts, roundedUnits } from "#compiler/scalar/values/decimal.ts"
import { numericMaxFractionDigits } from "#compiler/scalar/values/fault.ts"
import { numericMaxPrecision } from "#compiler/scalar/values/fault.ts"

/**
 * The most fraction digits PostgreSQL gives a division's, a mean's, a square root's or a power's result,
 * NUMERIC_MAX_DISPLAY_SCALE: select_div_scale and its kin take a result scale no larger.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the result scale of numeric division, avg, sqrt and power
 * @derivation numeric.h defines it as the greatest precision: "#define NUMERIC_MAX_DISPLAY_SCALE
 *   NUMERIC_MAX_PRECISION" (https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/numeric.h#L43)
 * @from {@link numericMaxPrecision}
 */
export const numericMaxDisplayScale = numericMaxPrecision

/**
 * The significant digits PostgreSQL gives an inexact numeric result at least, NUMERIC_MIN_SIG_DIGITS: a division's,
 * a square root's and a power's result scale is chosen to give that many.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the significant digits select_div_scale and its kin choose a result scale for
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/numeric.h#L53
 * @quote #define NUMERIC_MIN_SIG_DIGITS 16
 * @verified 2026-11-20
 */
const numericMinSigDigits = 16

/**
 * The decimal digits of one of numeric's NBASE digits, DEC_DIGITS: a weight counts NBASE digits, which
 * select_div_scale reads a quotient's weight in. A format constant of PostgreSQL's numeric, which grizzle's division
 * reproduces.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope one NBASE digit of a numeric value, the unit of its weight
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/numeric.c#L99
 * @quote #define DEC_DIGITS 4 /* decimal digits per NBASE digit *\/
 * @verified 2026-11-20
 */
export const decDigits = 4

/**
 * PostgreSQL numeric arithmetic over the exact Numeric carrier, and the conversion to an integer: each defined where
 * its precondition holds (registry.ts Totality), and refused with the precondition it lacks elsewhere.
 *
 * Each function computes the value the named function of src/backend/utils/adt/numeric.c returns when every operand is
 * written in its one form, trim_scale(x): the value SQL rendering makes PostgreSQL compute, since it passes the
 * operands of every display-scale reading through trim_scale (registry.ts OperandReading). A Numeric has no display
 * scale, so where numeric.c reads one (division's select_div_scale) this reads the value's least scale, minScale, and
 * every result is the one form. Special values follow PostgreSQL 14's rules: NaN absorbs, infinities combine as
 * numeric.c's special-value branches say, and a finite division by an infinity is zero. Division rounds half away from
 * zero at the result scale select_div_scale picks; every other operation is exact. The host never substitutes
 * JavaScript arithmetic for a SQL expression: these functions exist so the compiler can evaluate a literal against a
 * contract predicate (ContractLiteral) and cast a value.
 */
export type NumericResult = Result.Result<Numeric, Undefined>

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** The signed unscaled value of a finite value at its least scale. */
const units = (p: FiniteParts): bigint => (p.negative ? -p.coefficient : p.coefficient)

const at = (p: FiniteParts, scale: number): bigint => units(p) * pow10(scale - p.minScale)

/**
 * A finite Numeric from signed units at a scale, in its one form, or "format" outside numeric's format, which the
 * lowering's digit bounds rule out of every admitted expression (lower.ts) over operands proved within it, and
 * PostgreSQL refuses with 22003 over one bounded by nothing but numeric's own limit (scalar/values/fault.ts
 * resultDigits).
 */
export const fromUnits = (value: bigint, scale: number): NumericResult => {
	const made = Numeric.fromParts(value < 0n, value < 0n ? -value : value, scale)
	return made.ok ? Result.ok(made.value) : Result.err("format")
}

const ok = (d: Numeric): NumericResult => Result.ok(d)

/** The sign of a value that is not NaN: -1, 0 or 1. NaN, which has none, is ruled out by every caller first. */
const signOf = (d: Numeric): -1 | 0 | 1 => {
	const p = d.parts
	switch (p.kind) {
		case "infinity":
			return 1
		case "-infinity":
			return -1
		case "nan":
			return 0
		case "finite":
			return p.coefficient === 0n ? 0 : p.negative ? -1 : 1
	}
}

const infinityOf = (sign: number): Numeric =>
	sign > 0 ? Numeric.infinity : Numeric.negativeInfinity

/** numeric_add. */
export const add = (a: Numeric, b: Numeric): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Numeric.nan)
	}
	if (x.kind !== "finite" || y.kind !== "finite") {
		if (x.kind !== "finite" && y.kind !== "finite" && x.kind !== y.kind) {
			return ok(Numeric.nan)
		}
		return ok(x.kind !== "finite" ? a : b)
	}
	const scale = Math.max(x.minScale, y.minScale)
	return fromUnits(at(x, scale) + at(y, scale), scale)
}

/** numeric_uminus. */
export const neg = (a: Numeric): NumericResult => {
	const x = a.parts
	switch (x.kind) {
		case "nan":
			return ok(a)
		case "infinity":
			return ok(Numeric.negativeInfinity)
		case "-infinity":
			return ok(Numeric.infinity)
		case "finite":
			return fromUnits(-units(x), x.minScale)
	}
}

/** numeric_sub. */
export const sub = (a: Numeric, b: Numeric): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Numeric.nan)
	}
	if (x.kind !== "finite" || y.kind !== "finite") {
		if (x.kind !== "finite" && y.kind !== "finite" && x.kind === y.kind) {
			return ok(Numeric.nan)
		}
		return x.kind !== "finite" ? ok(a) : neg(b)
	}
	const scale = Math.max(x.minScale, y.minScale)
	return fromUnits(at(x, scale) - at(y, scale), scale)
}

/** numeric_mul: the exact product, rounded only past NUMERIC_DSCALE_MAX digits after the point. */
export const mul = (a: Numeric, b: Numeric): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Numeric.nan)
	}
	if (x.kind !== "finite" || y.kind !== "finite") {
		const s = signOf(a) * signOf(b)
		return ok(s === 0 ? Numeric.nan : infinityOf(s))
	}
	const scale = x.minScale + y.minScale
	const product = units(x) * units(y)
	if (scale <= numericMaxFractionDigits) {
		return fromUnits(product, scale)
	}
	/**
	 * The exact product has more fractional digits than a numeric stores: round_var to NUMERIC_DSCALE_MAX, half away
	 * from zero, before make_result.
	 */
	const divisor = pow10(scale - numericMaxFractionDigits)
	const magnitude = product < 0n ? -product : product
	const rounded = magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n)
	return fromUnits(product < 0n ? -rounded : rounded, numericMaxFractionDigits)
}

/**
 * The weight (in NBASE digits) and leading NBASE digit of a finite nonzero value: |v| = first * 10000^weight + rest.
 */
const weightAndFirst = (p: FiniteParts): { readonly weight: number; readonly first: bigint } => {
	if (p.coefficient === 0n) {
		return { weight: 0, first: 0n }
	}
	/** The decimal exponent of the leading digit. */
	const exponent = p.coefficient.toString().length - 1 - p.minScale
	const weight = Math.floor(exponent / decDigits)
	const shift = weight * decDigits + p.minScale
	/** first = floor(coefficient / 10^(weight*4 + minScale)). */
	const first = shift >= 0 ? p.coefficient / pow10(shift) : p.coefficient * pow10(-shift)
	return { weight, first }
}

/**
 * select_div_scale over operands in their one form: at least NUMERIC_MIN_SIG_DIGITS significant digits, and never
 * less than either operand's least scale, the display scale trim_scale leaves PostgreSQL to read.
 */
const divScale = (x: FiniteParts, y: FiniteParts): number => {
	const a = weightAndFirst(x)
	const b = weightAndFirst(y)
	let qweight = a.weight - b.weight
	if (a.first <= b.first) {
		qweight--
	}
	const rscale = Math.max(numericMinSigDigits - qweight * decDigits, x.minScale, y.minScale, 0)
	return Math.min(rscale, numericMaxDisplayScale)
}

/**
 * The quotient of two finite values at `scale` decimal places, by `rounding`: half away from zero, numeric_div's, or
 * toward zero, numeric_div_trunc's.
 */
const quotient = (
	x: FiniteParts,
	y: FiniteParts,
	scale: number,
	rounding: "halfAwayFromZero" | "towardZero"
): bigint => {
	/** x / y * 10^scale = (X / 10^sx) / (Y / 10^sy) * 10^scale = X * 10^(sy + scale) / (Y * 10^sx) */
	let num = x.coefficient
	let den = y.coefficient
	const shift = y.minScale + scale - x.minScale
	if (shift >= 0) {
		num *= pow10(shift)
	} else {
		den *= pow10(-shift)
	}
	let q = num / den
	if (rounding === "halfAwayFromZero" && (num % den) * 2n >= den) {
		q += 1n
	}
	return x.negative !== y.negative ? -q : q
}

/** A division's operands: a result its special values decide, or two finite values with a nonzero divisor. */
type Division =
	| { readonly kind: "decided"; readonly result: NumericResult }
	| { readonly kind: "finite"; readonly x: FiniteParts; readonly y: FiniteParts }

/**
 * The special-value rules numeric_div and numeric_div_trunc share.
 *
 * A finite value over an infinity is zero.
 */
const division = (a: Numeric, b: Numeric): Division => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return { kind: "decided", result: ok(Numeric.nan) }
	}
	if (x.kind !== "finite") {
		if (y.kind !== "finite") {
			return { kind: "decided", result: ok(Numeric.nan) }
		}
		const s = signOf(b)
		return {
			kind: "decided",
			result: s === 0 ? Result.err("nonzero") : ok(infinityOf(signOf(a) * s))
		}
	}
	if (y.kind !== "finite") {
		return { kind: "decided", result: ok(Numeric.zero) }
	}
	if (y.coefficient === 0n) {
		return { kind: "decided", result: Result.err("nonzero") }
	}
	return { kind: "finite", x, y }
}

/** numeric_div. */
export const div = (a: Numeric, b: Numeric): NumericResult => {
	const d = division(a, b)
	if (d.kind === "decided") {
		return d.result
	}
	const scale = divScale(d.x, d.y)
	return fromUnits(quotient(d.x, d.y, scale, "halfAwayFromZero"), scale)
}

/** numeric_div_trunc, the function div(a, b): the quotient truncated toward zero, an integer. */
export const divTrunc = (a: Numeric, b: Numeric): NumericResult => {
	const d = division(a, b)
	if (d.kind === "decided") {
		return d.result
	}
	return fromUnits(quotient(d.x, d.y, 0, "towardZero"), 0)
}

/**
 * numeric_mod, the operator % and the function mod(a, b): a - trunc(a / b) * b, with the dividend's sign.
 */
export const mod = (a: Numeric, b: Numeric): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Numeric.nan)
	}
	if (x.kind !== "finite") {
		return y.kind === "finite" && y.coefficient === 0n ? Result.err("nonzero") : ok(Numeric.nan)
	}
	if (y.kind !== "finite") {
		return ok(a)
	}
	if (y.coefficient === 0n) {
		return Result.err("nonzero")
	}
	const scale = Math.max(x.minScale, y.minScale)
	return fromUnits(at(x, scale) % at(y, scale), scale)
}

/** numeric_abs. */
export const abs = (a: Numeric): NumericResult => {
	const x = a.parts
	switch (x.kind) {
		case "nan":
			return ok(a)
		case "infinity":
		case "-infinity":
			return ok(Numeric.infinity)
		case "finite":
			return fromUnits(x.coefficient, x.minScale)
	}
}

/** numeric_sign: -1, 0 or 1; NaN for NaN. */
export const sign = (a: Numeric): NumericResult => {
	if (a.isNaN()) {
		return ok(a)
	}
	return fromUnits(BigInt(signOf(a)), 0)
}

/**
 * numeric to an integer type (numeric_int2, numeric_int4, numeric_int8): round half away from zero; defined on finite
 * values ("finite") that fit [lo, hi] once rounded ("fits").
 */
export const toInteger = (a: Numeric, lo: bigint, hi: bigint): Result.Result<bigint, Undefined> => {
	if (!a.isFinite()) {
		return Result.err("finite")
	}
	const value = roundedUnits(a, 0)
	return value < lo || value > hi ? Result.err("fits") : Result.ok(value)
}
