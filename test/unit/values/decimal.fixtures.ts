/** What the properties of decimal.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import {
	aimed,
	type Aimed,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, pipe, String as Str } from "effect"
import { int4Max } from "#compiler/core/canonical.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { Numeric, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import {
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { decimalGen } from "#test/support/unit/values/support.ts"

/**
 * An exact spelling numeric_in reads, with the one text of the value it reads (numeric_out of trim_scale(value)) and
 * what the spelling exercises.
 */
export type SpellingFeature =
	| "signed"
	| "leading zeros"
	| "a bare point"
	| "an exponent"
	| "a zero"
	| "a special"
	| "trailing zeros"
	| "forty trailing zeros"

export const spellingFeatures: Arr.NonEmptyReadonlyArray<SpellingFeature> = [
	"signed",
	"leading zeros",
	"a bare point",
	"an exponent",
	"a zero",
	"a special",
	"trailing zeros",
	"forty trailing zeros"
]

/** Trailing fractional zeros a spelling carries: none, one, a few, and the deep paddings 24 and 40, each weighted. */
export const trailingZeros: Gen<number> = weighted([
	[4, constant(0)],
	[2, constant(1)],
	[2, int(2, 8)],
	[1, constant(24)],
	[1, constant(40)]
])

/** `n` zeros. */
const zeros = (n: number): string => Str.repeat(n)("0")

/** A finite value's one text: trailing fractional zeros, and a then bare point, dropped; no minus zero. */
const trimmed = (text: string): string => {
	const negative = Str.startsWith("-")(text)
	const unsigned = negative ? Str.slice(1)(text) : text
	const point = Str.indexOf(".")(unsigned)
	const kept = Option.match(point, {
		onNone: () => unsigned,
		onSome: () => Str.replace(regex("\\.?0*$"), "")(unsigned)
	})
	return negative && Str.replace(regex("[0.]", "g"), "")(kept) !== "" ? `-${kept}` : kept
}

/** The pad of a finite value's text by `k` trailing fractional zeros: the text numeric_out writes at a larger scale. */
export const padded = (text: string, k: number): string =>
	k === 0 ? text : `${Str.includes(".")(text) ? text : `${text}.`}${zeros(k)}`

/** Whether a Numeric's parts are its one form: no trailing zero past the point, zero unsigned at scale 0. */
export const canonicalParts = (d: Numeric): boolean => {
	const p = d.parts
	if (p.kind !== "finite") {
		return true
	}
	if (p.coefficient === 0n) {
		return !p.negative && p.minScale === 0
	}
	return p.minScale === 0 || p.coefficient % 10n !== 0n
}

/** Two Decimals' parts field by field. */
export const sameParts = (a: Numeric, b: Numeric): boolean => {
	const x = a.parts
	const y = b.parts
	return x.kind === "finite" && y.kind === "finite"
		? x.negative === y.negative && x.coefficient === y.coefficient && x.minScale === y.minScale
		: x.kind === y.kind
}

interface Spelling {
	readonly text: string
	readonly canonical: string
	readonly features: ReadonlyArray<SpellingFeature>
}

/** Between `min` and `max` decimal digits. */
const digitsOf = (min: number, max: number): Gen<string> =>
	string(characterOf(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]), { min, max })

/** A mantissa's digits about its point, built with a digit on one side at least: digits alone, or about a point. */
interface Mantissa {
	readonly whole: string
	readonly point: boolean
	readonly fraction: string
}

const mantissaGen: Gen<Mantissa> = weighted<Mantissa>([
	[2, (source) => ({ whole: source.draw(digitsOf(1, 6)), point: false, fraction: "" })],
	[
		2,
		(source) => ({
			whole: source.draw(digitsOf(1, 6)),
			point: true,
			fraction: source.draw(digitsOf(0, 6))
		})
	],
	[
		1,
		(source) => ({
			whole: source.draw(digitsOf(0, 6)),
			point: true,
			fraction: source.draw(digitsOf(1, 6))
		})
	]
])

