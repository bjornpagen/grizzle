import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, pipe, String as Str } from "effect"
import type { CodecFault } from "#compiler/core/errors.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { CarrierHost } from "#compiler/scalar/values/identity.ts"
import { int8Max, int8Min } from "#compiler/scalar/values/integer.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { assert, faulted, nonEmpty, succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import type { StrictFault } from "#test/support/kernel/strict.ts"
import { codecOf, types } from "#test/unit/codec/support.ts"
import { asVector } from "#test/unit/codec/values.ts"

import { regex } from "arkregex"
/**
 * Text-mode scalar codecs: each carrier's written text, admission at the encoder, and the null ban; the strict reading of
 * PostgreSQL's output text (the kernel's, test/support/kernel/strict.ts), and the library's trusting conversion agreeing
 * with it on every text it admits.
 *
 * Each carrier's output form is restated here as an oracle from PostgreSQL's output functions (int2out/int4out/int8out,
 * numeric_out at a typmod's display scale, money::numeric at scale 2, boolout, range_out's half-open form), each text's
 * cell text the canonical text of the value it spells, which the encoder writes, and each refusal
 * the codec vocabulary names for a value it meets (README "Errors and outcomes") is planted per carrier, beside the null ban every
 * encoder holds.
 *
 * A Live value and the text PostgreSQL's output function writes for it.
 */
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

/** A span over drawn endpoints, its end past its start, and its half-open text. */
const writtenSpan4 = (endpoint: Gen<number>): Gen<Written> =>
	map(
		filter(
			(source) => [source.draw(endpoint), source.draw(endpoint)] as const,
			([a, b]) => a !== b,
			100
		),
		([a, b]): Written => {
			const [start, end] = a < b ? [a, b] : [b, a]
			return { value: { start, end }, text: `[${start},${end})` }
		}
	)

const writtenSpan8 = (endpoint: Gen<bigint>): Gen<Written> =>
	map(
		filter(
			(source) => [source.draw(endpoint), source.draw(endpoint)] as const,
			([a, b]) => a !== b,
			100
		),
		([a, b]): Written => {
			const [start, end] = a < b ? [a, b] : [b, a]
			return { value: { start, end }, text: `[${start},${end})` }
		}
	)

