import * as Result from "#compiler/core/result.ts"
import {
	binary32DecimalDigits,
	binary32MaxExponent,
	binary32MinExponent,
	binary32Precision,
	binary64DecimalDigits,
	binary64MaxExponent,
	binary64MinExponent,
	binary64Precision,
	integerRanges,
	moneyFractionDigits
} from "#compiler/ir/carriers.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { fromUnits, toInteger } from "#compiler/scalar/compute/numeric.ts"
import type { Undefined } from "#compiler/scalar/compute/registry.ts"
import { type LexicalValue, lexicalTargetOf, lexicalValue } from "#compiler/scalar/lexical.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { fround } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"

export type IntCarrier = "int2" | "int4" | "int8"

/** Money's minor units to the unit, 10^moneyFractionDigits: what numeric to money multiplies by. */
const minorUnitsPerUnit = 10n ** BigInt(moneyFractionDigits.value)

type IntResult = Result.Result<bigint, Undefined>

/** An exact integer narrowed into an integer carrier: defined where it fits. */
const inIntRange = (value: bigint, c: IntCarrier): IntResult => {
	const [lo, hi] = integerRanges[c]
	return value < lo || value > hi ? Result.err("fits") : Result.ok(value)
}

const pow2 = (n: number): bigint => 1n << BigInt(n)

const bitLength = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length)

/** Each float carrier's IEEE 754 format: its precision and its least normal and greatest exponents. */
const floatFormat: {
	readonly [C in "float4" | "float8"]: {
		readonly bits: number
		readonly minExp: number
		readonly maxExp: number
	}
} = {
	float4: {
		bits: binary32Precision.value,
		minExp: binary32MinExponent.value,
		maxExp: binary32MaxExponent.value
	},
	float8: {
		bits: binary64Precision.value,
		minExp: binary64MinExponent.value,
		maxExp: binary64MaxExponent.value
	}
}

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
export const toFloat = (
	negative: boolean,
	num: bigint,
	den: bigint,
	width: "float4" | "float8"
): number => {
	const magnitude = roundRational(num, den, width)
	return magnitude === 0 ? 0 : negative ? -magnitude : magnitude
}

/** binary64's trailing significand field, p - 1 bits: the significand's bits below its leading one, left implicit. */
const binary64TrailingBits = BigInt(binary64Precision.value - 1)

/**
 * The exact rational value of a finite double: sign, numerator, denominator (a power of two). A magnitude's encoding
 * is its biased exponent E above its trailing significand field f: a normal double (E > 0) is 1.f · 2^(E + emin - 1)
 * and a subnormal (E = 0) is 0.f · 2^emin, so the significand's last bit weighs 2^(max(E, 1) + emin - p).
 */
export const doubleParts = (
	x: number
): { readonly negative: boolean; readonly num: bigint; readonly den: bigint } => {
	const view = new DataView(new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT))
	view.setFloat64(0, Math.abs(x))
	const bits = view.getBigUint64(0)
	const negative = x < 0 || Object.is(x, -0)
	const exponent = Number(bits >> binary64TrailingBits)
	const fraction = bits & ((1n << binary64TrailingBits) - 1n)
	const significand = exponent === 0 ? fraction : fraction | (1n << binary64TrailingBits)
	const e = (exponent === 0 ? 1 : exponent) + binary64MinExponent.value - binary64Precision.value
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
 * Money, and a parse's booleans and dates as boolean and CalendarDate.
 */
export type CastValue = bigint | Decimal | number | Money | LexicalValue

type CastResult = Result.Result<CastValue, Undefined>

type FloatCarrier = "float4" | "float8"

/**
 * The significant digits a float keeps cast to numeric: the %.*g precision of float4_numeric and float8_numeric,
 * FLT_DIG and DBL_DIG (ir/carriers.ts).
 */
