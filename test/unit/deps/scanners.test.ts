/**
 * The hand-written scanners that replaced RegExp in the adapter when their packages met the dependency gate (no RegExp
 * construction, .test or .exec under src/): each is held to the regex it replaces over generated texts. Tests may use
 * RegExp; src may not.
 *
 * - Sqlstate.parse (core/sqlstate.ts) reads a text as a SQLSTATE exactly where /^[0-9A-Z]{5}$/ matches it, as the
 *   text itself, and refuses every other text.
 *
 * The oracle is a second implementation, the regex the scanner replaced. The texts are drawn by kind with explicit
 * weights: a code of the regex's own characters, its range edges among them; a code with one character just outside
 * those ranges (the neighbours of 0-9 and A-Z, a lowercase letter, an underscore, a space, a non-ASCII digit, a
 * fullwidth capital); a code a character short or long; and any text. Features: each kind, and a code read.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/scanners-sqlstate-range.patch (the capitals' range ending at Y) turns
 * the property red.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, int, string, unicodeScalar, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { regex } from "arkregex"
import { Effect, Formatter, String as Str } from "effect"
import { Sqlstate } from "#compiler/core/sqlstate.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A SQLSTATE's characters, the ends of both ranges among them. */
const codeCharacter = element(["0", "1", "5", "9", "A", "M", "Y", "Z"])

/** Characters no SQLSTATE holds: each range's neighbours, and the look-alikes a careless scanner admits. */
const outsideCharacter = element(["/", ":", "@", "[", "a", "z", "_", " ", "٠", "Ａ"])

/** How a drawn text was made. */
type Kind =
	| "a code"
	| "a character outside the code's"
	| "a character short"
	| "a character long"
	| "any text"

interface Drawn {
	readonly kind: Kind
	readonly text: string
}

const codeOf = (length: number): Gen<string> => string(codeCharacter, { min: length, max: length })

const textGen: Gen<Drawn> = weighted<Drawn>([
	[3, (s) => ({ kind: "a code", text: s.draw(codeOf(5)) })],
	[
		3,
		(s) => {
			const code = s.draw(codeOf(5))
			const at = s.draw(int(0, 4))
			return {
				kind: "a character outside the code's",
				text: `${Str.slice(0, at)(code)}${s.draw(outsideCharacter)}${Str.slice(at + 1)(code)}`
			}
		}
	],
	[1, (s) => ({ kind: "a character short", text: s.draw(codeOf(4)) })],
	[1, (s) => ({ kind: "a character long", text: s.draw(codeOf(6)) })],
	[1, (s) => ({ kind: "any text", text: s.draw(string(unicodeScalar, { min: 0, max: 7 })) })]
])

type Feature = Kind | "a code read"

describe("scanners that replace a RegExp under src", () => {
	it.effect("Sqlstate.parse reads exactly /^[0-9A-Z]{5}$/, as the text itself", (ctx) =>
		Effect.gen(function* () {
			const reference = regex("^[0-9A-Z]{5}$")
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the RegExp /^[0-9A-Z]{5}$/ it replaced"
						},
						suite: "unit/deps/scanners-sqlstate",
						draw: drawn(textGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a code",
								"a character outside the code's",
								"a character short",
								"a character long",
								"any text",
								"a code read"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ kind, text }, c) =>
						Effect.sync(() => {
							const parsed: string | undefined = Sqlstate.parse(text)
							const matches = reference.test(text)
							assert.equal(parsed, matches ? text : undefined, text)
							c.note(kind)
							if (matches) {
								c.note("a code read")
							}
						})
				)
			)
		})
	)
})
