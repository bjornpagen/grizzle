import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	canonicalTag,
	type TaggedValue,
	vectorTag
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	derived,
	int2Max,
	int2Min,
	int4Max,
	int4Min,
	int8Max,
	int8Min,
	type Limit,
	postgresSource,
	published
} from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"

declare const canonicalFloat: unique symbol

/**
 * A float with the one zero: any number but -0. canonicalZero is its one mint; the IR's float literal holds one
 * (ir/expr.ts TypedLiteral), and scalar/values/float.ts re-exports both.
 */
export type CanonicalFloat = number & { readonly [canonicalFloat]: true }

const mintCanonical = nominal<number, CanonicalFloat>()

/** One spelling of zero: -0 as +0, every other number as it is. */
export const canonicalZero = (x: number): CanonicalFloat => mintCanonical(x === 0 ? 0 : x)

/**
 * Money and Vector values at the Description boundary and in the IR.
 *
 * A Money literal travels as "~m:<minor units>" and a Vector literal as "~v:[c1,...,cn]", the
 * same extension tags the owned Money and scalar/values' Vector.canonical write, the vector's the one the canonical
 * model writes a host vector's components under (core/canonical.ts vectorTag). A Description holds either as any
 * object implementing the canonical protocol with that tag; the IR holds it parsed, as decimal.ts does for decimals: a
 * money amount as its minor units (MoneyValue), so the owned Money travels through unchanged, and a vector as its
 * components (VectorText), since a Vector is a caller's mutable Float32Array. This module owns only what the boundary
 * needs: the payload grammars and two minimal carriers, MoneyText and VectorText, that a decode parses a payload into.
 * Neither does arithmetic; each spells exactly the payload it was parsed from, so a value survives decode and re-encode
 * exactly.
 *
 * - Money: the canonical decimal integer text of a signed 64-bit count of minor units: an optional '-', digits with no
 *   leading zero, no "-0".
 * - Vector: "[c1,...,cn]" with 1..vectorMaxDimensions components, each the shortest round-trip text of a finite binary32 value read
 *   as a double (String(x), so never "-0": -0 is stored as +0).
 */
export const moneyTag = "m"
export { vectorTag }

/** The decimal digits of the greatest magnitude in [min, max]: the least d with |x| < 10^d for every x of the range. */
const rangeDigits = (min: bigint, max: bigint): number =>
	Math.max((-min).toString().length, max.toString().length)

/**
 * The decimal digits of the greatest magnitude in [min, max] every integer of that many digits reaches: the greatest d
 * with 10^d - 1 within the range on both sides.
 */
const rangeExactDigits = (min: bigint, max: bigint): number =>
	Math.min(exactDigits(-min), exactDigits(max))

/** The greatest d with 10^d - 1 at most `bound`, a magnitude. */
const exactDigits = (bound: bigint): number => {
	const digits = bound.toString().length
	return 10n ** BigInt(digits) - 1n <= bound ? digits : digits - 1
}

/** The integer digits of a smallint, |x| < 10^int2Digits. */
const int2Digits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every smallint value",
	from: [int2Min, int2Max],
	derivation: "the decimal length of smallint's greatest magnitude, -int2Min",
	compute: ([min, max]) => rangeDigits(BigInt(min.value), BigInt(max.value))
})

/** The integer digits of an integer, |x| < 10^int4Digits. */
export const int4Digits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every integer value",
	from: [int4Min, int4Max],
	derivation: "the decimal length of integer's greatest magnitude, -int4Min",
	compute: ([min, max]) => rangeDigits(BigInt(min.value), BigInt(max.value))
})

/**
 * The integer digits of a bigint, |x| < 10^int8Digits: of a bigint value, of money's count of minor units, and of a
 * count of rows, which PostgreSQL counts in a bigint.
 */
export const int8Digits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every bigint value, money count and row count",
	from: [int8Min, int8Max],
	derivation: "the decimal length of bigint's greatest magnitude, -int8Min",
	compute: ([min, max]) => rangeDigits(min.value, max.value)
})

