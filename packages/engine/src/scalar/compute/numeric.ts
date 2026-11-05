import { type Limit, postgresSource, published } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import {
	numericMaxDisplayScale,
	numericMaxFractionDigits,
	numericMinSigDigits
} from "#compiler/ir/scalar.ts"
import type { Undefined } from "#compiler/scalar/compute/registry.ts"
import { Decimal, type FiniteParts, roundedUnits } from "#compiler/scalar/values/decimal.ts"

/**
 * PostgreSQL numeric arithmetic over the exact Decimal carrier, and the conversion to an integer: each defined where
 * its precondition holds (registry.ts Totality), and refused with the precondition it lacks elsewhere.
 *
 * Each function computes the value the named function of src/backend/utils/adt/numeric.c returns when every operand is
 * written in its one form, trim_scale(x): the value SQL rendering makes PostgreSQL compute, since it passes the
 * operands of every display-scale reading through trim_scale (registry.ts OperandReading). A Decimal has no display
 * scale, so where numeric.c reads one (division's select_div_scale) this reads the value's least scale, minScale, and
 * every result is the one form. Special values follow PostgreSQL 14's rules: NaN absorbs, infinities combine as
 * numeric.c's special-value branches say, and a finite division by an infinity is zero. Division rounds half away from
 * zero at the result scale select_div_scale picks; every other operation is exact. The host never substitutes
 * JavaScript arithmetic for a SQL expression: these functions exist so the compiler can evaluate a literal against a
 * contract predicate (ContractLiteral) and cast a value.
 */
export type NumericResult = Result.Result<Decimal, Undefined>

/**
 * The decimal digits of one of numeric's NBASE digits, DEC_DIGITS: a weight counts NBASE digits, which
 * select_div_scale reads a quotient's weight in. A format constant of PostgreSQL's numeric, which grizzle's division
 * reproduces.
 */
export const decDigits: Limit = published({
	value: 4,
	owner: "PostgreSQL 19rc1",
	unit: "decimal digits",
	scope: "one NBASE digit of a numeric value, the unit of its weight",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/backend/utils/adt/numeric.c#L99`,
	quote: "#define DEC_DIGITS\t4\t\t\t/* decimal digits per NBASE digit */",
	verified: "2026-11-05"
})

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** The signed unscaled value of a finite value at its least scale. */
const units = (p: FiniteParts): bigint => (p.negative ? -p.coefficient : p.coefficient)

const at = (p: FiniteParts, scale: number): bigint => units(p) * pow10(scale - p.minScale)

/**
 * A finite Decimal from signed units at a scale, in its one form, or "format" outside numeric's format, which the
 * lowering's digit bounds rule out of every admitted expression (lower.ts).
 */
export const fromUnits = (value: bigint, scale: number): NumericResult => {
	const made = Decimal.fromParts(value < 0n, value < 0n ? -value : value, scale)
	return made.ok ? Result.ok(made.value) : Result.err("format")
}

const ok = (d: Decimal): NumericResult => Result.ok(d)

/** The sign of a value that is not NaN: -1, 0 or 1. NaN, which has none, is ruled out by every caller first. */
const signOf = (d: Decimal): -1 | 0 | 1 => {
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

const infinityOf = (sign: number): Decimal =>
	sign > 0 ? Decimal.infinity : Decimal.negativeInfinity

/** numeric_add. */
export const add = (a: Decimal, b: Decimal): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Decimal.nan)
	}
	if (x.kind !== "finite" || y.kind !== "finite") {
		if (x.kind !== "finite" && y.kind !== "finite" && x.kind !== y.kind) {
			return ok(Decimal.nan)
		}
		return ok(x.kind !== "finite" ? a : b)
	}
	const scale = Math.max(x.minScale, y.minScale)
	return fromUnits(at(x, scale) + at(y, scale), scale)
}

/** numeric_uminus. */
export const neg = (a: Decimal): NumericResult => {
	const x = a.parts
	switch (x.kind) {
		case "nan":
			return ok(a)
		case "infinity":
			return ok(Decimal.negativeInfinity)
		case "-infinity":
			return ok(Decimal.infinity)
		case "finite":
			return fromUnits(-units(x), x.minScale)
	}
}

/** numeric_sub. */
export const sub = (a: Decimal, b: Decimal): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Decimal.nan)
	}
	if (x.kind !== "finite" || y.kind !== "finite") {
		if (x.kind !== "finite" && y.kind !== "finite" && x.kind === y.kind) {
			return ok(Decimal.nan)
		}
		return x.kind !== "finite" ? ok(a) : neg(b)
	}
	const scale = Math.max(x.minScale, y.minScale)
	return fromUnits(at(x, scale) - at(y, scale), scale)
}