const exactSpelling: Gen<Spelling> = map(
	(source) => ({
		sign: source.draw(element(["", "+", "-"])),
		mantissa: source.draw(mantissaGen),
		zeros: source.draw(trailingZeros),
		exponent: Option.getOrUndefined(
			source.draw(
				option((inner) => ({
					e: inner.draw(int(-8, 8)),
					mark: inner.draw(element(["e", "E"])),
					plus: inner.draw(boolean)
				}))
			)
		)
	}),
	({ sign, mantissa: { whole, point, fraction }, zeros: padding, exponent }): Spelling => {
		const frac = point ? `${fraction}${zeros(padding)}` : ""
		const e = exponent === undefined ? 0 : exponent.e
		const scale = Math.max(0, frac.length - e)
		/**
		 * The digits as an integer at the display scale: digits * 10^(e - frac + scale), an integer since scale >= frac - e.
		 */
		const digits = `${whole}${frac}`
		const coefficient =
			BigInt(digits === "" ? "0" : digits) * 10n ** BigInt(e - frac.length + scale)
		const written = pipe(coefficient.toString(), Str.padStart(scale + 1, "0"))
		const unsigned =
			scale === 0 ? written : `${Str.slice(0, -scale)(written)}.${Str.slice(-scale)(written)}`
		const exponentText =
			exponent === undefined
				? ""
				: `${exponent.mark}${exponent.plus && e >= 0 ? "+" : ""}${exponent.e}`
		return {
			text: `${sign}${whole}${point ? "." : ""}${frac}${exponentText}`,
			canonical: trimmed(sign === "-" && coefficient !== 0n ? `-${unsigned}` : unsigned),
			features: [
				...(sign === "" ? [] : ["signed" as const]),
				...(whole.length > 1 && Str.startsWith("0")(whole) ? ["leading zeros" as const] : []),
				...(point && (whole === "" || frac === "") ? ["a bare point" as const] : []),
				...(exponent === undefined ? [] : ["an exponent" as const]),
				...(coefficient === 0n ? ["a zero" as const] : []),
				...(point && padding > 0 ? ["trailing zeros" as const] : []),
				...(point && padding === 40 ? ["forty trailing zeros" as const] : [])
			]
		}
	}
)

const specialSpelling: Gen<Spelling> = element<Spelling>([
	{ text: "NaN", canonical: "NaN", features: ["a special"] },
	{ text: "Infinity", canonical: "Infinity", features: ["a special"] },
	{ text: "+Infinity", canonical: "Infinity", features: ["a special", "signed"] },
	{ text: "-Infinity", canonical: "-Infinity", features: ["a special", "signed"] }
])

export const spellingGen: Gen<Spelling> = weighted([
	[9, exactSpelling],
	[1, specialSpelling]
])

/** One corruption no exact spelling survives, planted at a drawn position where it has one. */
export type Corruption =
	| "a leading space"
	| "a trailing space"
	| "an underscore"
	| "a second point"
	| "a bare exponent mark"
	| "a hexadecimal prefix"
	| "a non-ASCII digit"
	| "a comma for the point"
	| "a misspelt special"
	| "a lone sign"

export const corruptions: Arr.NonEmptyReadonlyArray<Corruption> = [
	"a leading space",
	"a trailing space",
	"an underscore",
	"a second point",
	"a bare exponent mark",
	"a hexadecimal prefix",
	"a non-ASCII digit",
	"a comma for the point",
	"a misspelt special",
	"a lone sign"
]

/**
 * The corruptions that break the spelling's own text, each its only fault in an exact spelling (a bare exponent mark
 * takes the place of the spelling's exponent where it has one); a misspelt special and a lone sign replace the text.
 */
export const textCorruptions: Arr.NonEmptyReadonlyArray<Corruption> = [
	"a leading space",
	"a trailing space",
	"an underscore",
	"a second point",
	"a bare exponent mark",
	"a hexadecimal prefix",
	"a non-ASCII digit",
	"a comma for the point"
]

/** What a corruption case reached: its corruption, and an exact spelling it broke. */
export type CorruptionFeature = Corruption | "an exact spelling"