/** The most decimal digits every integer of which is a bigint: an exact integer that many digits long travels as one. */
export const int8ExactDigits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the exact integers SQL computes in bigint rather than numeric",
	from: [int8Min, int8Max],
	derivation: "the greatest d with 10^d - 1 within bigint's range on both sides",
	compute: ([min, max]) => rangeExactDigits(min.value, max.value)
})

/** The integer carriers' ranges as bigints, [least, greatest]: what an exact integer narrowed into one lies within. */
export const integerRanges: {
	readonly [C in "int2" | "int4" | "int8"]: readonly [bigint, bigint]
} = {
	int2: [BigInt(int2Min.value), BigInt(int2Max.value)],
	int4: [BigInt(int4Min.value), BigInt(int4Max.value)],
	int8: [int8Min.value, int8Max.value]
}

/** The integer carriers' integer digits, |x| < 10^digits. */
export const integerDigits: { readonly [C in "int2" | "int4" | "int8"]: Limit } = {
	int2: int2Digits,
	int4: int4Digits,
	int8: int8Digits
}

/**
 * The fraction digits of money: a money value is a bigint count of minor units, 10^moneyFractionDigits to the unit. It
 * is lc_monetary's frac_digits, and every login pins lc_monetary to C.UTF-8, whose frac_digits is CHAR_MAX, which
 * cash.c replaces with 2 (physical/ddl/roles.ts, admission verifying it).
 */
export const moneyFractionDigits: Limit = published({
	value: 2,
	owner: "PostgreSQL 19rc2 cash.c, lc_monetary C.UTF-8",
	unit: "decimal digits",
	scope:
		"the fraction digits of every money value, its input, its output and its casts to and from numeric",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/backend/utils/adt/cash.c#L210-L221`,
	quote:
		"frac_digits will be CHAR_MAX in some locales, notably C. [...] fpoint = lconvert->frac_digits; if (fpoint < 0 || fpoint > 10) fpoint = 2;",
	verified: "2026-11-14"
})

/** The integer digits of a money amount, |amount| < 10^moneyDigits: a bigint count of minor units, less its fraction. */
export const moneyDigits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every money amount",
	from: [int8Digits, moneyFractionDigits],
	derivation: "a count below 10^int8Digits minor units, 10^moneyFractionDigits to the unit",
	compute: ([digits, fraction]) => digits.value - fraction.value
})

/**
 * The hex digits of a uuid text's five groups, 8-4-4-4-12: uuid_out's format (RFC 9562 §4, "the formal definition of
 * the UUID string representation"), which a change would make another format.
 *
 * @formatConstant the widths of uuid_out's five hex groups
 */
export const uuidGroups = [8, 4, 4, 4, 12] as const

/** A group of the hyphenated uuid text, by its position among the five. */
export type UuidGroup = 0 | 1 | 2 | 3 | 4

/** Where a group starts in the hyphenated uuid text: after the groups and hyphens before it. */
export const uuidGroupStart = (group: UuidGroup): number =>
	uuidGroups.slice(0, group).reduce((at, width) => at + width + 1, 0)

/** The hyphens' positions in the uuid text: one after each group but the last. */
export const uuidHyphens: ReadonlySet<number> = new Set(
	[uuidGroupStart(1), uuidGroupStart(2), uuidGroupStart(3), uuidGroupStart(4)].map(
		(start) => start - 1
	)
)

/** The hyphenated uuid text's length: every group's digits and a hyphen between each two. */
export const uuidTextLength =
	uuidGroups.reduce((sum, width) => sum + width, 0) + uuidGroups.length - 1

