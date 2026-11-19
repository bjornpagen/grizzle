/**
 * A repetition whose counts pass 255, as a builder makes one (a facet's lengths, regex/words.ts), printed in grizzle's
 * grammar and as an ARE (packages/text/src/regex/print.ts quantified): each prints as pieces whose every count is at
 * most 255, which grizzle's parser reads back (parse.ts regexMaxRepeat, PostgreSQL's RE_DUP_MAX), and the parse holds
 * exactly the texts of the repetition's counts.
 *
 * Oracle: grizzle's parse of the printed source, membership by match.ts Matcher, against the counts restated over the
 * text's length.
 *
 * Features: a least count past 255, a greatest past it, an unbounded greatest, and counts within it.
 */

import { charSet } from "@bjornpagen/grizzle-text/regex/charset"
import { end, RegexBuilder, seq, set, start } from "@bjornpagen/grizzle-text/regex/ir"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern, regexMaxRepeat } from "@bjornpagen/grizzle-text/regex/parse"
import { printSource, toAre } from "@bjornpagen/grizzle-text/regex/print"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"

type CountsFeature =
	| "a least count past 255"
	| "a greatest count past 255"
	| "an unbounded greatest"
	| "counts within 255"

interface CountsCase {
	readonly min: number
	readonly max: number | "unbounded"
}

const countsCaseGen: Gen<CountsCase> = (source) => {
	const min = source.draw(int(0, 700))
	return {
		min,
		max: source.draw(boolean) ? "unbounded" : min + source.draw(int(0, 700))
	}
}

/** Every count a braced quantifier of a text states. */
const countsOf = (text: string): ReadonlyArray<number> =>
	Arr.flatMap(Str.split(text, "{"), (part, at) =>
		at === 0
			? []
			: Arr.map(Str.split(Str.split(part, "}")[0] ?? "", ","), (n) => (n === "" ? 0 : Number(n)))
	)

/** A repetition past 255 prints as pieces of counts each at most 255, which grizzle's parser reads as its counts. */
export const aRepetitionPast255PrintsAsPiecesEachOfCountsAtMost255WhichReadBackAsItsCounts =
	property.explore(countsCaseGen, {
		needs: {},
		situations: [
			"a least count past 255",
			"a greatest count past 255",
			"an unbounded greatest",
			"counts within 255"
		] satisfies ReadonlyArray<Reached<CountsFeature>>,
		check: (_, c: Case<CountsFeature>) => (k) =>
			Effect.sync(() => {
				c.note(k.min > regexMaxRepeat ? "a least count past 255" : "counts within 255")
				c.note(
					k.max === "unbounded"
						? "an unbounded greatest"
						: k.max > regexMaxRepeat
							? "a greatest count past 255"
							: "counts within 255"
				)
				const node = seq([
					start,
					new RegexBuilder().repeat(set(charSet([[0x61, 0x61]])), k.min, k.max),
					end
				])
				assert.ok(node.kind !== "never", "a repetition of a code point holds a text")
				const source = printSource(node, (s) => s)
				for (const text of [source, toAre(node)]) {
					for (const count of countsOf(text)) {
						assert.ok(count <= regexMaxRepeat, `${text}: a count of at most ${regexMaxRepeat}`)
					}
				}
				const parsed = parsePattern(source, "u")
				assert.ok(parsed.ok, `${source} parses`)
				if (!parsed.ok) {
					return
				}
				const matcher = Matcher.of(buildNfa(parsed.value))
				const top = (k.max === "unbounded" ? k.min : k.max) + 2
				for (const length of [0, k.min - 1, k.min, k.min + 1, top - 2, top - 1, top]) {
					if (length >= 0) {
						const held = length >= k.min && (k.max === "unbounded" || length <= k.max)
						assert.equal(
							matcher.matches(Str.repeat(length)("a")),
							held,
							`${source}: a text of ${length} code points`
						)
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "grizzle's parse of the printed source matched over texts of the counts' lengths, against the counts"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/print.ts",
				original: "\tintervals: setOf,\n\tmostCount: regexMaxRepeat",
				replacement: '\tintervals: setOf,\n\tmostCount: "unbounded"',
				why: "grizzle's grammar prints a count past 255 in braces, which its parser refuses."
			},
			{
				file: "packages/text/src/regex/print.ts",
				original: "\t\tleast -= most\n",
				replacement: "\t\tleast -= most + 1\n",
				why: "A least count past 255 loses one copy for each piece of 255 it spells: a text of the least length is refused."
			}
		]
	})