/** A spelling, one corruption, and where it is planted. */
interface CorruptionCase {
	readonly spelling: Spelling
	readonly corruption: Corruption
	readonly at: number
}

/** A spelling broken by `corruption`, at a drawn position, from `spellings`. */
const corruptionCaseOf =
	(spellings: Gen<Spelling>, corruption: Gen<Corruption>): Gen<CorruptionCase> =>
	(source) => ({
		spelling: source.draw(spellings),
		corruption: source.draw(corruption),
		at: source.draw(pickGen)
	})

/**
 * A spelling broken by any corruption, aimed at each corruption of the text planted in an exact spelling, where it is
 * the spelling's one fault.
 */
export const corruptionSpace: Aimed<CorruptionCase, CorruptionFeature> = aimed(
	corruptionCaseOf(spellingGen, element(corruptions)),
	Arr.map(
		textCorruptions,
		(corruption) =>
			[
				[corruption, "an exact spelling"],
				corruptionCaseOf(exactSpelling, constant(corruption))
			] as const
	)
)

export const corrupted = (text: string, corruption: Corruption, at: number): string => {
	const i = at % (text.length + 1)
	switch (corruption) {
		case "a leading space":
			return ` ${text}`
		case "a trailing space":
			return `${text} `
		case "an underscore":
			return `${Str.slice(0, i)(text)}_${Str.slice(i)(text)}`
		case "a second point":
			return `${text}..`
		case "a bare exponent mark":
			return `${Str.replace(regex("[eE][+-]?[0-9]+$"), "")(text)}e`
		case "a hexadecimal prefix":
			return `0x${text}`
		case "a non-ASCII digit":
			return `${text}١`
		case "a comma for the point":
			return `1,${Str.replace(regex("^[+-]"), "")(text)}`
		case "a misspelt special":
			return pickFrom(["inf", "nan", "infinity", "-NaN", "Inf"], at)
		case "a lone sign":
			return pickFrom(["", "-", "+", ".", "e5"], at)
	}
}

/** The greatest exponent magnitude a numeric text may write: PG_INT32_MAX / 2 (numeric.c set_var_from_str). */
const maxExponent = Math.trunc(int4Max / 2)

/** A limit of PostgreSQL's numeric format, and trailing zeros that run past one and drop away. */
type FormatLimit =
	| "fraction digits"
	| "integer digits"
	| "an exponent's integer digits"
	| "an exponent's magnitude"
	| "zeros past the fraction digits"

export const formatLimits: Arr.NonEmptyReadonlyArray<FormatLimit> = [
	"fraction digits",
	"integer digits",
	"an exponent's integer digits",
	"an exponent's magnitude",
	"zeros past the fraction digits"
]

/** How a value reaches the carrier: as text, as parts, or as a bigint. */
type Entry = "text" | "parts" | "bigint"

/** The entries a limit is reached by. */
const entriesOf: { readonly [L in FormatLimit]: Arr.NonEmptyReadonlyArray<Entry> } = {
	"fraction digits": ["text", "parts"],
	"integer digits": ["text", "parts", "bigint"],
	"an exponent's integer digits": ["text"],
	"an exponent's magnitude": ["text"],
	"zeros past the fraction digits": ["text", "parts"]
}

type Side = "at" | "past"

/** One value at a limit or past it by `margin`, reached by `entry`. */
interface FormatCase {
	readonly limit: FormatLimit
	readonly side: Side
	readonly entry: Entry
	readonly negative: boolean
	readonly margin: number
}

/** How far past an exponent's magnitude a case lies: a step or a few, or as far as a whole number writes exactly. */
const exponentMargin: Gen<number> = weighted([
	[3, int(1, 4)],
	[1, int(5, Number.MAX_SAFE_INTEGER - maxExponent)]
])

export const formatCaseGen: Gen<FormatCase> = (source) => {
	const limit = source.draw(element(formatLimits))
	const side = source.draw(element<Side>(["at", "past"]))
	return {
		limit,
		side,
		entry: source.draw(element(entriesOf[limit])),
		negative: source.draw(boolean),
		margin:
			side === "at"
				? 0
				: source.draw(limit === "an exponent's magnitude" ? exponentMargin : int(1, 4))
	}
}

