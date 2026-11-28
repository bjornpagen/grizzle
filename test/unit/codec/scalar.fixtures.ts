/** What the properties of scalar.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { bigint, float } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, DateTime, pipe, String as Str } from "effect"
import { int4Max } from "#compiler/core/canonical.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { int4Min, int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { CarrierHost } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import type { StrictFault } from "#test/support/kernel/strict.ts"
import { codecOf, codecTypes, kindCodes } from "#test/support/unit/codec/support.ts"

interface Written {
	readonly value: CarrierHost[Carrier]
	readonly text: string
}

/** The digits of n, signed, without a leading zero: int8out's form, and the integer part of numeric_out's. */
const digitsOf = (n: bigint): string => n.toString()

/** A decimal's numeric_out text from its sign, magnitude and display scale. */
const decimalText = (negative: boolean, magnitude: bigint, scale: number): string => {
	const digits = pipe(magnitude.toString(), Str.padStart(scale + 1, "0"))
	const whole = scale === 0 ? digits : Str.slice(0, -scale)(digits)
	const text = scale === 0 ? whole : `${whole}.${Str.slice(-scale)(digits)}`
	return negative && magnitude !== 0n ? `-${text}` : text
}

const writtenDecimal = (precisionDigits: number, scaleMax: number): Gen<Written> =>
	map(
		(source) => ({
			negative: source.draw(boolean),
			scale: source.draw(int(0, scaleMax)),
			magnitude: source.draw(bigint(0n, 10n ** BigInt(precisionDigits) - 1n))
		}),
		({ negative, scale, magnitude }) => {
			const text = decimalText(negative, magnitude, scale)
			return { value: Decimal.of(text), text }
		}
	)

/**
 * A span of endpoints from `lo` to `hi`, built ordered: a start below `hi`, then an end past the start, and its half-open
 * text.
 */
const writtenSpan4 =
	(lo: number, hi: number): Gen<Written> =>
	(source) => {
		const start = source.draw(int(lo, hi - 1))
		const end = source.draw(int(start + 1, hi))
		return { value: { start, end }, text: `[${start},${end})` }
	}

const writtenSpan8 =
	(lo: bigint, hi: bigint): Gen<Written> =>
	(source) => {
		const start = source.draw(bigint(lo, hi - 1n))
		const end = source.draw(bigint(start + 1n, hi))
		return { value: { start, end }, text: `[${start},${end})` }
	}

/** The days past 0001-01-01 of the calendar's last date, 9999-12-31. */
const lastDay = 3_652_058

/** A calendar date's text at a count of days past 0001-01-01, by the proleptic Gregorian calendar. */
const dateAt = (day: number): CalendarDate =>
	succeeded(
		toCalendarDate(
			DateTime.formatIsoDateUtc(DateTime.makeUnsafe({ year: 1, month: 1, day: 1 + day }))
		),
		"a calendar date's text"
	)

/** A span of two days, built ordered: a start before the last day, then a later end, as daterange_out writes it. */
const writtenDateSpan: Gen<Written> = (source) => {
	const first = source.draw(int(0, lastDay - 1))
	const start = dateAt(first)
	const end = dateAt(source.draw(int(first + 1, lastDay)))
	return { value: { start, end }, text: `[${start},${end})` }
}

/** Text PostgreSQL stores: no NUL and no lone surrogate. */
const storableText = string(
	weighted([
		[1, codePoint(0x20, 0x7e)],
		[1, codePoint(0xa0, 0xd7_ff)],
		[1, codePoint(0xe0_00, 0x10_ffff)]
	]),
	{ min: 0, max: 12 }
)

const intWritten = (min: number, max: number): Gen<Written> =>
	map(int(min, max), (n) => ({ value: n, text: digitsOf(BigInt(n)) }))

/**
 * A carrier's codec under test: its Live values with their texts, the values its encoder refuses with the word for
 * each, and the texts the strict reading refuses with the word for each.
 */
export interface Carried {
	readonly type: ScalarType
	readonly live: Gen<Written>
	readonly refusedValues: ReadonlyArray<readonly [unknown, CodecFault]>
	readonly refusedTexts: ReadonlyArray<readonly [string, StrictFault]>
}

const fixed4 = scalarOf(f.span(f.integer, 15n), {})
const fixed8 = scalarOf(f.span(f.bigint, int8Max), {})
const refined = scalarOf(f.regex("^[a-z]+$", "u"), {})
const integerSyntax = Object.freeze(["", "+1", "01", "-0", "1.0", " 1", "1e3", "١"])

