/**
 * A refined text's patterns reach its JSON Schema as ECMA-262 patterns printed from their IR (scalar/regex/ecma.ts
 * toEcma), and a schema's `pattern` is read under the `u` flag, unanchored, as JSON Schema 2020-12 reads one: every
 * pattern grizzle admits prints as a pattern ECMA-262 compiles, by construction, and the printed pattern holds of
 * exactly the texts the pattern's own automaton accepts.
 *
 * - One language: over drawn texts of the pattern's alphabet, and texts its automaton accepts (walked), a string schema
 *   of the printed pattern, judged by the validator the CLI generator pins (test/support/openapi/validator.ts), admits
 *   exactly the texts the automaton accepts; a printed pattern no ECMA-262 engine compiles fails the judgement. Oracle:
 *   nfa.ts buildNfa over the pattern's parse and match.ts matches, the language grizzle's own matchers judge every value
 *   by.
 *
 * Features: a pattern under u, a pattern under su, a text matched, a text refused, a pattern of an astral code point.
 *
 * Plants (~/.cache/grizzle-release/LIVE-OPENAPI/plants): ecma-anchor-multiline (`$` printed as `(?=\n|$)`).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { toEcma } from "#compiler/scalar/regex/ecma.ts"
import { matches } from "#compiler/scalar/regex/match.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { schemaAdmits } from "#test/support/openapi/validator.ts"
import {
	families,
	type Flags,
	flagsGen,
	patternOver,
	stringsOver,
	walkGen
} from "#test/unit/text/generators.ts"

type Feature =
	| "a pattern under u"
	| "a pattern under su"
	| "a text matched"
	| "a text refused"
	| "a pattern of an astral code point"

/** A drawn pattern of one family's alphabet, its flags, and texts over the alphabet. */
interface Case {
	readonly source: string
	readonly flags: Flags
	readonly alphabet: Arr.NonEmptyReadonlyArray<number>
	readonly texts: ReadonlyArray<string>
}

const caseGen: Gen<Case> = (source) => {
	const family = source.draw(element(families))
	return {
		source: source.draw(patternOver(family.alphabet)),
		flags: source.draw(flagsGen),
		alphabet: family.alphabet,
		texts: source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 12 }))
	}
}

/** The greatest code point the Basic Multilingual Plane holds. */
const bmpLast = 0xffff

describe("a refined text's ECMA-262 pattern", () => {
	it.effect(
		"compiles under u and holds of exactly the texts the pattern's automaton accepts",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/live/ecma",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "nfa.ts buildNfa over the pattern's parse, judged by match.ts matches"
						},
						coverage: required<Feature>(
							[
								"a pattern under u",
								"a pattern under su",
								"a text matched",
								"a text refused",
								"a pattern of an astral code point"
							],
							{ cases: 800, sense: notesOnly }
						),
						kept: [],
						runs: 800,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							const parsed = parsePattern(c.source, c.flags)
							if (!parsed.ok || parsed.value.kind === "never") {
								return
							}
							notes.note(c.flags === "u" ? "a pattern under u" : "a pattern under su")
							if (Arr.some(c.alphabet, (cp) => cp > bmpLast)) {
								notes.note("a pattern of an astral code point")
							}
							const label = `/${c.source}/${c.flags}`
							const schema = { type: "string", pattern: toEcma(parsed.value) }
							const nfa = buildNfa(parsed.value)
							const walked = notes.draw(array(walkGen(nfa), { min: 0, max: 4 }))
							for (const text of [...c.texts, ...Arr.filter(walked, (w) => w !== undefined)]) {
								const accepted = matches(nfa, text)
								notes.note(accepted ? "a text matched" : "a text refused")
								const admitted = yield* schemaAdmits(schema, text, 0)
								assert.equal(
									admitted,
									accepted,
									`${label} printed ${schema.pattern}: ${Formatter.format(text)}`
								)
							}
						})
				)
			)
	)
})