/** pgvector's most dimensions a vector holds: its storage limit, not the HNSW index's 2,000. */
export const vectorMaxDimensions: Limit = published({
	value: 16000,
	owner: "pgvector 0.8.7",
	unit: "dimensions",
	scope: "one vector value: a column's typmod, a literal, a parameter",
	constraint: "compile-time constant",
	source: "https://github.com/pgvector/pgvector/blob/v0.8.7/src/vector.h#L11",
	quote: "#define VECTOR_MAX_DIM 16000",
	verified: "2026-11-05"
})

/**
 * IEEE 754-2019's binary32 and binary64 parameters as Java SE 21's language specification tabulates them, §4.2.3: "float,
 * whose values exactly correspond to the 32-bit IEEE 754 binary32 floating-point numbers, and double, whose values
 * exactly correspond to the 64-bit IEEE 754 binary64 floating-point numbers" (§4.2), the standard itself not being
 * openly published.
 */
const floatParameters = "https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html#jls-4.2.3"

/**
 * IEEE 754-2019's binary32 format, the real, a vector component and pgvector's accumulators: its precision p, the bits
 * of its significand.
 */
export const binary32Precision: Limit = published({
	value: 24,
	owner: "IEEE 754-2019 binary32",
	unit: "bits",
	scope: "the significand of every real value and vector component",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. N: float 24, double 53",
	verified: "2026-11-05"
})

/** binary32's greatest exponent, emax. */
export const binary32MaxExponent: Limit = published({
	value: 127,
	owner: "IEEE 754-2019 binary32",
	unit: "a binary exponent",
	scope: "the exponent of every finite real value and vector component",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emax: float +127, double +1023",
	verified: "2026-11-05"
})

/** binary32's least normal exponent, emin. */
export const binary32MinExponent: Limit = published({
	value: -126,
	owner: "IEEE 754-2019 binary32",
	unit: "a binary exponent",
	scope: "the exponent of every normal real value and vector component",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emin: float -126, double -1022",
	verified: "2026-11-05"
})

/** IEEE 754-2019's binary64 format, double precision and JavaScript's number: its precision p. */
export const binary64Precision: Limit = published({
	value: 53,
	owner: "IEEE 754-2019 binary64",
	unit: "bits",
	scope: "the significand of every double precision value",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. N: float 24, double 53",
	verified: "2026-11-05"
})

/** binary64's greatest exponent, emax. */
export const binary64MaxExponent: Limit = published({
	value: 1023,
	owner: "IEEE 754-2019 binary64",
	unit: "a binary exponent",
	scope: "the exponent of every finite double precision value",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emax: float +127, double +1023",
	verified: "2026-11-05"
})

/** binary64's least normal exponent, emin. */
export const binary64MinExponent: Limit = published({
	value: -1022,
	owner: "IEEE 754-2019 binary64",
	unit: "a binary exponent",
	scope: "the exponent of every normal double precision value",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emin: float -126, double -1022",
	verified: "2026-11-05"
})

/**
 * C's FLT_DIG and DBL_DIG for a binary format of precision p, floor((p - 1) * log10(2)): the decimal digits every
 * decimal of that many digits round-trips through the format with (C17 5.2.4.2.2), which float4_numeric and
 * float8_numeric write a float to numeric with, "%.*g" (numeric.c).
 */
const decimalDigitsOf = (p: number): number => Math.floor((p - 1) * Math.log10(2))

const numericC = `${postgresSource}/src/backend/utils/adt/numeric.c`

/** FLT_DIG: the significant digits a real keeps cast to numeric. */
export const binary32DecimalDigits: Limit = derived({
	owner: "PostgreSQL 19rc2 float4_numeric over C's FLT_DIG",
	unit: "decimal digits",
	scope: "the significant digits of a real cast to numeric",
	from: [binary32Precision],
	derivation: `floor((p - 1) * log10(2)), C's FLT_DIG for binary32, the precision float4_numeric prints with: "snprintf(buf, sizeof(buf), "%.*g", FLT_DIG, val);" (${numericC}#L4662)`,
	compute: ([p]) => decimalDigitsOf(p.value)
})

