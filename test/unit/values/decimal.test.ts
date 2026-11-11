/**
 * The Decimal carrier (scalar/values/decimal.ts): numeric_in's exact spellings read to their one form, PostgreSQL's
 * numeric format limits, numeric_out text read back, the order and identity of values, the canonical payload, a
 * numeric(p, s) typmod's checks and rounding, and the literal boundary.
 *
 * - Spelling: every exact spelling numeric_in reads is the value its digits and exponent spell, written as numeric_out of
 *   trim_scale writes it, in parts that are the value's one form. Oracle: a model of numeric_in, the spelling's digits
 *   scaled by its exponent in bigint arithmetic and written with its trailing fractional zeros trimmed.
 * - Corruption: one corruption no exact spelling survives is refused as decimalSyntax. Oracle: the grammar's
 *   complement, each corruption a named case.
 * - Format limits: a value at numeric's fraction digits, integer digits (written out, by an exponent, as parts or as a
 *   bigint) or exponent magnitude is admitted as its one text, one past any is refused as decimalRange, and trailing
 *   fractional zeros past the fraction limit drop away before the limit is judged. Oracle: the limits as published
 *   (ir/scalar.ts, numeric.c's PG_INT32_MAX / 2), each case's one text written from them.
 * - Round trip: a value's text reads back to the value, its parts the one form, its parts padded by any trailing zeros
 *   the same value, and a negative coefficient refused as decimalType. Oracle: universal, fromString ∘ toString = id.
 * - numeric_out: a value's text padded to any display scale reads back to the value. Oracle: universal, fromOutput ∘ pad
 *   = id.
 * - Order: compare is cmp_numerics, -Infinity below every finite value below Infinity below NaN, NaN equal to NaN,
 *   finite values by value; equality, the one text and the parts agree with it. Oracle: a second implementation, the
 *   specials ranked and finite values compared by cross-multiplied signed coefficients.
 * - Payload: every value's text is a payload of the IR's grammar (ir/decimal.ts) encoding as the value does, and a text
 *   is a payload exactly when fromCanonical revives it. Oracle: a differential between the IR's grammar and the reviver.
 * - Typmod: checkNumericTypmod admits exactly integer precisions 1-numericMaxPrecision and scales
 *   numericMinScale-numericMaxScale. Oracle: numerictypmodin's rule as a checker.
 * - Typmod rounding: normalizeNumeric keeps NaN, refuses an infinity, refuses a value whose rounding has more than p
 *   digits at scale s, and otherwise stores the value at scale s within half a unit, a tie away from zero, idempotently.
 *   Oracle: apply_typmod's rule stated in exact rational arithmetic apart from roundedUnits.
 * - Literal boundary: Decimal.parse reads a decimal string or a bigint, refuses a number as decimalNumber and any other
 *   value as decimalType, and admit raises only CompileError. Oracle: the boundary's specification as a checker.
 *
 * Features: each spelling feature, each corruption, each limit at and past it by each entry, padded and canonical
 * outputs, equal and unequal pairs of each kind, admitted and refused typmods at their bounds, each rounding outcome,
 * and every wild kind.
 *
 * Plants: values-decimal-integer-zeros (a spelling's integer trailing zeros dropped from its exponent),
 * values-decimal-bare-exponent (an exponent mark with no digits read as e0), values-decimal-fraction-limit (a value
 * at the fraction limit refused), values-decimal-negative-coefficient (fromParts takes a negative coefficient),
 * values-decimal-output-zeros (fromOutput keeps a padded text's zeros), values-decimal-nan-low (NaN ranked below
 * -Infinity), values-decimal-payload-unsigned (the IR's grammar refuses a negative payload),
 * values-decimal-payload-leading-zero (the IR's grammar takes a leading zero), values-numeric-typmod-precision (the
 * greatest precision refused), values-numeric-tie-toward-zero (a tie rounded toward zero),
 * values-decimal-number-admitted (a number read through its text).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
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
} from "@grizzle/testing/gen"
import { type DrawnFeature, drawnFeature, lsw, passed, WILD_KINDS } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, String as Str } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { isCompileError, type ValueFault } from "#compiler/core/errors.ts"
import { int4Max } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { DecimalText, isDecimalPayload } from "#compiler/ir/decimal.ts"
import {
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/ir/scalar.ts"
import { checkNumericTypmod, Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { assert, defined, faulted, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { decimalGen, numericText } from "#test/unit/values/support.ts"

import { regex } from "arkregex"

/**
 * An exact spelling numeric_in reads, with the one text of the value it reads (numeric_out of trim_scale(value)) and
 * what the spelling exercises.
 */