/** The value a format case builds, through its entry. */
export const formatValueOf = (c: FormatCase): Result.Result<Numeric, ValueFault> => {
	const sign = c.negative ? "-" : ""
	const fraction = numericMaxFractionDigits + c.margin
	const integer = numericMaxIntegerDigits + c.margin
	switch (c.limit) {
		case "fraction digits":
			return c.entry === "text"
				? Numeric.fromString(`${sign}0.${zeros(fraction - 1)}1`)
				: Numeric.fromParts(c.negative, 1n, fraction)
		case "integer digits": {
			const nines = 10n ** BigInt(integer) - 1n
			return c.entry === "text"
				? Numeric.fromString(`${sign}${Str.repeat(integer)("9")}`)
				: c.entry === "parts"
					? Numeric.fromParts(c.negative, nines, 0)
					: Numeric.fromBigInt(c.negative ? -nines : nines)
		}
		case "an exponent's integer digits":
			return Numeric.fromString(`${sign}1e${integer - 1}`)
		case "an exponent's magnitude":
			return Numeric.fromString(`0e${sign}${maxExponent + c.margin}`)
		case "zeros past the fraction digits":
			return c.entry === "text"
				? Numeric.fromString(`${sign}1.${zeros(fraction)}`)
				: Numeric.fromParts(c.negative, 10n ** BigInt(fraction), fraction)
	}
}

/** The one text of a format case admitted: the value at its limit, or the one the zeros drop away to. */
export const formatTextOf = (c: FormatCase): string => {
	const sign = c.negative ? "-" : ""
	switch (c.limit) {
		case "fraction digits":
			return `${sign}0.${zeros(numericMaxFractionDigits - 1)}1`
		case "integer digits":
			return `${sign}${Str.repeat(numericMaxIntegerDigits)("9")}`
		case "an exponent's integer digits":
			return `${sign}1${zeros(numericMaxIntegerDigits - 1)}`
		case "an exponent's magnitude":
			return "0"
		case "zeros past the fraction digits":
			return `${sign}1`
	}
}

export type FormatFeature = `${FormatLimit} ${Side}` | `by ${Entry}` | "an exponent far past"

/** A finite value's signed coefficient. */
export const signedOf = (d: Numeric): bigint => {
	const p = d.parts
	return p.kind !== "finite" ? 0n : p.negative ? -p.coefficient : p.coefficient
}

/** A finite value's scale, zero for a special. */
const scaleOf = (d: Numeric): number => (d.parts.kind === "finite" ? d.parts.minScale : 0)

/** The order a difference states: -1, 0 or 1. */
const signOf = (n: bigint): -1 | 0 | 1 => (n < 0n ? -1 : n > 0n ? 1 : 0)

/** cmp_numerics' rank of a value's kind: -Infinity, finite, Infinity, NaN. */
const kindRankOf = (d: Numeric): number =>
	d.parts.kind === "-infinity"
		? 0
		: d.parts.kind === "finite"
			? 1
			: d.parts.kind === "infinity"
				? 2
				: 3

/** cmp_numerics, modelled: kinds by rank, finite values by their signed coefficients cross-multiplied. */
export const modelCompare = (a: Numeric, b: Numeric): -1 | 0 | 1 => {
	const ranks = kindRankOf(a) - kindRankOf(b)
	if (ranks !== 0 || !a.isFinite()) {
		return signOf(BigInt(ranks))
	}
	return signOf(signedOf(a) * 10n ** BigInt(scaleOf(b)) - signedOf(b) * 10n ** BigInt(scaleOf(a)))
}

export type OrderFeature =
	| "equal values"
	| "a special against a finite value"
	| "two specials"
	| "opposite signs"
	| "one sign, two scales"

