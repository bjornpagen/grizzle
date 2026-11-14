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
 *
 * Plants: text-served-sets-repeated (a set written once for each edge that steps on it).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { type PatternSource, RegexKey, type RegexRef, regexCheck } from "#compiler/ir/scalar.ts"
import type { NfaEdge } from "#compiler/scalar/regex/match.ts"
import { matchFlags, type ServedMatchers, ServedPatterns } from "#compiler/scalar/regex/matcher.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { ProgramPatterns } from "#compiler/scalar/regex/patterns.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { caseHang } from "#test/support/limits.ts"
import { families, flagsGen, patternOver, stringsOver } from "#test/unit/text/generators.ts"

/** Drawn patterns over one family's alphabet, each with its flags, and texts over the alphabet to judge. */
interface Served {
	readonly patterns: ReadonlyArray<PatternSource>
	readonly texts: ReadonlyArray<string>
}

const servedGen: Gen<Served> = (source) => {
	const family = source.draw(element(families))
	const patternGen: Gen<PatternSource> = (s) => ({
		source: s.draw(patternOver(family.alphabet)),
		flags: s.draw(flagsGen)
	})
	return {
		patterns: source.draw(array(patternGen, { min: 1, max: 4 })),
		texts: source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 16 }))
	}
}

/** Whether a pattern is one an admission passes on to a table: it parses, and some text matches it. */
const tabled = (pattern: PatternSource): boolean => {
	const parsed = parsePattern(pattern.source, pattern.flags)
	return parsed.ok && parsed.value.kind !== "never"
}

type Feature = "a pattern under u" | "a pattern under su" | "a text matched" | "a text refused"

describe("served matchers", () => {
	it.effect(
		"read back from the served form as buildNfa makes them, and judge every text as the compiled table does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/served-matcher",
						draw: drawn(servedGen),
						literal: Formatter.format,
						oracle: { kind: "specification", name: "nfa.ts buildNfa over the pattern's parse" },
						coverage: required<Feature>(
							["a pattern under u", "a pattern under su", "a text matched", "a text refused"],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnCase, c) =>
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
								assert.deepEqual(
									served.nfa(pattern),
									buildNfa(parsed),
									`${label}: its served automaton`
								)
								const regex: RegexRef = {
									patterns: [pattern],
									key: RegexKey(label),
									check: regexCheck([label], undefined)
								}
								for (const t of drawnCase.texts) {
									const expected = compiled.member(regex, t)
									c.note(expected ? "a text matched" : "a text refused")
									assert.equal(
										served.member(regex, t),
										expected,
										`${label} on ${Formatter.format(t)}`
									)
								}
							}
						})
				)
			)
	)
})
