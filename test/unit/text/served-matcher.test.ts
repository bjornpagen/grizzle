/**
 * A served file carries each pattern's automaton as `grizzle generate` built it (scalar/regex/matcher.ts ServedMatchers),
 * so a load builds its matchers without the parser: the matchers a compiled table hands a served file
 * (ProgramPatterns.served), written as canonical JSON as the served file is (core/canonical.ts writeCanonicalJson) and
 * read back, are exactly the automata buildNfa makes of the patterns' parses, their char sets each held once in the
 * file's table and every one of them stepped on, and the served table (ServedPatterns) judges every drawn text as the
 * compiled table does.
 *
 * - The file's sets are a set: each set an edge of its automata steps on, each once, in any order.
 * - Each served automaton is buildNfa's of the pattern's parse, and the served table judges every text as the compiled
 *   one does.
 *
 * Oracle: the specification, nfa.ts buildNfa over the pattern's parse and the compiled table's own membership.
 *
 * Features: a pattern under u, one under su, a text matched, a text refused.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { regexCheck, RegexKey, type RegexRef } from "#compiler/ir/scalar.ts"
import type { NfaEdge } from "#compiler/scalar/regex/match.ts"
import { matchFlags, type ServedMatchers, ServedPatterns } from "#compiler/scalar/regex/matcher.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { ProgramPatterns } from "#compiler/scalar/regex/patterns.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { type Feature, servedGen, tabled } from "#test/unit/text/served-matcher.fixtures.ts"

/** Served matchers read back from the served form as buildNfa makes them, and judge every text as the compiled table does. */
export const servedMatchersReadBackFromTheServedFormAsBuildNfaMakesThemAndJudgeEveryTextAsTheCompiledTableDoes =
	property.explore(servedGen, {
		needs: {},
		situations: [
			"a pattern under u",
			"a pattern under su",
			"a text matched",
			"a text refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawnCase) =>
			Effect.sync(() => {
				const patterns = Arr.filter(drawnCase.patterns, tabled)
				const compiled = ProgramPatterns.of(patterns)
				const text = succeeded(
					writeCanonicalJson(trusted<Json>(compiled.served())),
					"the matchers' canonical JSON"
				)
				const read = trustedJson<ServedMatchers>(text)
				const served = ServedPatterns.of(read)
				const stepped = Arr.flatMap(read.matchers, (matcher) =>
					Arr.flatMap(served.nfa(matcher.pattern).edges, (out) =>
						Arr.flatMap(out, (e: NfaEdge) => (e.kind === "set" ? [e.set] : []))
					)
				)
				unorderedEqual(
					read.sets,
					Arr.dedupeWith(stepped, (a, b) => Option.isNone(exactValue(a, b))),
					"the file's sets: each set an edge steps on, once"
				)
				for (const pattern of patterns) {
					const label = `/${pattern.source}/${pattern.flags}`
					c.note(pattern.flags === matchFlags ? "a pattern under u" : "a pattern under su")
					const parsed = succeeded(parsePattern(pattern.source, pattern.flags), label)
					assert.deepEqual(served.nfa(pattern), buildNfa(parsed), `${label}: its served automaton`)
					const regex: RegexRef = {
						patterns: [pattern],
						key: RegexKey(label),
						check: regexCheck([label], undefined)
					}
					for (const t of drawnCase.texts) {
						const expected = compiled.member(regex, t)
						c.note(expected ? "a text matched" : "a text refused")
						assert.equal(served.member(regex, t), expected, `${label} on ${Formatter.format(t)}`)
					}
				}
			}),
		oracle: { kind: "specification", name: "nfa.ts buildNfa over the pattern's parse" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/patterns.ts",
				original: "\t\tcandidates.push(at)\n",
				replacement: "",
				why: "The served file's set table writes a set once for each edge that steps on it; the property that the file's sets are a set fails."
			}
		]
	})