type SpellingFeature =
	| "signed"
	| "leading zeros"
	| "a bare point"
	| "an exponent"
	| "a zero"
	| "a special"
	| "trailing zeros"
	| "forty trailing zeros"

const spellingFeatures: Arr.NonEmptyReadonlyArray<SpellingFeature> = [
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
const trailingZeros: Gen<number> = weighted([
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
const padded = (text: string, k: number): string =>
	k === 0 ? text : `${Str.includes(".")(text) ? text : `${text}.`}${zeros(k)}`

/** Whether a Decimal's parts are its one form: no trailing zero past the point, zero unsigned at scale 0. */
const canonicalParts = (d: Decimal): boolean => {
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
const sameParts = (a: Decimal, b: Decimal): boolean => {
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

const spellingGen: Gen<Spelling> = weighted([
	[9, exactSpelling],
	[1, specialSpelling]
])

/** One corruption no exact spelling survives, planted at a drawn position where it has one. */
type Corruption =
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

const corruptions: Arr.NonEmptyReadonlyArray<Corruption> = [
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

const corrupted = (text: string, corruption: Corruption, at: number): string => {
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
			return `${text}e`
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
const maxExponent = Math.trunc(int4Max.value / 2)

/** A limit of PostgreSQL's numeric format, and trailing zeros that run past one and drop away. */
type FormatLimit =
	| "fraction digits"
	| "integer digits"
	| "an exponent's integer digits"
	| "an exponent's magnitude"
	| "zeros past the fraction digits"

const formatLimits: Arr.NonEmptyReadonlyArray<FormatLimit> = [
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

const formatCaseGen: Gen<FormatCase> = (source) => {
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
const formatValueOf = (c: FormatCase): Result.Result<Decimal, ValueFault> => {
	const sign = c.negative ? "-" : ""
	const fraction = numericMaxFractionDigits.value + c.margin
	const integer = numericMaxIntegerDigits.value + c.margin
	switch (c.limit) {
		case "fraction digits":
			return c.entry === "text"
				? Decimal.fromString(`${sign}0.${zeros(fraction - 1)}1`)
				: Decimal.fromParts(c.negative, 1n, fraction)
		case "integer digits": {
			const nines = 10n ** BigInt(integer) - 1n
			return c.entry === "text"
				? Decimal.fromString(`${sign}${Str.repeat(integer)("9")}`)
				: c.entry === "parts"
					? Decimal.fromParts(c.negative, nines, 0)
					: Decimal.fromBigInt(c.negative ? -nines : nines)
		}
		case "an exponent's integer digits":
			return Decimal.fromString(`${sign}1e${integer - 1}`)
		case "an exponent's magnitude":
			return Decimal.fromString(`0e${sign}${maxExponent + c.margin}`)
		case "zeros past the fraction digits":
			return c.entry === "text"
				? Decimal.fromString(`${sign}1.${zeros(fraction)}`)
				: Decimal.fromParts(c.negative, 10n ** BigInt(fraction), fraction)
	}
}

/** The one text of a format case admitted: the value at its limit, or the one the zeros drop away to. */
const formatTextOf = (c: FormatCase): string => {
	const sign = c.negative ? "-" : ""
	switch (c.limit) {
		case "fraction digits":
			return `${sign}0.${zeros(numericMaxFractionDigits.value - 1)}1`
		case "integer digits":
			return `${sign}${Str.repeat(numericMaxIntegerDigits.value)("9")}`
		case "an exponent's integer digits":
			return `${sign}1${zeros(numericMaxIntegerDigits.value - 1)}`
		case "an exponent's magnitude":
			return "0"
		case "zeros past the fraction digits":
			return `${sign}1`
	}
}

type FormatFeature = `${FormatLimit} ${Side}` | `by ${Entry}` | "an exponent far past"

/** A finite value's signed coefficient. */
const signedOf = (d: Decimal): bigint => {
	const p = d.parts
	return p.kind !== "finite" ? 0n : p.negative ? -p.coefficient : p.coefficient
}

/** A finite value's scale, zero for a special. */
const scaleOf = (d: Decimal): number => (d.parts.kind === "finite" ? d.parts.minScale : 0)

/** The order a difference states: -1, 0 or 1. */
const signOf = (n: bigint): -1 | 0 | 1 => (n < 0n ? -1 : n > 0n ? 1 : 0)

/** cmp_numerics' rank of a value's kind: -Infinity, finite, Infinity, NaN. */
const kindRankOf = (d: Decimal): number =>
	d.parts.kind === "-infinity"
		? 0
		: d.parts.kind === "finite"
			? 1
			: d.parts.kind === "infinity"
				? 2
				: 3

/** cmp_numerics, modelled: kinds by rank, finite values by their signed coefficients cross-multiplied. */
const modelCompare = (a: Decimal, b: Decimal): -1 | 0 | 1 => {
	const ranks = kindRankOf(a) - kindRankOf(b)
	if (ranks !== 0 || !a.isFinite()) {
		return signOf(BigInt(ranks))
	}
	return signOf(signedOf(a) * 10n ** BigInt(scaleOf(b)) - signedOf(b) * 10n ** BigInt(scaleOf(a)))
}

type OrderFeature =
	| "equal values"
	| "a special against a finite value"
	| "two specials"
	| "opposite signs"
	| "one sign, two scales"

/** A pair of values: two drawn apart, or one value and its text padded and read back, one value twice. */
const orderedPairGen: Gen<readonly [Decimal, Decimal]> = weighted([
	[3, (source) => [source.draw(decimalGen), source.draw(decimalGen)] as const],
	[
		1,
		(source) => {
			const x = source.draw(decimalGen)
			const k = source.draw(trailingZeros)
			return [x, x.isFinite() ? succeeded(Decimal.fromString(padded(x.text, k))) : x] as const
		}
	]
])

/** The situations a pair of values is in. */
const orderFeatures = (a: Decimal, b: Decimal): ReadonlyArray<OrderFeature> => [
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
const typmodEntry: Gen<unknown> = weighted<unknown>([
	[4, int(numericMinScale.value - 100, numericMaxPrecision.value + 100)],
	[
		2,
		element<unknown>([
			0,
			1,
			numericMaxPrecision.value,
			numericMaxPrecision.value + 1,
			numericMinScale.value - 1,
			numericMinScale.value,
			numericMaxScale.value,
			numericMaxScale.value + 1
		])
	],
	[1, element<unknown>([-0, 0.5, 1.5, Number.NaN, "5", 2n, null, undefined])]
])

const isInt = (x: unknown, min: number, max: number): x is number =>
	typeof x === "number" && Number.isInteger(x) && x >= min && x <= max

type TypmodFeature = "admitted" | "refused" | "admitted at a bound" | "refused one past a bound"

/** The situations a typmod's precision and scale are in, as numerictypmodin's limits place them. */
const typmodFeatures = (
	precision: unknown,
	scale: unknown,
	admitted: boolean
): ReadonlyArray<TypmodFeature> => {
	const atBound =
		precision === 1 ||
		precision === numericMaxPrecision.value ||
		scale === numericMinScale.value ||
		scale === numericMaxScale.value
	const pastBound =
		precision === 0 ||
		precision === numericMaxPrecision.value + 1 ||
		scale === numericMinScale.value - 1 ||
		scale === numericMaxScale.value + 1
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
const normalizedGen: Gen<readonly [Decimal, Typmod]> = (source) => {
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

type NormalizeFeature =
	| "kept"
	| "rounded"
	| "a tie rounded away"
	| "a negative scale"
	| "numericOverflow"
	| "numericInfinity"
	| "NaN kept"

/** 10^n for a whole number n. */
const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** |v|. */
const magnitudeOf = (v: bigint): bigint => (v < 0n ? -v : v)

/**
 * Checks normalizeNumeric on one finite value against apply_typmod's rule in exact rational arithmetic: the value
 * rounds past p digits at scale s exactly when 2·|x|·10^s >= 2·10^p - 1, and otherwise is stored at scale s within half
 * a unit of x, a tie away from zero, idempotently.
 */
const normalizedVerdict = (x: Decimal, type: Typmod): NormalizeFeature => {
	const result = normalizeNumeric(x, type)
	if (x.isNaN()) {
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

describe("Decimal parsing", () => {
	it.effect("reads every exact spelling to numeric_in's value, in its one form", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "numeric_in modelled: the digits scaled by the exponent in bigint arithmetic, trailing fractional zeros trimmed"
					},
					suite: "unit/values/decimal-spelling",
					draw: drawn(spellingGen),
					literal: Formatter.format,
					coverage: required<SpellingFeature>(spellingFeatures, { cases: 2000, sense: notesOnly }),
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(spelling, c) =>
					Effect.sync(() => {
						c.noteAll(spelling.features)
						const d = succeeded(Decimal.fromString(spelling.text))
						assert.equal(d.toString(), spelling.canonical, spelling.text)
						assert.ok(canonicalParts(d), `${spelling.text}: its parts are the one form`)
					})
			)
		)
	)

	it.effect("refuses every spelling one corruption breaks", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the exact grammar's complement: each corruption spells no exact decimal"
					},
					suite: "unit/values/decimal-corrupted",
					draw: drawn((source) => ({
						spelling: source.draw(spellingGen),
						corruption: source.draw(element(corruptions)),
						at: source.draw(pickGen)
					})),
					literal: Formatter.format,
					coverage: required<Corruption>(corruptions, { cases: 1000, sense: notesOnly }),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ spelling, corruption, at }, c) =>
					Effect.sync(() => {
						c.note(corruption)
						const text = corrupted(spelling.text, corruption, at)
						faulted(Decimal.fromString(text), "decimalSyntax", Formatter.format(text))
					})
			)
		)
	)

	it.effect(
		"admits a value at each of PostgreSQL's numeric format limits as its one text, refuses one past, and drops zeros past the fraction limit",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "numeric's published format limits and set_var_from_str's exponent limit, each case's one text written from them"
						},
						suite: "unit/values/decimal-limits",
						draw: drawn(formatCaseGen),
						literal: Formatter.format,
						coverage: required<FormatFeature>(
							[
								...Arr.flatMap(formatLimits, (limit) => [
									`${limit} at` as const,
									`${limit} past` as const
								]),
								"by text",
								"by parts",
								"by bigint",
								"an exponent far past"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(formatCase, c) =>
						Effect.sync(() => {
							c.note(`${formatCase.limit} ${formatCase.side}`)
							c.note(`by ${formatCase.entry}`)
							if (formatCase.limit === "an exponent's magnitude" && formatCase.margin > 4) {
								c.note("an exponent far past")
							}
							const value = formatValueOf(formatCase)
							if (
								formatCase.side === "past" &&
								formatCase.limit !== "zeros past the fraction digits"
							) {
								faulted(value, "decimalRange")
							} else {
								assert.equal(succeeded(value).text, formatTextOf(formatCase))
							}
						})
				)
			)
	)

	it.effect(
		"round-trips its own text exactly, its parts padded by zeros are the value, and refuses a negative coefficient",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "fromString ∘ toString = id, and fromParts ∘ pad = id"
						},
						suite: "unit/values/decimal-1",
						draw: drawn((source) => [source.draw(decimalGen), source.draw(trailingZeros)] as const),
						literal: Formatter.format,
						coverage: required<"unpadded parts" | "padded parts" | "special">(
							["unpadded parts", "padded parts", "special"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([x, k], c) =>
						Effect.sync(() => {
							const back = succeeded(Decimal.fromString(x.toString()))
							assert.equal(back.toString(), x.toString())
							assert.ok(sameParts(back, x))
							assert.equal(back.equals(x), true)
							assert.ok(canonicalParts(x))
							if (!x.isFinite()) {
								c.note("special")
								return
							}
							c.note(k > 0 ? "padded parts" : "unpadded parts")
							const { negative, coefficient, minScale } = x.parts
							const scaled = succeeded(
								Decimal.fromParts(negative, coefficient * pow10(k), minScale + k)
							)
							assert.ok(sameParts(scaled, x), `fromParts at scale ${minScale + k}`)
							assert.equal(scaled.text, x.text)
							if (coefficient > 0n) {
								faulted(Decimal.fromParts(negative, -coefficient, minScale), "decimalType")
							}
						})
				)
			)
	)

	it.effect(
		"converts numeric_out text at every display scale to the value's one form, its text and parts the value's",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "universal", name: "fromOutput ∘ pad = id at every display scale" },
						suite: "unit/values/decimal-2",
						draw: drawn(
							(source) =>
								[source.draw(decimalGen), source.draw(element([0, 1, 8, 24, 40]))] as const
						),
						literal: Formatter.format,
						coverage: required<"padded" | "canonical" | "special">(
							["padded", "canonical", "special"],
							{
								cases: 2000,
								sense: notesOnly
							}
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([x, k], c) =>
						Effect.sync(() => {
							const text = x.isFinite() ? padded(x.text, k) : x.text
							c.note(!x.isFinite() ? "special" : k === 0 ? "canonical" : "padded")
							const converted = Decimal.fromOutput(text)
							assert.equal(converted.text, x.text, text)
							assert.ok(sameParts(converted, x), `${text}: the parts of ${x.text}`)
							assert.ok(converted.equals(x))
						})
				)
			)
	)
})

describe("Decimal identity and order", () => {
	it.effect("orders as cmp_numerics, and equality, text and parts agree with the order", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "cmp_numerics modelled: kinds ranked -Infinity, finite, Infinity, NaN; finite values by cross-multiplied signed coefficients"
					},
					suite: "unit/values/decimal-3",
					draw: drawn(orderedPairGen),
					literal: Formatter.format,
					coverage: required<OrderFeature>(
						[
							"equal values",
							"a special against a finite value",
							"two specials",
							"opposite signs",
							"one sign, two scales"
						],
						{ cases: 400, sense: notesOnly }
					),
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([a, b], c) =>
					Effect.sync(() => {
						c.noteAll(orderFeatures(a, b))
						const model = modelCompare(a, b)
						assert.equal(a.compare(b), model, `${a.text} against ${b.text}`)
						assert.equal(a.equals(b), model === 0)
						assert.equal(a.toString() === b.toString(), model === 0)
						assert.equal(sameParts(a, b), model === 0)
					})
			)
		)
	)
})

