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
import type { TextsId } from "#compiler/core/text.ts"
import { longestHashedText } from "#test/support/kernel/long-keys.ts"
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

/** A text of up to three units, each one the orders branch on (`spelledUnit`). */
export const spelledText: Gen<string> = string(spelledUnit, { min: 0, max: 3 })

/** A tuple of up to three texts of up to three units: two drawn from so few units often share a prefix. */
export const tuple: Gen<ReadonlyArray<string>> = array(spelledText, {
	min: 0,
	max: 3
})

/** An entry of a set a sort puts in its identities' order: a tuple and its identity (core/text.ts TextsId). */
export interface IdentifiedTuple {
	readonly tuple: ReadonlyArray<string>
	readonly id: TextsId
}

/** An entry's identity, the one reader a sort through columns calls (core/text.ts inIdentityOrder): its calls counted. */
export const identityOfTuple = (entry: IdentifiedTuple): TextsId => entry.id

/** Whether JSON.stringify escapes a code unit: a quote, a backslash or a control. */
export const escaped = (unit: number): boolean => unit === 0x22 || unit === 0x5c || unit < 0x20

export type TupleFeature =
	| "equal tuples"
	| "one tuple the other's prefix"
	| "differing first past the first text"
	| "texts of two lengths where they differ"
	| "an escaped unit where they differ"
	| "a unit past the surrogates against an astral scalar where they differ"

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

/** FNV-1a's 32-bit offset basis and prime, as textsId starts and steps its digest (core/text.ts TextsId). */
const fnvOffset = 0x811c9dc5
const fnvPrime = 0x01000193

/**
 * The FNV-1a state after `units` from `state`, each a code unit, a list's count or a text's length, folded in as
 * textsId folds it: a second spelling of the digest's step, so a search for pieces that meet folds a piece's units
 * alone, never the texts before it.
 */
const folded = (state: number, units: ReadonlyArray<number>): number => {
	let at = state
	for (const unit of units) {
		at = Math.imul(at ^ unit, fnvPrime)
	}
	return at
}

/** A text's code units, as a digest folds them. */
const unitsOf = (text: string): ReadonlyArray<number> =>
	Array.from({ length: text.length }, (_, at) => Option.getOrThrow(Str.charCodeAt(text, at)))

/** The first unit a piece's units are drawn from: past the controls, so every piece is plain text. */
const firstUnit = 0x20

/** Whether a unit stands alone in a well-formed text: no NUL and no surrogate. */
const plainUnit = (unit: number): boolean => unit >= firstUnit && (unit < 0xd800 || unit > 0xdfff)

/**
 * Two pieces of two units each that take FNV-1a from `state` to one state, and that state. A piece [c, d] reaches
 * ((state ^ c)·p ^ d)·p, and p is odd, so two pieces meet exactly where (state ^ c)·p ^ (state ^ c')·p is d ^ d': where
 * the two first units' states share their high 16 bits, that is a unit, and d' is d xor it. A search over first units
 * from U+0020 meets two such states within 2^16 + 1 of them by pigeonhole, about 2^8 by the birthday bound, and a
 * second unit is then read off, the first d whose partner is plain too: a piece is found in a few hundred steps, never
 * the 2^16 lists a search for a whole digest's meeting draws.
 */
const meetingPieces = (state: number): readonly [string, string, number] => {
	const byHigh = new Map<number, number>()
	for (let first = firstUnit; ; first += 1) {
		if (!plainUnit(first)) {
			continue
		}
		const reached = folded(state, [first])
		const met = byHigh.get(reached >>> 16)
		if (met === undefined) {
			byHigh.set(reached >>> 16, first)
			continue
		}
		const apart = (folded(state, [met]) ^ reached) >>> 0
		for (let second = firstUnit; ; second += 1) {
			const partner = second ^ apart
			if (plainUnit(second) && plainUnit(partner)) {
				return [
					String.fromCharCode(met, partner),
					String.fromCharCode(first, second),
					folded(state, [first, second])
				]
			}
		}
	}
}

/**
 * Two lists of `prefix` and a two-unit piece whose digests meet (core/text.ts TextsId digest): the pieces folded from
 * the state the list's count, the prefix and the piece's length reach (`meetingPieces`).
 */
export const collidingLists = (
	prefix: string
): readonly [ReadonlyArray<string>, ReadonlyArray<string>] => {
	const [a, b] = meetingPieces(folded(fnvOffset, [2, prefix.length, ...unitsOf(prefix), 2]))
	return [
		[prefix, a],
		[prefix, b]
	]
}

/**
 * Four distinct texts of one length past V8's longest hashed text (kernel/long-keys.ts longestHashedText), `prefix` and a filler then two pieces of two units, whose
 * lists of one text share a digest (core/text.ts TextsId), so V8 hashes them alike and so does a TextsMap: the second
 * pieces meet from the state the first ones reach (Joux's multicollisions), so either first piece and either second
 * make one digest, the long text before them folded once.
 */
export const collidingFamily = (prefix: string): ReadonlyArray<string> => {
	const head = `${prefix}${Str.repeat(longestHashedText + 1)("a")}`
	const [a0, a1, between] = meetingPieces(folded(fnvOffset, [1, head.length + 4, ...unitsOf(head)]))
	const [b0, b1] = meetingPieces(between)
	return Arr.map([a0 + b0, a0 + b1, a1 + b0, a1 + b1], (pieces) => head + pieces)
}

/**
 * The greatest height of an AVL tree of `k` nodes (core/text.ts BucketNode): the most levels whose fewest nodes, N(h) =
 * N(h − 1) + N(h − 2) + 1 from N(0) = 0 and N(1) = 1, are at most `k`, below 1.4405·log₂(k + 2) (Knuth, TAOCP 3,
 * §6.2.3): 1 at one node, 2 at two and three, 3 at four.
 */
export const avlHeight = (k: number): number => {
	let height = 0
	let fewest = 0
	let next = 1
	while (next <= k) {
		const after = next + fewest + 1
		fewest = next
		next = after
		height += 1
	}
	return height
}
