import {
	codePoint,
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
import { passed, type Wild, type WildKind, wild } from "@grizzle/testing/lsw"
import { Array as Arr, Option, Order } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { succeeded } from "#test/support/assert.ts"

export type { ValueFault }

/**
 * Digits biased toward the values where rounding decides: 9s carry into a new integer digit, 4s and 5s sit on either
 * side of a tie, 0s make trailing and leading zeros.
 */
const digit: Gen<string> = weighted([
	[4, constant("9")],
	[2, element(["4", "5", "0"])],
	[3, element(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])]
])

const digits = (max: number): Gen<string> => string(digit, { min: 0, max })

/** A part of a literal present five draws in six, or absent. */
const optional = <A>(generator: Gen<A>): Gen<A | undefined> =>
	map(option(generator), Option.getOrUndefined)

/** An exponent, present one draw in four. */
const exponent: Gen<number | undefined> = weighted([
	[1, constant(undefined)],
	[3, int(-30, 30)]
])

/**
 * An exact decimal literal: sign, integer digits, fraction digits, and sometimes an exponent. A literal with no integer
 * digit has fraction digits, so every drawn text is one.
 */
export const numericText: Gen<string> = (source) => {
	const sign = source.draw(element(["", "", "-", "+"]))
	const whole = source.draw(digits(24))
	const frac =
		whole.length === 0
			? source.draw(string(digit, { min: 1, max: 24 }))
			: source.draw(optional(digits(24)))
	const exp = source.draw(exponent)
	return `${sign}${whole}${frac === undefined ? "" : `.${frac}`}${exp === undefined ? "" : `e${exp}`}`
}

const finiteDecimal: Gen<Decimal> = map(numericText, (text) => succeeded(Decimal.fromString(text)))

/**
 * Shared helpers and generators for the value-carrier tests (test/unit/values and test/pg/values).
 */
export const decimalGen: Gen<Decimal> = weighted([
	[20, finiteDecimal],
	[1, element([Decimal.nan, Decimal.infinity, Decimal.negativeInfinity])]
])

/** The sign of a comparison's result; zero for zero or NaN. */
const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0)

/** The positions of `items` in ascending `compare` order, ties by position: the order `ORDER BY v, ord` returns. */
export const orderOf = <A>(
	items: ReadonlyArray<A>,
	compare: (a: A, b: A) => number
): ReadonlyArray<number> =>
	Arr.map(
		Arr.sort(
			Arr.map(items, (item, i) => [item, i] as const),
			Order.make(([a, i]: readonly [A, number], [b, j]: readonly [A, number]) => {
				const byValue = compare(a, b)
				return sign(byValue === 0 || Number.isNaN(byValue) ? i - j : byValue)
			})
		),
		([, i]) => i
	)

/**
 * Text at the boundary every host text passes (core/text.ts validateText): live well-formed text of any
 * plane, NUL-free, or that text with a NUL or an unpaired surrogate planted at a drawn position, or a value of another
 * kind (a wild value). PostgreSQL text holds neither NUL nor a lone surrogate, and a host that wrote one through
 * TextEncoder would store U+FFFD instead, a silently different value.
 */
export type PlantedString =
	| { readonly kind: "live"; readonly value: string }
	| {
			readonly kind: "nul" | "lone high" | "lone low" | "reversed pair"
			readonly value: string
			readonly at: "first" | "middle" | "last"
	  }

/**
 * A value of another kind is a wild value, held as data and made hostile only by `plantedValue` inside a property.
 */
export type PlantedText = PlantedString | { readonly kind: "not a string"; readonly wild: Wild }

/** The value a planted text passes to the boundary. */
export const plantedValue = (t: PlantedText): unknown =>
	t.kind === "not a string" ? passed({ kind: "wild", wild: t.wild }) : t.value

/** The fault validateText reports for a planted text: the kind first, then NUL, then a surrogate. */
export const plantedFault = (t: PlantedText): ValueFault | undefined =>
	t.kind === "live"
		? undefined
		: t.kind === "not a string"
			? "textType"
			: t.kind === "nul"
				? "textNul"
				: "textSurrogate"

const plants = {
	nul: "\u0000",
	"lone high": "\ud83d",
	"lone low": "\ude00",
	"reversed pair": "\ude00\ud83d"
} as const

/**
 * One scalar of well-formed text, never NUL: ASCII, the rest of the Basic Multilingual Plane past its surrogates, or
 * an astral scalar, each a third of the draws, so text mixes one-, two-, three- and four-byte UTF-8 and one- and
 * two-unit UTF-16.
 */
const scalar: Gen<string> = oneOf([
	codePoint(0x01, 0x7f),
	map(int(0x80, 0xff_ff - 0x8_00), (point) =>
		String.fromCodePoint(point >= 0xd8_00 ? point + 0x8_00 : point)
	),
	codePoint(0x1_00_00, 0x10_ff_ff)
])

const wellFormed: Gen<string> = string(scalar, { min: 0, max: 12 })

export const plantedStringGen: Gen<PlantedString> = oneOf([
	map(wellFormed, (value): PlantedString => ({ kind: "live", value })),
	(source): PlantedString => {
		const text = source.draw(wellFormed)
		const kind = source.draw(element(["nul", "lone high", "lone low", "reversed pair"] as const))
		/** A position between two scalars, so a planted surrogate never completes a pair already there. */
		const scalars = Array.from(text)
		const i = source.draw(int(0, scalars.length))
		const at = i === 0 ? "first" : i === scalars.length ? "last" : "middle"
		return {
			kind,
			value: Arr.join([...scalars.slice(0, i), plants[kind], ...scalars.slice(i)], ""),
			at
		}
	}
])

/**
 * The wild kinds whose values are never strings ("anything" may draw one; the lone surrogate and NUL kinds are strings).
 */
export const nonStringWildKinds: Arr.NonEmptyReadonlyArray<WildKind> = [
	"null",
	"undefined",
	"negative-zero",
	"nan",
	"infinity",
	"bigint-for-number",
	"number-for-bigint",
	"symbol",
	"function",
	"proxy",
	"throwing-getter"
]

export const plantedTextGen: Gen<PlantedText> = oneOf([
	plantedStringGen,
	map(wild(nonStringWildKinds), (drawn): PlantedText => ({ kind: "not a string", wild: drawn }))
])

/** The feature a planted text names. */
export type PlantedFeature =
	| "live"
	| "not a string"
	| `${"nul" | "lone high" | "lone low" | "reversed pair"} ${"first" | "middle" | "last"}`

export const plantedFeature = (t: PlantedText): PlantedFeature =>
	t.kind === "live" || t.kind === "not a string" ? t.kind : `${t.kind} ${t.at}`