/** Text PostgreSQL stores: no NUL and no lone surrogate. */
const storableText = string(
	oneOf([codePoint(0x20, 0x7e), codePoint(0xa0, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]),
	{ min: 0, max: 12 }
)

const intWritten = (min: number, max: number): Gen<Written> =>
	map(int(min, max), (n) => ({ value: n, text: digitsOf(BigInt(n)) }))

/**
 * A carrier's codec under test: its Live values with their texts, the values its encoder refuses with the word for
 * each, and the texts the strict reading refuses with the word for each.
 */
interface Carried {
	readonly type: ScalarType
	readonly live: Gen<Written>
	readonly refusedValues: ReadonlyArray<readonly [unknown, CodecFault]>
	readonly refusedTexts: ReadonlyArray<readonly [string, StrictFault]>
}

const fixed4 = scalarOf(f.span(f.integer, 15n), {})
const fixed8 = scalarOf(f.span(f.bigint, int8Max), {})
const refined = scalarOf(f.regex("^[a-z]+$", "u"), {})
const integerSyntax = ["", "+1", "01", "-0", "1.0", " 1", "1e3", "١"]

const carried = {
	int2: {
		type: types.int2,
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
		type: types.int4,
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
		type: types.int8,
		live: map(bigint(int8Min, int8Max), (n) => ({ value: n, text: digitsOf(n) })),
		refusedValues: [[1, "integerType"]],
		refusedTexts: [
			["9223372036854775808", "integerRange"],
			...Arr.map(integerSyntax, (t) => [t, "integerSyntax"] as const)
		]
	},
	numeric: {
		type: types.numeric,
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
		type: types.numeric72,
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
		type: types.numericNeg,
		live: map(int(-99999, 99999), (n) => {
			const text = digitsOf(BigInt(n) * 100n)
			return { value: Decimal.of(text), text }
		}),
		refusedValues: [],
		refusedTexts: [["12345", "numericShape"]]
	},
	money: {
		type: types.money,
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
		type: types.bool,
		live: map(boolean, (b) => ({ value: b, text: b ? "true" : "false" })),
		refusedValues: [
			[1, "boolType"],
			["true", "boolType"]
		],
		refusedTexts: Arr.map(["T", "yes", "1", "on", ""], (t) => [t, "boolSyntax"] as const)
	},
	text: {
		type: types.text,
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
	enum: {
		type: types.kind,
		live: map(element(["Manual", "Automatic", "Ünïcode"]), (h) => ({ value: h, text: h })),
		refusedValues: [["manual", "enumHandle"]],
		refusedTexts: [["Other", "enumHandle"]]
	},
	int4range: {
		type: types.range4,
		live: writtenSpan4(int(-(2 ** 31), 2 ** 31 - 1)),
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
		type: types.range8,
		live: writtenSpan8(bigint(int8Min, int8Max)),
		refusedValues: [[{ start: 1, end: 2 }, "spanEndpoint"]],
		refusedTexts: []
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
		type: types.embedding,
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
	"enum",
	"int4range",
	"int8range",
	"int4range of width 15",
	"int8range of width int8 max",
	"vector"
]

type FormFeature = `${CarriedName} ${"written" | "value refused" | "text refused" | "null refused"}`

/** The features a carrier can reach: a written value, and each refusal it plants. */
const reachable = (name: CarriedName): Arr.NonEmptyReadonlyArray<FormFeature> => {
	const c: Carried = carried[name]
	return [
		`${name} written`,
		`${name} null refused`,
		...(c.refusedValues.length > 0 ? [`${name} value refused` as const] : []),
		...(c.refusedTexts.length > 0 ? [`${name} text refused` as const] : [])
	]
}

/** The two absences a carrier refuses to encode, by name. */
const absences = { null: null, undefined: undefined } as const

type FormCase =
	| { readonly kind: "written"; readonly written: Written }
	| { readonly kind: "value refused"; readonly planted: readonly [unknown, CodecFault] }
	| { readonly kind: "text refused"; readonly planted: readonly [string, StrictFault] }
	| { readonly kind: "null refused"; readonly absent: keyof typeof absences }

/**
 * A carrier's case: half of them a written value, half a refusal it plants, each kind of refusal it has equally often.
 */
const formCaseGen = (carrier: Carried): Gen<FormCase> => {
	const refusals: Array<Gen<FormCase>> = [
		map(element(["null", "undefined"] as const), (absent): FormCase => ({
			kind: "null refused",
			absent
		}))
	]
	if (Arr.isReadonlyArrayNonEmpty(carrier.refusedValues)) {
		refusals.push(
			map(element(carrier.refusedValues), (planted): FormCase => ({
				kind: "value refused",
				planted
			}))
		)
	}
	if (Arr.isReadonlyArrayNonEmpty(carrier.refusedTexts)) {
		refusals.push(
			map(element(carrier.refusedTexts), (planted): FormCase => ({ kind: "text refused", planted }))
		)
	}
	return oneOf([
		map(carrier.live, (written): FormCase => ({ kind: "written", written })),
		oneOf(nonEmpty(refusals, "a carrier's refusals"))
	])
}

describe("each carrier's codec", () => {
	it.effect(
		"writes PostgreSQL's output form, reads it back, and refuses each planted value and text with its word",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/scalar-forms",
						draw: drawn((source) => {
							const name = source.draw(element(carriedNames))
							return [name, source.draw(formCaseGen(carried[name]))] as const
						}),
						literal: Formatter.format,
						coverage: required<FormFeature>(Arr.flatMap(carriedNames, reachable), {
							cases: 1500,
							sense: notesOnly
						}),
						kept: [],
						/** The rotating stream's sample of sixteen carriers, each half written and half refused. */
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([name, sketch], c) =>
						Effect.sync(() => {
							const carrier: Carried = carried[name]
							const codec = codecOf(carrier.type)
							switch (sketch.kind) {
								case "written": {
									c.note(`${name} written`)
									const { value, text } = sketch.written
									assert.equal(succeeded(codec.encode(value)), codec.cellText(text), name)
									assert.equal(codec.cellText(text), codec.text(codec.convert(text)), name)
									assert.deepEqual(succeeded(codec.read(text)), value, name)
									assert.deepEqual(codec.convert(text), value, name)
									return
								}
								case "null refused":
									c.note(`${name} null refused`)
									faulted(codec.encode(absences[sketch.absent]), "nullValue", name)
									return
								case "value refused": {
									c.note(`${name} value refused`)
									const [value, word] = sketch.planted
									faulted(codec.encode(value), word, name)
									return
								}
								case "text refused": {
									c.note(`${name} text refused`)
									const [text, word] = sketch.planted
									faulted(codec.read(text), word, `${name}: ${text}`)
									return
								}
							}
						})
				)
			)
	)
})

describe("integer and span text, scanned without RegExp", () => {
	/** The output grammars the scanners implement, as references. Tests may use RegExp; src may not. */
	const integerGrammar = regex("^-?(?:0|[1-9]\\d{0,18})$")
	const spanGrammar = regex("^\\[(-?\\d{1,19}),(-?\\d{1,19})\\)$")
	const int8Text = (t: string): bigint | undefined => {
		if (!integerGrammar.test(t) || t === "-0") {
			return undefined
		}
		const n = BigInt(t)
		return n >= int8Min && n <= int8Max ? n : undefined
	}

	it.effect("reads int8 text exactly where the integer output grammar admits it", (ctx) =>
		Effect.gen(function* () {
			const int8 = codecOf(types.int8)
			const texts = oneOf([
				string(element(Str.split("0123456789-+. ", "")), { min: 0, max: 22 }),
				map(bigint(int8Min * 2n, int8Max * 2n), String)
			])
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/codec/scalar-6909556",
						draw: drawn(texts),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 20000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							const result = int8.read(text)
							const syntax = integerGrammar.test(text) && text !== "-0"
							if (!syntax) {
								faulted(result, "integerSyntax")
							} else {
								const n = int8Text(text)
								if (n === undefined) {
									faulted(result, "integerRange")
								} else {
									assert.equal(succeeded(result), n)
									assert.equal(int8.convert(text), n)
								}
							}
						})
				)
			)
		})
	)

	it.effect("reads int8range text exactly where the span output grammar admits it", (ctx) =>
		Effect.gen(function* () {
			const r8 = codecOf(types.range8)
			const texts = oneOf([
				string(element(Str.split("[](),-0123456789", "")), { min: 0, max: 16 }),
				map(
					(source) =>
						[source.draw(bigint(int8Min, int8Max)), source.draw(bigint(int8Min, int8Max))] as const,
					([a, b]) => `[${a},${b})`
				)
			])
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/codec/scalar-7565409",
						draw: drawn(texts),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 20000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							const match = spanGrammar.exec(text)
							const start = match === null ? undefined : int8Text(match[1])
							const end = match === null ? undefined : int8Text(match[2])
							const result = r8.read(text)
							if (start === undefined || end === undefined || start >= end) {
								faulted(result, "spanSyntax")
							} else {
								assert.deepEqual(succeeded(result), { start, end })
								assert.deepEqual(r8.convert(text), { start, end })
							}
						})
				)
			)
		})
	)
})

describe("vectors", () => {
	it.effect("round-trips random float32 vectors of the cosine domain", (ctx) =>
		Effect.gen(function* () {
			const vector3 = codecOf(types.vector3)
			/**
			 * Components bounded by 2^16 / sqrt(3), subnormals included; a vector whose norm falls below the domain has its
			 * first component set to 1.
			 */
			const bound = Math.fround(2 ** 16 / Math.sqrt(3))
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/codec/scalar-3",
						draw: drawn(array(float(-bound, bound), { min: 3, max: 3 })),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(xs) =>
						Effect.sync(() => {
							const made = Vector.make(Float32Array.from(xs), 3)
							const v = Vector.inCosineDomain(made)
								? made
								: Vector.make(Float32Array.from([1, ...xs.slice(1)]), 3)
							const text = succeeded(vector3.encode(v))
							assert.equal(Vector.equals(vector3.read(text).pipe(succeeded, asVector), v), true)
							assert.equal(Vector.equals(asVector(vector3.convert(text)), v), true)
						})
				)
			)
		})
	)
})