/** DBL_DIG: the significant digits a double precision keeps cast to numeric. */
export const binary64DecimalDigits: Limit = derived({
	owner: "PostgreSQL 19rc2 float8_numeric over C's DBL_DIG",
	unit: "decimal digits",
	scope: "the significant digits of a double precision cast to numeric",
	from: [binary64Precision],
	derivation: `floor((p - 1) * log10(2)), C's DBL_DIG for binary64, the precision float8_numeric prints with: "snprintf(buf, sizeof(buf), "%.*g", DBL_DIG, val);" (${numericC}#L4563)`,
	compute: ([p]) => decimalDigitsOf(p.value)
})

/** The greatest finite value of a format of precision p and greatest exponent emax: (2 - 2^(1-p)) * 2^emax, exactly. */
const greatestFinite = (p: number, emax: number): bigint =>
	2n ** BigInt(emax + 1) - 2n ** BigInt(emax + 1 - p)

/** The greatest finite binary32 value, (2 - 2^-23) * 2^127. */
export const binary32Max: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "a real value",
	scope: "every finite real value and vector component",
	from: [binary32Precision, binary32MaxExponent],
	derivation: "(2 - 2^(1-p)) * 2^emax, the all-ones significand at the greatest exponent",
	compute: ([p, emax]) => Number(greatestFinite(p.value, emax.value))
})

/** The binary exponent of binary32's least subnormal's one bit, emin - p + 1: 2^-149. */
export const binary32LeastExponent: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "a binary exponent",
	scope: "the least nonzero magnitude of a real value and vector component",
	from: [binary32Precision, binary32MinExponent],
	derivation: "emin - p + 1: the least significant bit of a subnormal at the least exponent",
	compute: ([p, emin]) => emin.value - p.value + 1
})

/** The integer digits of every finite binary32 value, |x| < 10^binary32Digits. */
export const binary32Digits: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "decimal digits",
	scope: "the integer digits of every finite real value",
	from: [binary32Precision, binary32MaxExponent],
	derivation: "the decimal length of the greatest finite value, an integer",
	compute: ([p, emax]) => greatestFinite(p.value, emax.value).toString().length
})

/**
 * The fraction digits of every binary32 value: the least subnormal 2^-k = 5^k / 10^k has exactly k of them, and every
 * other value is an integer multiple of it.
 */
export const binary32FractionDigits: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "decimal digits",
	scope: "the fraction digits of every finite real value",
	from: [binary32LeastExponent],
	derivation: "-(emin - p + 1): 2^-k is 5^k / 10^k, of k fraction digits",
	compute: ([least]) => -least.value
})

/** The integer digits of every finite binary64 value, |x| < 10^binary64Digits. */
export const binary64Digits: Limit = derived({
	owner: "IEEE 754-2019 binary64",
	unit: "decimal digits",
	scope: "the integer digits of every finite double precision value",
	from: [binary64Precision, binary64MaxExponent],
	derivation: "the decimal length of the greatest finite value, an integer",
	compute: ([p, emax]) => greatestFinite(p.value, emax.value).toString().length
})

/** The fraction digits of every binary64 value: those of its least subnormal, 2^-(p - 1 - emin). */
export const binary64FractionDigits: Limit = derived({
	owner: "IEEE 754-2019 binary64",
	unit: "decimal digits",
	scope: "the fraction digits of every finite double precision value",
	from: [binary64Precision, binary64MinExponent],
	derivation: "-(emin - p + 1): 2^-k is 5^k / 10^k, of k fraction digits",
	compute: ([p, emin]) => p.value - 1 - emin.value
})