/** A pair of values: two drawn apart, or one value and its text padded and read back, one value twice. */
export const orderedPairGen: Gen<readonly [Numeric, Numeric]> = weighted([
	[3, (source) => [source.draw(decimalGen), source.draw(decimalGen)] as const],
	[
		1,
		(source) => {
			const x = source.draw(decimalGen)
			const k = source.draw(trailingZeros)
			return [x, x.isFinite() ? succeeded(Numeric.fromString(padded(x.text, k))) : x] as const
		}
	]
])

/** The situations a pair of values is in. */
export const orderFeatures = (a: Numeric, b: Numeric): ReadonlyArray<OrderFeature> => [
	...(modelCompare(a, b) === 0 ? (["equal values"] as const) : []),
	...(a.isFinite() !== b.isFinite() ? (["a special against a finite value"] as const) : []),
	...(!a.isFinite() && !b.isFinite() ? (["two specials"] as const) : []),
	...(a.isFinite() && b.isFinite() && signedOf(a) * signedOf(b) < 0n
		? (["opposite signs"] as const)
		: []),
	...(a.isFinite() && b.isFinite() && signedOf(a) * signedOf(b) > 0n && scaleOf(a) !== scaleOf(b)
		? (["one sign, two scales"] as const)
		: [])
]

/** A typmod's precision or scale as a JavaScript caller passes it: an integer, a bound or past one, or no integer. */
export const typmodEntry: Gen<unknown> = weighted<unknown>([
	[4, int(numericMinScale - 100, numericMaxPrecision + 100)],
	[
		2,
		element<unknown>([
			0,
			1,
			numericMaxPrecision,
			numericMaxPrecision + 1,
			numericMinScale - 1,
			numericMinScale,
			numericMaxScale,
			numericMaxScale + 1
		])
	],
	[1, element<unknown>([-0, 0.5, 1.5, Number.NaN, "5", 2n, null, undefined])]
])

export const isInt = (x: unknown, min: number, max: number): x is number =>
	typeof x === "number" && Number.isInteger(x) && x >= min && x <= max

export type TypmodFeature =
	| "admitted"
	| "refused"
	| "admitted at a bound"
	| "refused one past a bound"

/** The situations a typmod's precision and scale are in, as numerictypmodin's limits place them. */
export const typmodFeatures = (
	precision: unknown,
	scale: unknown,
	admitted: boolean
): ReadonlyArray<TypmodFeature> => {
	const atBound =
		precision === 1 ||
		precision === numericMaxPrecision ||
		scale === numericMinScale ||
		scale === numericMaxScale
	const pastBound =
		precision === 0 ||
		precision === numericMaxPrecision + 1 ||
		scale === numericMinScale - 1 ||
		scale === numericMaxScale + 1
	return [
		admitted ? "admitted" : "refused",
		...(admitted && atBound ? (["admitted at a bound"] as const) : []),
		...(!admitted && pastBound ? (["refused one past a bound"] as const) : [])
	]
}

interface Typmod {
	readonly precision: number
	readonly scale: number
}

/**
 * A value and a typmod: the scale drawn free, or one digit short of the value's own scale, so the rounding cuts at the
 * value's last digit, where a tie is.
 */
export const normalizedGen: Gen<readonly [Numeric, Typmod]> = (source) => {
	const x = source.draw(decimalGen)
	const precision = source.draw(int(1, 40))
	const scale = source.draw(
		weighted([
			[3, int(-10, 45)],
			[1, constant(scaleOf(x) - 1)]
		])
	)
	return [x, { precision, scale }] as const
}

export type NormalizeFeature =
	| "kept"
	| "rounded"
	| "a tie rounded away"
	| "a negative scale"
	| "numericOverflow"
	| "numericInfinity"
	| "NaN kept"
	| "numericNaN"

/** 10^n for a whole number n. */
export const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** |v|. */
const magnitudeOf = (v: bigint): bigint => (v < 0n ? -v : v)

/**
 * Checks normalizeNumeric on one finite value against apply_typmod's rule in exact rational arithmetic: the value
 * rounds past p digits at scale s exactly when 2·|x|·10^s >= 2·10^p - 1, and otherwise is stored at scale s within half
 * a unit of x, a tie away from zero, idempotently.
 */