export const carried = {
	int2: {
		type: codecTypes.int2,
		live: intWritten(-32768, 32767),
		refusedValues: [
			[40000, "integerRange"],
			[1n, "integerType"],
			[1.5, "integerType"]
		],
		refusedTexts: [
			["32768", "integerRange"],
			...Arr.map(integerSyntax, (t) => [t, "integerSyntax"] as const)
		]
	},
	int4: {
		type: codecTypes.int4,
		live: intWritten(-(2 ** 31), 2 ** 31 - 1),
		refusedValues: [
			[1n, "integerType"],
			[1.5, "integerType"]
		],
		refusedTexts: [
			["2147483648", "integerRange"],
			...Arr.map(integerSyntax, (t) => [t, "integerSyntax"] as const)
		]
	},
	int8: {
		type: codecTypes.int8,
		live: map(bigint(int8Min, int8Max), (n) => ({ value: n, text: digitsOf(n) })),
		refusedValues: [[1, "integerType"]],
		refusedTexts: [
			["9223372036854775808", "integerRange"],
			...Arr.map(integerSyntax, (t) => [t, "integerSyntax"] as const)
		]
	},
	numeric: {
		type: codecTypes.numeric,
		live: weighted([
			[9, writtenDecimal(30, 12)],
			[
				1,
				element<Written>([
					{ value: Decimal.nan, text: "NaN" },
					{ value: Decimal.infinity, text: "Infinity" },
					{ value: Decimal.negativeInfinity, text: "-Infinity" }
				])
			]
		]),
		refusedValues: [
			[1.5, "decimalNumber"],
			["1.5", "decimalType"]
		],
		refusedTexts: Arr.map(
			["+1", "1e3", ".5", "5.", "01", " 1", "nan", "inf", "-0"],
			(t) => [t, "numericSyntax"] as const
		)
	},
	"numeric(7,2)": {
		type: codecTypes.numeric72,
		live: map(writtenDecimal(5, 0), ({ text: digits }) => {
			const text = `${digits}.00`
			return { value: Decimal.of(text), text }
		}),
		refusedValues: [],
		refusedTexts: [
			["1.5", "numericShape"],
			["123456.00", "numericShape"],
			["Infinity", "numericShape"]
		]
	},
	"numeric(5,-2)": {
		type: codecTypes.numericNeg,
		live: map(int(-99999, 99999), (n) => {
			const text = digitsOf(BigInt(n) * 100n)
			return { value: Decimal.of(text), text }
		}),
		refusedValues: [],
		refusedTexts: [["12345", "numericShape"]]
	},
	money: {
		type: codecTypes.money,
		live: map(bigint(int8Min, int8Max), (minor) => ({
			value: Money.of(minor),
			text: decimalText(minor < 0n, minor < 0n ? -minor : minor, 2)
		})),
		refusedValues: [[-1205n, "moneyType"]],
		refusedTexts: [
			["1.005", "moneyShape"],
			["92233720368547758.08", "moneyShape"],
			["NaN", "moneyShape"],
			["$12.05", "numericSyntax"]
		]
	},
	bool: {
		type: codecTypes.bool,
		live: map(boolean, (b) => ({ value: b, text: b ? "true" : "false" })),
		refusedValues: [
			[1, "boolType"],
			["true", "boolType"]
		],
		refusedTexts: Arr.map(["T", "yes", "1", "on", ""], (t) => [t, "boolSyntax"] as const)
	},
	text: {
		type: codecTypes.text,
		live: map(storableText, (t) => ({ value: t, text: t })),
		refusedValues: [
			["a\u0000b", "textNul"],
			["\ud800", "textSurrogate"]
		],
		refusedTexts: []
	},
	"regex text": {
		type: refined,
		/** No regex runs on the host: a value outside the pattern is the database's to refuse. */
		live: map(storableText, (t) => ({ value: t, text: t })),
		refusedValues: [],
		refusedTexts: []
	},
	/** A closed id's text is its code's digits under kindCodes: Manual 0, Automatic 1, Ünïcode 2. */
	code: {
		type: codecTypes.kind,
		live: map(element(["Manual", "Automatic", "Ünïcode"] as const), (h) => ({
			value: h,
			text: String(["Manual", "Automatic", "Ünïcode"].indexOf(h))
		})),
		refusedValues: [["manual", "codeHandle"]],
		refusedTexts: [
			["3", "codeHandle"],
			["-1", "codeHandle"],
			["Manual", "integerSyntax"],
			["01", "integerSyntax"]
		]
	},
	/**
	 * A set's text is bit(8), three codes rounded up to a whole byte, position c code c under kindCodes and the
	 * padding positions 3 to 7 always 0: a 1 there names no handle.
	 */
	bits: {
		type: codecTypes.kinds,
		live: map(array(boolean, { min: 3, max: 3 }), (held) => ({
			value: new Set(Arr.filter(["Manual", "Automatic", "Ünïcode"], (_, c) => held[c] === true)),
			text: `${Arr.join(
				Arr.map(held, (b) => (b ? "1" : "0")),
				""
			)}00000`
		})),
		refusedValues: [
			[new Set(["Other"]), "bitsMember"],
			[["Manual"], "bitsType"]
		],
		refusedTexts: [
			["101", "bitsSyntax"],
			["10100", "bitsSyntax"],
			["1001", "bitsSyntax"],
			["1x000000", "bitsSyntax"],
			["10000001", "bitsMember"]
		]
	},
	int4range: {
		type: codecTypes.range4,
		live: writtenSpan4(int4Min, int4Max),
		refusedValues: [
			[{ start: 2, end: 2 }, "spanOrder"],
			[{ start: 1n, end: 2n }, "spanEndpoint"]
		],
		refusedTexts: Arr.map(
			["empty", "(1,2)", "[1,2]", "[,2)", "[1,)", "[2,1)", "[1, 2)", "[01,2)", "[1,2147483648)"],
			(t) => [t, "spanSyntax"] as const
		)
	},
	int8range: {
		type: codecTypes.range8,
		live: writtenSpan8(int8Min, int8Max),
		refusedValues: [[{ start: 1, end: 2 }, "spanEndpoint"]],
		refusedTexts: []
	},
	daterange: {
		type: codecTypes.rangeDate,
		live: writtenDateSpan,
		refusedValues: [
			[{ start: "2024-03-01", end: "2024-02-29" }, "spanOrder"],
			[{ start: "2024-02-30", end: "2024-03-01" }, "spanEndpoint"],
			[{ start: 1, end: 2 }, "spanEndpoint"]
		],
		refusedTexts: Arr.map(
			[
				"empty",
				"(2024-02-28,2024-03-01)",
				"[2024-02-28,2024-03-01]",
				"[2024-03-01,2024-02-28)",
				"[2024-02-28,infinity)",
				"[2024-02-30,2024-03-01)",
				"[2024-02-28, 2024-03-01)"
			],
			(t) => [t, "spanSyntax"] as const
		)
	},
	"int4range of width 15": {
		type: fixed4,
		live: map(int(-(2 ** 31), 2 ** 31 - 16), (start) => ({
			value: { start, end: start + 15 },
			text: `[${start},${start + 15})`
		})),
		refusedValues: [
			[{ start: 0, end: 14 }, "spanWidth"],
			[{ start: 0, end: 16 }, "spanWidth"],
			[{ start: 15, end: 0 }, "spanOrder"]
		],
		refusedTexts: []
	},
	"int8range of width int8 max": {
		type: fixed8,
		/** The width is exact over bigint, where end - start can exceed every bigint. */
		live: map(bigint(-1n, 0n), (start) => ({
			value: { start, end: start + int8Max },
			text: `[${start},${start + int8Max})`
		})),
		refusedValues: [
			[{ start: int8Min, end: int8Max }, "spanWidth"],
			[{ start: 1n, end: int8Max }, "spanWidth"]
		],
		refusedTexts: []
	},
	vector: {
		type: codecTypes.embedding,
		live: constant<Written>({
			value: Vector.make(Float32Array.of(1, 2, 3, 4), 4),
			text: "[1,2,3,4]"
		}),
		refusedValues: [
			[Vector.make(Float32Array.of(0, 0, 0, 0), 4), "vectorNorm"],
			[Vector.make(Float32Array.of(1, 2, 3), 3), "vectorDimensions"],
			[[1, 2, 3, 4], "vectorType"],
			[Vector.make(Float32Array.of(1, 2, Number.NaN, 4), 4), "vectorNonFinite"]
		],
		refusedTexts: [
			["[1,2,3,4,5]", "vectorDimensions"],
			["[1,2,3]", "vectorDimensions"],
			["[1,2,3,NaN]", "vectorSyntax"],
			["[1,2,3,4e39]", "vectorOverflow"],
			["1,2,3,4", "vectorSyntax"],
			["[1, 2,3,4]", "vectorSyntax"]
		]
	}
} as const satisfies Readonly<Record<string, Carried>>

