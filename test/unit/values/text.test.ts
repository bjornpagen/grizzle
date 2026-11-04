import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
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
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import { compareCodePoints, isValidText, validateText } from "#compiler/core/text.ts"
import { assert, faulted, succeeded } from "#test/support/assert.ts"
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

/** The code point of a one-scalar string. */
const codePoint = (ch: string): number =>
	Option.getOrThrowWith(
		Str.codePointAt(ch, 0),
		() => new RangeError("an empty string has no code point")
	)

/** An order: -1, 0 or 1. */
type Order = -1 | 0 | 1
const signOf = (n: number): Order => (n < 0 ? -1 : n > 0 ? 1 : 0)

/** The reference: compare the decoded code point sequences. */
const referenceCompare = (a: string, b: string): Order => {
	const x = Array.from(a, codePoint)
	const y = Array.from(b, codePoint)
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		if (x[i] !== y[i]) {
			return at(x, i) < at(y, i) ? -1 : 1
		}
	}
	return signOf(x.length - y.length)
}

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
							caseHang: Duration.minutes(2)
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

describe("code point order", () => {
	it.effect("matches the decoded code point sequence order", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/text-1",
					draw: drawn((source) => [source.draw(text), source.draw(text)] as const),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 10000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				([a, b]) =>
					Effect.sync(() => {
						assert.equal(compareCodePoints(a, b), referenceCompare(a, b))
					})
			)
		)
	)

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
						suite: "unit/values/text-2",
						draw: drawn((source) => [source.draw(text), source.draw(text)] as const),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 5000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([a, b]) =>
						Effect.sync(() => {
							assert.equal(compareCodePoints(a, b), bytes(a, b))
						})
				)
			})
		)
	)
})
