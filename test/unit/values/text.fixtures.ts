/** What the properties of text.test.ts read: its spaces, models and helpers. */

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
} from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { upTo } from "#test/support/up-to.ts"

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

export const signOf = (n: number): Order => (n < 0 ? -1 : n > 0 ? 1 : 0)

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

export const text: Gen<string> = string(scalar, { min: 0, max: 6 })

export type CodePointFeature =
	| "a unit past the surrogates against an astral scalar"
	| "one text the other's prefix"
	| "equal texts"

/** Whether a code unit is a surrogate, half of an astral scalar. */
const isSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdfff

/** The situation two texts are in where they first differ. */
export const codePointFeatures = (a: string, b: string): ReadonlyArray<CodePointFeature> => {
	const differs = Arr.findFirst(
		upTo(Math.min(a.length, b.length), (i) => i),
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
export const tuple: Gen<ReadonlyArray<string>> = array(string(spelledUnit, { min: 0, max: 3 }), {
	min: 0,
	max: 3
})

/** Each text after its length and a colon: the spelling compareTextTuples orders by without spelling it. */
export const lengthSpelled = (texts: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(texts, (t) => `${t.length}:${t}`),
		""
	)

/** Whether JSON.stringify escapes a code unit: a quote, a backslash or a control. */
export const escaped = (unit: number): boolean => unit === 0x22 || unit === 0x5c || unit < 0x20

export type TupleFeature =
	| "equal tuples"
	| "one tuple the other's prefix"
	| "differing first past the first text"
	| "texts of two lengths where they differ"
	| "an escaped unit where they differ"

export const kinds = ["nul", "lone high", "lone low", "reversed pair"] as const

export const positions = ["first", "middle", "last"] as const

/** What the search built once before its cases (bytes), now once per worker: every case on it reads them. */
export const bytesNeed = {
	key: "test/unit/values/text.fixtures.ts bytesNeed",
	open: Effect.sync(() => {
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
		return Effect.succeed(bytes)
	})
} as const satisfies Need<unknown>