type CarriedName = keyof typeof carried
const carriedNames: Arr.NonEmptyReadonlyArray<CarriedName> = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"numeric(7,2)",
	"numeric(5,-2)",
	"money",
	"bool",
	"text",
	"regex text",
	"code",
	"bits",
	"int4range",
	"int8range",
	"daterange",
	"int4range of width 15",
	"int8range of width int8 max",
	"vector"
]

export type FormFeature =
	`${CarriedName} ${"written" | "value refused" | "text refused" | "null refused"}`

/** The two absences a carrier refuses to encode, by name. */
export const absences = { null: null, undefined: undefined } as const

type FormCase =
	| { readonly kind: "written"; readonly written: Written }
	| { readonly kind: "value refused"; readonly planted: readonly [unknown, CodecFault] }
	| { readonly kind: "text refused"; readonly planted: readonly [string, StrictFault] }
	| { readonly kind: "null refused"; readonly absent: keyof typeof absences }

/** One form of a carrier: the feature its cases reach, and the space of those cases. */
type Form = readonly [FormFeature, Gen<FormCase>]

/**
 * A carrier's forms, a written value first, then each refusal it plants: the null ban every encoder holds, its refused
 * values and its refused texts where it plants any.
 */
const formsOf = (name: CarriedName): readonly [Form, ...ReadonlyArray<Form>] => {
	const carrier: Carried = carried[name]
	return [
		[`${name} written`, map(carrier.live, (written): FormCase => ({ kind: "written", written }))],
		[
			`${name} null refused`,
			map(element(["null", "undefined"] as const), (absent): FormCase => ({
				kind: "null refused",
				absent
			}))
		],
		...(Arr.isReadonlyArrayNonEmpty(carrier.refusedValues)
			? [
					[
						`${name} value refused`,
						map(element(carrier.refusedValues), (planted): FormCase => ({
							kind: "value refused",
							planted
						}))
					] as const
				]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(carrier.refusedTexts)
			? [
					[
						`${name} text refused`,
						map(element(carrier.refusedTexts), (planted): FormCase => ({
							kind: "text refused",
							planted
						}))
					] as const
				]
			: [])
	]
}