describe("Decimal in the canonical serializer", () => {
	it.effect("writes every value as a payload of the IR's decimal grammar (ir/decimal.ts)", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "the IR's payload grammar (DecimalText.parse) beside the Decimal that wrote the text"
					},
					suite: "unit/values/decimal-19182",
					draw: drawn(decimalGen),
					literal: Formatter.format,
					coverage: required<"finite" | "negative" | "special">(["finite", "negative", "special"], {
						cases: 200,
						sense: notesOnly
					}),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(x, c) =>
					Effect.sync(() => {
						c.note(!x.isFinite() ? "special" : signedOf(x) < 0n ? "negative" : "finite")
						const text = x.toString()
						assert.equal(isDecimalPayload(text), true)
						assert.equal(
							succeeded(encode(defined(DecimalText.parse(text)), everyProperty)),
							succeeded(encode(x, everyProperty))
						)
					})
			)
		)
	)

	it.effect("takes a text as a payload exactly when the reviver revives it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "the IR's payload grammar (isDecimalPayload) beside the reviver (Decimal.fromCanonical)"
					},
					suite: "unit/values/decimal-19183",
					draw: drawn(
						oneOf<string>([
							string(
								characterOf([
									"0",
									"1",
									"9",
									".",
									"-",
									"+",
									"e",
									"N",
									"a",
									"I",
									"n",
									"f",
									"i",
									"t",
									"y"
								]),
								{ min: 0, max: 12 }
							),
							element(["NaN", "Infinity", "-Infinity", "-0", "0.00", "1.50", "1.5", "10", "0.10"])
						])
					),
					literal: Formatter.format,
					coverage: required<"a payload" | "no payload">(["a payload", "no payload"], {
						cases: 200,
						sense: notesOnly
					}),
					kept: [],
					runs: 5000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(text, c) =>
					Effect.sync(() => {
						const payload = isDecimalPayload(text)
						c.note(payload ? "a payload" : "no payload")
						assert.equal(payload, Decimal.fromCanonical(text).ok, text)
					})
			)
		)
	)
})