/**
 * The cosine domain, the norms between cosineNormMin and cosineNormMax inclusive, as vector_norm computes them: the
 * norms of the vectors pgvector's cosine_distance is a number in [0, 2] for. pgvector 0.8.7's VectorCosineSimilarity
 * (src/vector.c) accumulates the dot product and both squared norms in binary32 floats, in any order and with fused
 * multiply-adds (the Makefile's -fassociative-math -ffp-contract=fast), and returns similarity / sqrt(norma * normb),
 * clamped to [-1, 1] unless it is NaN. A zero norma or normb makes it 0 / 0, NaN, and an infinite one Infinity /
 * Infinity or 0, so the distance is NaN or not the vectors'; and HNSW's vector_cosine_ops never indexes a vector whose
 * vector_norm is not positive (src/hnswutils.c HnswCheckNorm), so an approximate search would miss it. Within the
 * domain every accumulator is positive and finite, the quotient finite, and the clamp yields [0, 2].
 *
 * The least norm keeps norma positive. Its largest square rounds to a positive binary32 value only when it exceeds
 * 2^(emin - p), half the least subnormal, which rounds to zero; a vector of n components has a square of at least
 * norm^2 / n, and with n below 2^ceil(log2(n + 1)) the norm 2^ceil((emin - p + ceil(log2(n + 1))) / 2) makes every
 * vector of at most vectorMaxDimensions components have one, strictly, its 2.4% margin (2^14 / 16000) far above
 * vector_norm's own double rounding. A sum of nonnegative roundings is at least its largest term.
 */
export const cosineNormMin: Limit = derived({
	owner: "pgvector 0.8.7 cosine_distance over IEEE 754-2019 binary32",
	unit: "a vector norm",
	scope: "the norm of every vector a column stores, a parameter binds and a literal states",
	from: [binary32Precision, binary32MinExponent, vectorMaxDimensions],
	derivation:
		"2^ceil((emin - p + ceil(log2(n + 1))) / 2), n = vectorMaxDimensions: the largest of n squares of a vector of this norm exceeds 2^(emin - p), so it rounds to a positive binary32 value",
	compute: ([p, emin, n]) =>
		2 ** Math.ceil((emin.value - p.value + Math.ceil(Math.log2(n.value + 1))) / 2)
})

/**
 * The greatest norm keeps every accumulator finite. A binary32 sum rounds to Infinity once it reaches 2^(emax + 1) -
 * 2^(emax - p), the midpoint past the greatest finite value; n rounded products and n roundings of nonnegative partial
 * sums, in any order, are at most (1 + 2^-p)^n times the exact norm^2, and the dot product's partial sums at most that
 * times |a| |b| (Cauchy-Schwarz). So the greatest power of two whose square times (1 + 2^-p)^n stays below the midpoint
 * bounds both, with every partial sum at most the total; binary64's range holds norma * normb, between 2^-298 and
 * 2^254, exactly.
 */
export const cosineNormMax: Limit = derived({
	owner: "pgvector 0.8.7 cosine_distance over IEEE 754-2019 binary32",
	unit: "a vector norm",
	scope: "the norm of every vector a column stores, a parameter binds and a literal states",
	from: [binary32Precision, binary32MaxExponent, vectorMaxDimensions],
	derivation:
		"2^floor(log2((2^(emax + 1) - 2^(emax - p)) / (1 + 2^-p)^n) / 2), n = vectorMaxDimensions: a squared norm or dot product of vectors of this norm, summed in binary32, stays below the midpoint that rounds to Infinity",
	compute: ([p, emax, n]) =>
		2 **
		Math.floor(
			Math.log2(
				(2 ** (emax.value + 1) - 2 ** (emax.value - p.value)) / (1 + 2 ** -p.value) ** n.value
			) / 2
		)
})

/** The minor units `text` spells when it is a money amount's canonical text, else undefined. */
const moneyUnits = (text: string): bigint | undefined => {
	const digits = text.startsWith("-") ? text.slice(1) : text
	if (digits.length === 0 || digits.length > int8Digits.value) {
		return undefined
	}
	for (let i = 0; i < digits.length; i++) {
		const code = digits.charCodeAt(i)
		if (code < 0x30 || code > 0x39) {
			return undefined
		}
	}
	if (digits.length > 1 && digits.startsWith("0")) {
		return undefined
	}
	if (digits === "0" && text.length > 1) {
		return undefined
	}
	const value = BigInt(text)
	return value >= int8Min.value && value <= int8Max.value ? value : undefined
}

