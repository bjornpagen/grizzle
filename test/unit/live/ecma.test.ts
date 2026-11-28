/**
 * A refined text's patterns reach its JSON Schema as ECMA-262 patterns printed from their IR (scalar/regex/print.ts toEcma
 * toEcma), and a schema's `pattern` is read under the `u` flag, unanchored, as JSON Schema 2020-12 reads one: every
 * pattern grizzle admits prints as a pattern ECMA-262 compiles, by construction, and the printed pattern holds of
 * exactly the texts the pattern's own automaton accepts.
 *
 * - One language: over drawn texts of the pattern's alphabet, and texts its automaton accepts (walked), a string schema
 *   of the printed pattern, judged by the validator the CLI generator pins (test/support/openapi/validator.ts), admits
 *   exactly the texts the automaton accepts; a printed pattern no ECMA-262 engine compiles fails the judgement. Oracle:
 *   nfa.ts buildNfa over the pattern's parse and match.ts Matcher, the language grizzle's own matchers judge every value
 *   by.
 *
 * Features: a pattern under u, a pattern under su, a text matched, a text refused, a pattern of an astral code point,
 * an end anchor beside a line feed (which `$` under `u` never matches before), and an end anchor matched after an
 * astral code point: the live test phase's counterexample at 729f76a6, `/.$/su` and the text U+10FFFF, which V8's
 * search judged unmatched while the pattern was printed unanchored at its start (scalar/regex/print.ts toEcma).
 */
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { toEcma } from "@bjornpagen/grizzle-text/regex/print"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { schemaAdmits } from "#test/support/openapi/validator.ts"
import { walkGen } from "#test/support/unit/text/generators.ts"
import { bmpLast, endsAstral, type Feature, patternSpace } from "#test/unit/live/ecma.fixtures.ts"

/**
 * A refined text's ECMA-262 pattern compiles under u and holds of exactly the texts the pattern's automaton accepts.
 *
 * Budget: its suite's count before the conversion (unit/live/ecma: 800 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aRefinedTextsECMA262PatternCompilesUnderUAndHoldsOfExactlyTheTextsThePatternsAutomatonAccepts =
	property.explore(patternSpace, {
		needs: {},
		situations: [
			"a pattern under u",
			"a pattern under su",
			"a text matched",
			"a text refused",
			"a pattern of an astral code point",
			"an end anchor beside a line feed",
			"an end anchor matched after an astral code point"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: Case<Feature>) => (c) =>
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
				const matcher = Matcher.of(nfa)
				for (const text of [...c.texts, ...Arr.filter(walked, (w) => w !== undefined)]) {
					const accepted = matcher.matches(text)
					notes.note(accepted ? "a text matched" : "a text refused")
					if (Str.includes("$")(c.source) && Str.includes("\n")(text)) {
						notes.note("an end anchor beside a line feed")
					}
					if (accepted && Str.includes("$")(c.source) && endsAstral(text)) {
						notes.note("an end anchor matched after an astral code point")
					}
					const admitted = yield* schemaAdmits(schema, text, 0)
					assert.equal(
						admitted,
						accepted,
						`${label} printed ${schema.pattern}: ${Formatter.format(text)}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "nfa.ts buildNfa over the pattern's parse, judged by match.ts Matcher"
		},
		budget: { runs: 800, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/print.ts",
				original: '\tanchors: { start: "^", end: "$" }',
				replacement: '\tanchors: { start: "^", end: "(?=\\\\n|$)" }',
				why: "`$` is printed as `(?=\\n|$)`."
			},
			{
				file: "packages/text/src/regex/print.ts",
				original: `\treturn startsAtStart(node) ? body : \`^[^]*?(?:\${body})\``,
				replacement: "\treturn body",
				why: "A pattern whose matches may start anywhere is printed with no start anchor."
			}
		]
	})