/** numeric_mul: the exact product, rounded only past NUMERIC_DSCALE_MAX digits after the point. */
export const mul = (a: Decimal, b: Decimal): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Decimal.nan)
	}
	if (x.kind !== "finite" || y.kind !== "finite") {
		const s = signOf(a) * signOf(b)
		return ok(s === 0 ? Decimal.nan : infinityOf(s))
	}
	const scale = x.minScale + y.minScale
	const product = units(x) * units(y)
	if (scale <= numericMaxFractionDigits.value) {
		return fromUnits(product, scale)
	}
	/**
	 * The exact product has more fractional digits than a numeric stores: round_var to NUMERIC_DSCALE_MAX, half away
	 * from zero, before make_result.
	 */
	const divisor = pow10(scale - numericMaxFractionDigits.value)
	const magnitude = product < 0n ? -product : product
	const rounded = magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n)
	return fromUnits(product < 0n ? -rounded : rounded, numericMaxFractionDigits.value)
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
	const weight = Math.floor(exponent / decDigits.value)
	const shift = weight * decDigits.value + p.minScale
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
	const rscale = Math.max(
		numericMinSigDigits.value - qweight * decDigits.value,
		x.minScale,
		y.minScale,
		0
	)
	return Math.min(rscale, numericMaxDisplayScale.value)
}

/**
 * The quotient of two finite values at `scale` decimal places: rounded half away from zero, or truncated toward zero.
 */
const quotient = (x: FiniteParts, y: FiniteParts, scale: number, round: boolean): bigint => {
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
	if (round && (num % den) * 2n >= den) {
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
const division = (a: Decimal, b: Decimal): Division => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return { kind: "decided", result: ok(Decimal.nan) }
	}
	if (x.kind !== "finite") {
		if (y.kind !== "finite") {
			return { kind: "decided", result: ok(Decimal.nan) }
		}
		const s = signOf(b)
		return {
			kind: "decided",
			result: s === 0 ? Result.err("nonzero") : ok(infinityOf(signOf(a) * s))
		}
	}
	if (y.kind !== "finite") {
		return { kind: "decided", result: ok(Decimal.zero) }
	}
	if (y.coefficient === 0n) {
		return { kind: "decided", result: Result.err("nonzero") }
	}
	return { kind: "finite", x, y }
}

/** numeric_div. */
export const div = (a: Decimal, b: Decimal): NumericResult => {
	const d = division(a, b)
	if (d.kind === "decided") {
		return d.result
	}
	const scale = divScale(d.x, d.y)
	return fromUnits(quotient(d.x, d.y, scale, true), scale)
}

/** numeric_div_trunc, the function div(a, b): the quotient truncated toward zero, an integer. */
export const divTrunc = (a: Decimal, b: Decimal): NumericResult => {
	const d = division(a, b)
	if (d.kind === "decided") {
		return d.result
	}
	return fromUnits(quotient(d.x, d.y, 0, false), 0)
}

/**
 * numeric_mod, the operator % and the function mod(a, b): a - trunc(a / b) * b, with the dividend's sign.
 */
export const mod = (a: Decimal, b: Decimal): NumericResult => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan" || y.kind === "nan") {
		return ok(Decimal.nan)
	}
	if (x.kind !== "finite") {
		return y.kind === "finite" && y.coefficient === 0n ? Result.err("nonzero") : ok(Decimal.nan)
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
export const abs = (a: Decimal): NumericResult => {
	const x = a.parts
	switch (x.kind) {
		case "nan":
			return ok(a)
		case "infinity":
		case "-infinity":
			return ok(Decimal.infinity)
		case "finite":
			return fromUnits(x.coefficient, x.minScale)
	}
}

/** numeric_sign: -1, 0 or 1; NaN for NaN. */
export const sign = (a: Decimal): NumericResult => {
	if (a.isNaN()) {
		return ok(a)
	}
	return fromUnits(BigInt(signOf(a)), 0)
}

/**
 * numeric to an integer type (numeric_int2, numeric_int4, numeric_int8): round half away from zero; defined on finite
 * values ("finite") that fit [lo, hi] once rounded ("fits").
 */
export const toInteger = (a: Decimal, lo: bigint, hi: bigint): Result.Result<bigint, Undefined> => {
	if (!a.isFinite()) {
		return Result.err("finite")
	}
	const value = roundedUnits(a, 0)
	return value < lo || value > hi ? Result.err("fits") : Result.ok(value)
}