export const isMoneyPayload = (text: string): boolean => moneyUnits(text) !== undefined

/**
 * A money amount parsed: a signed 64-bit count of minor units. The IR holds a money literal as one (ir/expr.ts
 * TypedLiteral): MoneyText, or scalar/values' Money, which has the same count; either spells its canonical text from it.
 */
export type MoneyValue = Canonicalizable & { readonly minorUnits: bigint }

export class MoneyText implements Canonicalizable {
	readonly minorUnits: bigint

	private constructor(minorUnits: bigint) {
		this.minorUnits = minorUnits
		Object.freeze(this)
	}

	/** The amount `text` spells when it is a money amount's canonical text, else undefined. */
	static parse(text: string): MoneyText | undefined {
		const units = moneyUnits(text)
		return units === undefined ? undefined : new MoneyText(units)
	}

	[canonicalTag](): TaggedValue {
		return { tag: moneyTag, payload: this.toString() }
	}

	toString(): string {
		return this.minorUnits.toString()
	}
}

/** The binary32 components `list` spells when it is a vector's canonical text, else undefined. */
const vectorComponents = (list: string): ReadonlyArray<number> | undefined => {
	if (!list.startsWith("[") || !list.endsWith("]")) {
		return undefined
	}
	const texts = list.slice(1, -1).split(",")
	if (texts.length > vectorMaxDimensions.value) {
		return undefined
	}
	const components: Array<number> = []
	for (const t of texts) {
		const x = Number(t)
		if (!Number.isFinite(x) || Math.fround(x) !== x || String(x) !== t) {
			return undefined
		}
		components.push(x)
	}
	return components
}

export const isVectorPayload = (text: string): boolean => vectorComponents(text) !== undefined

const malformedVector = (): CompileError =>
	malformedDescription(
		SourceLoc("vector literal", []),
		"the canonical text of a Vector: [c1,...,cn] with shortest binary32 components"
	)

/**
 * A vector parsed: 1..vectorMaxDimensions finite binary32 components, -0 held as 0. The IR holds a vector literal as one
 * (ir/expr.ts TypedLiteral); it spells its canonical text from its components.
 */
export class VectorText implements Canonicalizable {
	readonly components: ReadonlyArray<number>

	private constructor(components: ReadonlyArray<number>) {
		this.components = Object.freeze(components)
		Object.freeze(this)
	}

	/** The vector `text` spells when it is a vector's canonical text, else undefined. */
	static parse(text: string): VectorText | undefined {
		const components = vectorComponents(text)
		return components === undefined ? undefined : new VectorText(components)
	}

	/** A vector from its binary32 components, -0 held as 0. */
	static of(components: Float32Array): Result.Result<VectorText, CompileError> {
		const held = Array.from(components, (c) => (c === 0 ? 0 : c))
		return held.length >= 1 &&
			held.length <= vectorMaxDimensions.value &&
			held.every((c) => Number.isFinite(c))
			? Result.ok(new VectorText(held))
			: Result.err(malformedVector())
	}

	[canonicalTag](): TaggedValue {
		return { tag: vectorTag, payload: this.toString() }
	}

	/** pgvector's input text of the components: "[c1,...,cn]", each the shortest round-trip text, -0 never written. */
	toString(): string {
		return `[${this.components.map(String).join(",")}]`
	}
}

export const moneyMinorUnits = (value: MoneyValue): bigint => value.minorUnits

/**
 * The canonical payload of a vector-tagged value, "[c1,...,cn]": pgvector's input text of the components, -0 never
 * written.
 */
export const vectorPayload = (value: Canonicalizable): string => value[canonicalTag]().payload
