/**
 * Text at the host boundary and its orders (core/text.ts).
 *
 * - Validation: validateText admits exactly the well-formed, NUL-free strings, and refuses a planted NUL, a lone
 *   surrogate of either half or a reversed pair at any position, and every non-string, by its fault. Oracle: the
 *   boundary's specification, each plant's fault named by the plant.
 * - Code point order: compareCodePoints orders as the UTF-8 bytes of the texts do, PostgreSQL's C collation. Oracle: a
 *   second implementation, TextEncoder's bytes compared one by one.
 * - Tuple orders: a tuple of texts orders as its texts' spellings do, each after its length and a colon, and as a JSON
 *   array by code unit and by code point. Oracle: a second implementation, the tuples spelled and compared.
 *
 * Features: live text, a non-string and each plant at each position; equal tuples, a prefix, a difference past the
 * first text, of two lengths, and at an escaped unit.
 *
 * Plants: values-text-surrogate (a lone surrogate admitted), values-codepoint-units (texts ordered by code unit),
 * values-tuple-prefix-first (a tuple ordered before its own prefix).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { compareStrings } from "#compiler/core/order.ts"
import {
	compareCodePoints,
	compareQuotedTuples,
	compareTextTuples,
	isValidText,
	validateText
} from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert, faulted, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type PlantedFeature,
	plantedFault,
	plantedFeature,
	plantedTextGen,
	plantedValue
} from "#test/unit/values/support.ts"

/** The element at an index the test knows is in range, failing the test where it is not. */
const at = <A>(values: ArrayLike<A>, index: number): A => {
	const value = values[index]
	if (value === undefined) {
		throw new RangeError(`no element at ${index}`)
	}
	return value
}

/** An order: -1, 0 or 1. */
type Order = -1 | 0 | 1
const signOf = (n: number): Order => (n < 0 ? -1 : n > 0 ? 1 : 0)

/**
 * At most one grapheme: none, one scalar of the Basic Multilingual Plane below the surrogates, or a cluster of
 * several scalars (a combining mark, a skin tone, a flag).
 */
const grapheme: Gen<string> = weighted([
	[1, constant("")],
	[4, map(int(0x20, 0xd7ff), (cp) => String.fromCodePoint(cp))],
	[1, element(["e\u0301", "\u{1f44d}\u{1f3fd}", "\u{1f1eb}\u{1f1f7}"])]
])

/** Strings that exercise the disagreement: BMP scalars at and above U+E000, supplementary scalars, and ASCII. */
const scalar: Gen<string> = oneOf([
	element(["a", "z", "é", "퟿", "", "￿", "�", "\u{10000}", "\u{10ffff}", "\u{1f600}"]),
	grapheme,
	map(int(0xe000, 0xffff), (cp) => String.fromCodePoint(cp)),
	map(int(0x10000, 0x10ffff), (cp) => String.fromCodePoint(cp))
])
const text: Gen<string> = string(scalar, { min: 0, max: 6 })

describe("text validation", () => {
	it.effect(
		"admits exactly the well-formed NUL-free strings and refuses every planted NUL, lone surrogate and non-string by its fault",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const kinds = ["nul", "lone high", "lone low", "reversed pair"] as const
					const positions = ["first", "middle", "last"] as const
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "the boundary's rule: well-formed NUL-free strings, each plant refused by its fault"
							},
							suite: "unit/values/text-validation",
							draw: drawn(plantedTextGen),
							literal: Formatter.format,
							coverage: required<PlantedFeature>(
								[
									"live",
									"not a string",
									...Arr.flatMap(kinds, (kind) =>
										Arr.map(positions, (position): PlantedFeature => `${kind} ${position}`)
									)
								],
								{ cases: 1000, sense: notesOnly }
							),
							kept: [],
							runs: 1000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(planted, c) =>
							Effect.sync(() => {
								c.note(plantedFeature(planted))
								const fault = plantedFault(planted)
								const value = plantedValue(planted)
								const result = validateText(value)
								if (fault !== undefined) {
									faulted(result, fault)
								} else if (typeof value === "string") {
									assert.equal(succeeded(result), value)
								} else {
									assert.fail("a live planted text is a string")
								}
								assert.equal(isValidText(value), fault === undefined)
							})
					)
				})
			)
	)
})

type CodePointFeature =
	| "a unit past the surrogates against an astral scalar"
	| "one text the other's prefix"
	| "equal texts"

/** Whether a code unit is a surrogate, half of an astral scalar. */
const isSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdfff

/** The situation two texts are in where they first differ. */
const codePointFeatures = (a: string, b: string): ReadonlyArray<CodePointFeature> => {
	const differs = Arr.findFirst(
		Arr.range(0, Math.min(a.length, b.length) - 1),
		(i) => a[i] !== b[i]
	)
	if (Option.isNone(differs) || Math.min(a.length, b.length) === 0) {
		return [a.length === b.length ? "equal texts" : "one text the other's prefix"]
	}
	const x = Option.getOrElse(Str.charCodeAt(a, differs.value), () => 0)
	const y = Option.getOrElse(Str.charCodeAt(b, differs.value), () => 0)
	return (x >= 0xe000 && isSurrogate(y)) || (y >= 0xe000 && isSurrogate(x))
		? ["a unit past the surrogates against an astral scalar"]
		: []
}