/** The features a carrier can reach: a written value, and each refusal it plants. */
const reachable = (name: CarriedName): ReadonlyArray<FormFeature> =>
	Arr.map(formsOf(name), ([feature]) => feature)

/**
 * A carrier's case: half of them a written value, half a refusal it plants, each kind of refusal it has equally often.
 */
const formCaseGen = (name: CarriedName): Gen<FormCase> => {
	const [[, written], ...refusals] = formsOf(name)
	return weighted([
		[1, written],
		[
			1,
			weighted(
				Arr.map(nonEmpty(refusals, "a carrier's refusals"), ([, refusal]): Weighted<FormCase> => [
					1,
					refusal
				])
			)
		]
	])
}

/** A case of the forms property: a carrier, by name, and one of its cases. */
export const carrierCases: Gen<readonly [CarriedName, FormCase]> = (source) => {
	const name = source.draw(element(carriedNames))
	return [name, source.draw(formCaseGen(name))] as const
}

/** Each form of each carrier, and the space of that carrier's cases of it: what the forms property is aimed with. */
export const formAims: ReadonlyArray<
	readonly [FormFeature, Gen<readonly [CarriedName, FormCase]>]
> = Arr.flatMap(carriedNames, (name) =>
	Arr.map(
		formsOf(name),
		([feature, form]) => [feature, map(form, (sketch) => [name, sketch] as const)] as const
	)
)

/** Every form each carrier reaches. */
export const formFeatures: ReadonlyArray<FormFeature> = Arr.flatMap(carriedNames, reachable)

/** The output grammars the scanners implement, as references. Tests may use RegExp; src may not. */
const integerGrammar = regex("^-?(?:0|[1-9]\\d{0,18})$")
export const spanGrammar = regex("^\\[(-?\\d{1,19}),(-?\\d{1,19})\\)$")
export const int8Text = (t: string): bigint | undefined => {
	if (!integerGrammar.test(t) || t === "-0") {
		return undefined
	}
	const n = BigInt(t)
	return n >= int8Min && n <= int8Max ? n : undefined
}

/** The int8range codec. */
export const r8 = codecOf(codecTypes.range8, kindCodes)
/** An int8range text: any text of its characters, or two int8s in either order. */
export const spanTexts = weighted([
	[1, string(element(Str.split("[](),-0123456789", "")), { min: 0, max: 16 })],
	[
		1,
		map(
			(source) =>
				[source.draw(bigint(int8Min, int8Max)), source.draw(bigint(int8Min, int8Max))] as const,
			([a, b]) => `[${a},${b})`
		)
	]
])

/** The codec of a vector of three dimensions. */
export const vector3 = codecOf(codecTypes.vector3, kindCodes)
/**
 * Components bounded by 2^16 / sqrt(3), subnormals included; a vector whose norm falls below the domain has its
 * first component set to 1.
 */
const bound = Math.fround(2 ** 16 / Math.sqrt(3))

/** Three components bounded by `bound`. */
export const vectorComponents = array(float(-bound, bound), { min: 3, max: 3 })