describe("numeric(p, s) normalization", () => {
	it.effect(
		"validates precision and scale as numerictypmodin does: both integers within its limits, both given",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "numerictypmodin's rule: an integer precision 1-numericMaxPrecision and scale numericMinScale-numericMaxScale"
						},
						suite: "unit/values/numeric-typmod",
						draw: drawn((source) => [source.draw(typmodEntry), source.draw(typmodEntry)] as const),
						literal: Formatter.format,
						coverage: required<TypmodFeature>(
							["admitted", "refused", "admitted at a bound", "refused one past a bound"],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([precision, scale], c) =>
						Effect.sync(() => {
							const admitted =
								isInt(precision, 1, numericMaxPrecision.value) &&
								isInt(scale, numericMinScale.value, numericMaxScale.value)
							c.noteAll(typmodFeatures(precision, scale, admitted))
							if (admitted) {
								assert.deepEqual(succeeded(checkNumericTypmod(precision, scale)), {
									precision,
									scale: scale + 0
								})
							} else {
								faulted(checkNumericTypmod(precision, scale), "numericTypmod")
							}
						})
				)
			)
	)

	it.effect(
		"keeps NaN, refuses an infinity or a value rounding past p digits, and stores the rest at scale s within half a unit, a tie away from zero, idempotently",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "apply_typmod's rule in exact rational arithmetic, apart from roundedUnits"
						},
						suite: "unit/values/decimal-4",
						draw: drawn(normalizedGen),
						literal: Formatter.format,
						coverage: required<NormalizeFeature>(
							[
								"kept",
								"rounded",
								"a tie rounded away",
								"a negative scale",
								"numericOverflow",
								"numericInfinity",
								"NaN kept"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([x, type], c) =>
						Effect.sync(() => {
							c.note(normalizedVerdict(x, type))
						})
				)
			)
	)
})

