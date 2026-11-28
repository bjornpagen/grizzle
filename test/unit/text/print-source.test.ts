/**
 * grizzle's own grammar spells every language the IR holds (packages/text/src/regex/print.ts printSource), the empty
 * language among them: a node's printed source, read back by grizzle's parser under sourceFlags, is a node of the same
 * language, the empty language's `[]` read back as the empty language. Each case draws a language of whole texts over a
 * small alphabet (sets in sequences, alternations and repetitions), anchored at both ends or at neither, or the empty
 * language, as the IR's builders make it (`never`, a repetition of crossed counts, a sequence through `never`).
 *
 * Oracle: the canonical minimal DFA of each node's search language (dfa.ts minimalDfa, dfaKey), one key exactly when
 * the two languages are one.
 *
 * Features: the empty language, an anchored language, an unanchored language.
 */

import { dfaKey, minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import {
	end,
	never,
	RegexBuilder,
	type RegexNode,
	seq,
	start
} from "@bjornpagen/grizzle-text/regex/ir"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import { sourceFlags } from "@bjornpagen/grizzle-text/regex/source"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { wholeLanguageGen } from "#test/support/unit/text/generators.ts"
import { dfaLimits } from "#test/unit/text/emptiness.fixtures.ts"

type SourceFeature = "the empty language" | "an anchored language" | "an unanchored language"

/** A small alphabet: two letters and a code point past the Basic Multilingual Plane, each spelled by its escape. */
const alphabet = [0x61, 0x62, 0x1f600] as const

/** A node of the IR: a language of whole texts anchored or not, or the empty language as each builder makes it. */
const nodeGen: Gen<RegexNode> = weighted<RegexNode>([
	[3, (source) => seq([start, source.draw(wholeLanguageGen(alphabet, 3)), end])],
	[3, wholeLanguageGen(alphabet, 3)],
	[1, () => never],
	[
		1,
		(source) =>
			new RegexBuilder().repeat(source.draw(wholeLanguageGen(alphabet, 1)), 2, int(0, 1)(source))
	],
	[1, (source) => seq([source.draw(wholeLanguageGen(alphabet, 1)), never])]
])

/** A node's language, keyed by its canonical minimal DFA; every drawn node is far inside the DFA bounds. */
const languageOf = (node: RegexNode): string => {
	const outcome = minimalDfa(buildNfa(node), dfaLimits)
	return outcome.kind === "minimal"
		? dfaKey(outcome.dfa)
		: assert.fail("a drawn node's DFA is within the bounds")
}

/** printSource's text of a node parses back as the node's language, the empty language's included. */
export const printSourcesTextOfANodeParsesBackAsItsLanguageTheEmptyLanguagesIncluded =
	property.explore(nodeGen, {
		needs: {},
		budget: { runs: 200, steered: 40 },
		situations: [
			"the empty language",
			"an anchored language",
			"an unanchored language"
		] satisfies ReadonlyArray<Reached<SourceFeature>>,
		check: (_, c: Case<SourceFeature>) => (node) =>
			Effect.sync(() => {
				const text = printSource(node, (s) => s)
				const parsed = parsePattern(text, sourceFlags)
				if (!parsed.ok) {
					return assert.fail(`${text} parses: ${parsed.error.message}`)
				}
				assert.equal(
					languageOf(parsed.value),
					languageOf(node),
					`${text} reads back as its language`
				)
				c.note(
					node.kind === "never"
						? "the empty language"
						: node.kind === "seq" && node.items[0]?.kind === "start"
							? "an anchored language"
							: "an unanchored language"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the canonical minimal DFA of the node's and of the parsed text's search language"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/print.ts",
				original:
					'\tnode.kind === "never" ? emptyLanguageSource : printIn(sourceDialect(setOf), node)',
				replacement: '\tnode.kind === "never" ? "" : printIn(sourceDialect(setOf), node)',
				why: "The empty language is left unspelled, its source the empty pattern, which every text matches."
			}
		]
	})