export const normalizedVerdict = (x: Numeric, type: Typmod): NormalizeFeature => {
	const result = normalizeNumeric(x, type)
	if (x.isNaN()) {
		if (type.scale === 0) {
			faulted(
				result,
				"numericNaN",
				`NaN at numeric(${type.precision}, 0), whose values are integers`
			)
			return "numericNaN"
		}
		assert.ok(succeeded(result).isNaN(), "NaN is kept")
		return "NaN kept"
	}
	if (!x.isFinite()) {
		faulted(result, "numericInfinity")
		return "numericInfinity"
	}
	const xs = scaleOf(x)
	const left = 2n * magnitudeOf(signedOf(x)) * (type.scale >= 0 ? pow10(type.scale) : 1n)
	const right = (2n * pow10(type.precision) - 1n) * pow10(xs + (type.scale >= 0 ? 0 : -type.scale))
	if (left >= right) {
		faulted(result, "numericOverflow", `${x.text} at numeric(${type.precision}, ${type.scale})`)
		return "numericOverflow"
	}
	const n = succeeded(result, `${x.text} at numeric(${type.precision}, ${type.scale})`)
	assert.ok(n.isFinite() && canonicalParts(n), `${n.text}: the one form`)
	const ns = scaleOf(n)
	assert.ok(ns <= Math.max(type.scale, 0), `${n.text} lies at scale ${type.scale}`)
	if (type.scale < 0) {
		assert.equal(signedOf(n) % pow10(-type.scale), 0n, `${n.text} lies at scale ${type.scale}`)
	}
	const units =
		type.scale >= ns ? signedOf(n) * pow10(type.scale - ns) : signedOf(n) / pow10(ns - type.scale)
	assert.ok(
		magnitudeOf(units) < pow10(type.precision),
		`${n.text} has at most ${type.precision} digits`
	)
	const k = Math.max(xs, ns)
	const difference = magnitudeOf(signedOf(x) * pow10(k - xs) - signedOf(n) * pow10(k - ns))
	const twice = 2n * difference * (type.scale >= 0 ? pow10(type.scale) : 1n)
	const unit = pow10(k + (type.scale >= 0 ? 0 : -type.scale))
	assert.ok(twice <= unit, `${n.text} lies within half a unit of ${x.text}`)
	assert.equal(succeeded(normalizeNumeric(n, type)).text, n.text, "idempotent")
	if (twice === unit) {
		assert.ok(
			magnitudeOf(signedOf(n)) * pow10(k - ns) > magnitudeOf(signedOf(x)) * pow10(k - xs),
			`${x.text} ties, and rounds away from zero`
		)
		return "a tie rounded away"
	}
	return type.scale < 0 ? "a negative scale" : n.equals(x) ? "kept" : "rounded"
}

/** Whether a text leads its integer digits with a zero before another digit, after its sign: no value's one text. */
export const leadsWithZero = (text: string): boolean => regex("^-?0[0-9]").test(text)

/** A value's one text with a zero led before its integer digits, after its sign: never a payload. */
const leadingZeroText: Gen<string> = map(decimalGen, (d) => {
	const text = d.toString()
	return Str.startsWith("-")(text) ? `-0${Str.slice(1)(text)}` : `0${text}`
})

/** What a text offered as a payload reached: a payload or none, and a leading zero. */
export type PayloadFeature = "a payload" | "no payload" | "a leading zero"

/**
 * Texts offered as payloads: strings of the characters a payload and its near misses are written with, and the
 * specials and a few near misses themselves, aimed at a value's text led by a zero.
 */
export const payloadTextSpace: Aimed<string, PayloadFeature> = aimed(
	oneOf<string>([
		string(
			characterOf(["0", "1", "9", ".", "-", "+", "e", "N", "a", "I", "n", "f", "i", "t", "y"]),
			{ min: 0, max: 12 }
		),
		element(["NaN", "Infinity", "-Infinity", "-0", "0.00", "1.50", "1.5", "10", "0.10"])
	]),
	[["a leading zero", leadingZeroText]]
)
