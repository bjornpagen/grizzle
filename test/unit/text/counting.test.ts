/**
 * A counted repetition costs the host's automaton no state for its counts (packages/text/src/regex/nfa.ts): a
 * repetition is one copy of its body and a counter, so the automaton of an XML Schema pattern holds at most a state for
 * each code point of the pattern and two more, whatever its counts, and a matcher's work over a text is at most its
 * initial subset's and two subsets' for each code point, each at most the automaton's states, where every counter is
 * fixed by the text read, as an anchored pattern of one way through makes it.
 *
 * Over the patterns edullm's CULL lane measured (Appendix F's own, counts nested and past 255), each read with texts of
 * runs of its code point at its counts' edges and past them: `a{256}`, `[0-9]{0,300}`, `(a{255}){255}`,
 * `((a{50}){50}){50}`, `((a{255}){255}){20}` and `((a{255}){255}){255}`, the last 21 code points, whose chain of copies
 * held 16,581,375 states and 4.47 GB. Membership is a run's length among the counts' products.
 *
 * Oracle: the specification, the automaton's size and the subset construction's charge against the pattern's length,
 * and membership as the counts multiply.
 */

import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import { codePoints } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { succeeded } from "#test/support/assert.ts"

type CountingFeature = "a text the pattern holds" | "a text it does not hold" | "a count past 255"

/** A measured pattern, the code point its runs repeat, and the run lengths it holds: from `least` to `most`. */
interface Counted {
	readonly xsd: string
	readonly letter: string
	readonly least: number
	readonly most: number
}

/** The six patterns, in the order their copies grow. */
const counted: Arr.NonEmptyReadonlyArray<Counted> = [
	{ xsd: "a{256}", letter: "a", least: 256, most: 256 },
	{ xsd: "[0-9]{0,300}", letter: "7", least: 0, most: 300 },
	{ xsd: "(a{255}){255}", letter: "a", least: 65_025, most: 65_025 },
	{ xsd: "((a{50}){50}){50}", letter: "a", least: 125_000, most: 125_000 },
	{ xsd: "((a{255}){255}){20}", letter: "a", least: 1_300_500, most: 1_300_500 },
	{ xsd: "((a{255}){255}){255}", letter: "a", least: 16_581_375, most: 16_581_375 }
]

/**
 * The run lengths a pattern is read with: the empty run, one code point, and its least count and one either side and
 * its most and one past it, each within 125,001 code points, so the two patterns of over a million read runs of
 * 125,000, short of their counts.
 */
const runsOf = (c: Counted): Arr.NonEmptyReadonlyArray<number> => [
	0,
	...Arr.dedupe(
		Arr.filter(
			[1, Math.min(c.least - 1, 125_000), c.least, c.least + 1, c.most, c.most + 1],
			(n) => n > 0 && n <= 125_001
		)
	)
]

/** A counted repetition costs the automaton no state for its counts and a matcher no more than its states for each code point, over the six measured patterns. */
export const aCountedRepetitionCostsTheAutomatonNoStateForItsCountsAndAMatcherNoMoreThanItsStatesForEachCodePointOverTheSixMeasuredPatterns =
	property.exhaust(
		finite((source) => {
			const c = source.draw(element(counted))
			return { c, run: source.draw(element(runsOf(c))) }
		}),
		{
			needs: {},
			situations: [
				"a text the pattern holds",
				"a text it does not hold",
				"a count past 255"
			] satisfies ReadonlyArray<Reached<CountingFeature>>,
			check:
				(_, k: Case<CountingFeature>) =>
				({ c, run }) =>
					Effect.sync(() => {
						const label = `${c.xsd} over a run of ${run}`
						if (c.most > 255) {
							k.note("a count past 255")
						}
						const nfa = buildNfa(succeeded(xsdPattern(c.xsd), c.xsd))
						const states = nfa.edges.length
						assert.ok(
							states <= codePoints(c.xsd).length + 2,
							`${label}: ${states} states, past the pattern's ${codePoints(c.xsd).length} code points and two`
						)
						const matcher = Matcher.of(nfa)
						const held = run >= c.least && run <= c.most
						assert.equal(matcher.matches(Str.repeat(run)(c.letter)), held, label)
						k.note(held ? "a text the pattern holds" : "a text it does not hold")
						assert.ok(
							matcher.spent <= (2 * run + 1) * states,
							`${label}: charged ${matcher.spent}, past ${2 * run + 1} subsets of at most ${states} states`
						)
					}),
			oracle: {
				kind: "specification",
				name: "a state for each of the pattern's code points and two, two subsets of at most the states for each code point, and membership as the counts multiply"
			},
			box: "the six measured patterns, each over runs at its counts' edges within 125,001 code points",
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/nfa.ts",
					original: "\t\t\t\tconst consuming = this.#ir.matchesEmpty(node.body)\n",
					replacement:
						'\t\t\t\tif (node.max !== "unbounded" && node.body.kind === "set") {\n\t\t\t\t\tlet at = from\n\t\t\t\t\tfor (let copy = 0; copy < node.max; copy++) {\n\t\t\t\t\t\tif (copy >= node.min) {\n\t\t\t\t\t\t\tthis.edge(at, to, noCounts, (t, counts) => ({ kind: "eps", to: t, counts }))\n\t\t\t\t\t\t}\n\t\t\t\t\t\tconst next = copy === node.max - 1 ? to : inner(this.fresh())\n\t\t\t\t\t\ttasks.push({ kind: "build", node: node.body, from: at, to: next, scope })\n\t\t\t\t\t\tat = next\n\t\t\t\t\t}\n\t\t\t\t\treturn\n\t\t\t\t}\n\t\t\t\tconst consuming = this.#ir.matchesEmpty(node.body)\n',
					why: "The copying construction, a copy of the repeated class for each count, as buildNfa wrote every repetition: `a{256}` holds 257 states, past its 6 code points and two."
				}
			]
		}
	)