describe("code point order", () => {
	it.effect("matches UTF-8 byte order", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const encoder = new TextEncoder()
				const bytes = (a: string, b: string): Order => {
					const x = encoder.encode(a)
					const y = encoder.encode(b)
					for (let i = 0; i < Math.min(x.length, y.length); i++) {
						if (x[i] !== y[i]) {
							return at(x, i) < at(y, i) ? -1 : 1
						}
					}
					return signOf(x.length - y.length)
				}
				return yield* explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "TextEncoder's UTF-8 bytes compared one by one"
						},
						suite: "unit/values/text-2",
						draw: drawn((source) => [source.draw(text), source.draw(text)] as const),
						literal: Formatter.format,
						coverage: required<CodePointFeature>(
							[
								"a unit past the surrogates against an astral scalar",
								"one text the other's prefix",
								"equal texts"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 5000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([a, b], c) =>
						Effect.sync(() => {
							c.noteAll(codePointFeatures(a, b))
							assert.equal(compareCodePoints(a, b), bytes(a, b))
						})
				)
			})
		)
	)
})

/**
 * Units that tell the tuple orders' spellings apart: those JSON escapes (a quote, a backslash, controls), the units on
 * either side of the quote, digits and the colon a length is spelled with, and scalars above the surrogates.
 */
const spelledUnit: Gen<string> = element([
	"a",
	"b",
	'"',
	"\\",
	"\n",
	"\t",
	"\u0001",
	"\u001f",
	" ",
	"!",
	"#",
	"1",
	"10",
	":",
	"\u{e000}",
	"\u{ffff}",
	"\u{1f600}"
])

/** A tuple of up to three texts of up to three units: two drawn from so few units often share a prefix. */
const tuple: Gen<ReadonlyArray<string>> = array(string(spelledUnit, { min: 0, max: 3 }), {
	min: 0,
	max: 3
})

/** Each text after its length and a colon: the spelling compareTextTuples orders by without spelling it. */
const lengthSpelled = (texts: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(texts, (t) => `${t.length}:${t}`),
		""
	)

/** Whether JSON.stringify escapes a code unit: a quote, a backslash or a control. */
const escaped = (unit: number): boolean => unit === 0x22 || unit === 0x5c || unit < 0x20

type TupleFeature =
	| "equal tuples"
	| "one tuple the other's prefix"
	| "differing first past the first text"
	| "texts of two lengths where they differ"
	| "an escaped unit where they differ"

describe("text tuple orders", () => {
	it.effect(
		"order as their texts' spellings do, each text after its length, and as JSON arrays by code unit and by code point",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the tuples spelled, each text after its length and a colon, and by JSON.stringify, then compared"
						},
						suite: "unit/values/text-tuples",
						draw: drawn((source) => [source.draw(tuple), source.draw(tuple)] as const),
						literal: Formatter.format,
						coverage: required<TupleFeature>(
							[
								"equal tuples",
								"one tuple the other's prefix",
								"differing first past the first text",
								"texts of two lengths where they differ",
								"an escaped unit where they differ"
							],
							{ cases: 2000, sense: notesOnly }
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
							const differs = Arr.findFirstIndex(a, (x, i) => x !== b[i])
							const at = differs._tag === "Some" ? differs.value : a.length
							const x = a[at]
							const y = b[at]
							if (x === undefined || y === undefined) {
								c.note(a.length === b.length ? "equal tuples" : "one tuple the other's prefix")
							} else {
								if (at > 0) {
									c.note("differing first past the first text")
								}
								if (x.length !== y.length) {
									c.note("texts of two lengths where they differ")
								}
								let unit = 0
								while (unit < x.length && unit < y.length && x[unit] === y[unit]) {
									unit += 1
								}
								if (
									Option.exists(Str.charCodeAt(x, unit), escaped) ||
									Option.exists(Str.charCodeAt(y, unit), escaped)
								) {
									c.note("an escaped unit where they differ")
								}
							}
							assert.equal(
								signOf(compareTextTuples(a, b)),
								compareCodePoints(lengthSpelled(a), lengthSpelled(b)),
								"length-first order is the spelling's"
							)
							assert.equal(
								signOf(compareQuotedTuples(compareStrings)(a, b)),
								signOf(compareStrings(jsonText(a), jsonText(b))),
								"code unit order is the JSON array's"
							)
							assert.equal(
								signOf(compareQuotedTuples(compareCodePoints)(a, b)),
								compareCodePoints(jsonText(a), jsonText(b)),
								"code point order is the JSON array's"
							)
						})
				)
			)
	)
})