describe("Decimal admission of a JavaScript caller's value", () => {
	it.effect(
		"parses a decimal string, refuses a value of no decimal host kind as decimalType, and admit raises only CompileError",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the literal boundary: a string or bigint read, a number decimalNumber, every other value decimalType"
						},
						suite: "unit/values/decimal-wild",
						draw: drawn(lsw<string>({ live: numericText, stale: Option.none(), wild: WILD_KINDS })),
						literal: Formatter.format,
						coverage: required<DrawnFeature<never>>(
							["live", ...Arr.map(WILD_KINDS, (kind): DrawnFeature<never> => `wild ${kind}`)],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d, c) =>
						Effect.sync(() => {
							c.note(drawnFeature(d))
							const value = passed(d)
							const parsed = Decimal.parse(value)
							if (d.kind === "live") {
								succeeded(parsed)
							}
							const host = typeof value
							if (host !== "string" && host !== "bigint" && host !== "number") {
								faulted(parsed, "decimalType")
							}
							if (typeof value === "number") {
								faulted(parsed, "decimalNumber")
							}
							if (typeof value === "bigint") {
								assert.equal(succeeded(parsed).toString(), value.toString())
							}
							if (parsed.ok) {
								assert.equal(Decimal.admit(value).equals(parsed.value), true)
							} else {
								assert.throws(() => Decimal.admit(value), isCompileError)
							}
						})
				)
			)
	)
})