export const floatNumericDigits: { readonly [C in FloatCarrier]: number } = {
	float4: binary32DecimalDigits.value,
	float8: binary64DecimalDigits.value
}

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
 * - a float to numeric is the decimal its %.*g text names, FLT_DIG or DBL_DIG significant digits rounded half to
 *   even, NaN and the infinities kept (float4_numeric, float8_numeric);
 * - money is the signed 64-bit count of minor units in the fixed C.UTF-8 monetary context, moneyFractionDigits fraction
 *   digits: numeric to money rounds amount * 10^moneyFractionDigits half away from zero, money to numeric is the
 *   amount exactly, and an exact
 *   integer or an exact amount into money is defined where it fits the count;
 * - an integer into an exact integer, and money into exact money, is the value itself;
 * - a text into a type with a lexical form is a parse, defined where the text is a member of the form ("lexical"),
 *   whose value is XML Schema's lexical mapping of it (scalar/lexical.ts lexicalValue), read at the cast's own target,
 *   a numeric's typmod included, since the form depends on it.
 *
 * A cast's host conversion, over the host value of its source's family (literal.ts CarrierValue): each registered
 * cast carries its own (registry.ts castOverloads), and the evaluator calls it on the operand's value of that family.
 */
export type HostCast =
	| { readonly from: "integer"; readonly convert: (x: bigint) => CastResult }
	| { readonly from: "numeric"; readonly convert: (d: Decimal) => CastResult }
	| { readonly from: "float"; readonly convert: (x: number) => CastResult }
	| { readonly from: "money"; readonly convert: (m: Money) => CastResult }
	| { readonly from: "text"; readonly convert: (text: string, to: ScalarType) => CastResult }

/** rint: round half to even, to the nearer of the integers around x, the even one at a tie. */
const rint = (x: number): number => {
	const below = Math.floor(x)
	const above = below + 1
	const order = Math.sign(x - below - (above - x))
	return order < 0 ? below : order > 0 ? above : below % 2 === 0 ? below : above
}

/**
 * FLOAT8_FITS_IN_INT: lo <= r < -lo, compared in binary64.
 */
const floatToInt = (x: number, c: IntCarrier): IntResult => {
	if (!Number.isFinite(x)) {
		return Result.err("finite")
	}
	const r = rint(x)
	const [lo, hi] = integerRanges[c]
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
	return gDecimal(x, floatNumericDigits[width])
}

/** A count of minor units as money: defined where it fits the signed 64-bit count. */
const storedMoney = (minor: bigint): CastResult =>
	minor < integerRanges.int8[0] || minor > integerRanges.int8[1]
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
			return { from: "integer", convert: (x) => storedMoney(x * minorUnitsPerUnit) }
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
			const [lo, hi] = integerRanges[target]
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
					const scaled = d.isFinite()
						? Decimal.fromParts(
								d.parts.negative,
								d.parts.coefficient * minorUnitsPerUnit,
								d.parts.minScale
							)
						: Result.ok(d)
					if (!scaled.ok) {
						return Result.err("fits")
					}
					const minor = toInteger(scaled.value, integerRanges.int8[0], integerRanges.int8[1])
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
			return { from: "money", convert: (m) => fromUnits(m.minorUnits, moneyFractionDigits.value) }
		case "exactMoney":
			return { from: "money", convert: Result.ok }
		case "money":
			return { from: "money", convert: (m) => storedMoney(m.minorUnits) }
	}
}

/** A double precision value rounded once, half to even, from an exact rational: a parse's xs:double. */
const roundDouble = (negative: boolean, num: bigint, den: bigint): number =>
	toFloat(negative, num, den, "float8")

/**
 * A text's parse into `to`: defined where the text is a member of `to`'s lexical form, its value the one the form's
 * lexical mapping gives it (scalar/lexical.ts); a target with no form has no parse.
 */
export const parseText = (text: string, to: ScalarType): CastResult => {
	const target = lexicalTargetOf(to)
	const value = target === undefined ? undefined : lexicalValue(target, text, roundDouble)
	return value === undefined ? Result.err("lexical") : Result.ok(value)
}

/** The parse as a registered cast's host conversion. */
export const textCast: HostCast = { from: "text", convert: parseText }
