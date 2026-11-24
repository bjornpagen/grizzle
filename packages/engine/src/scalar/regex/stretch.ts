import {
	type CharSet,
	complement,
	domain,
	intersection,
	isEmpty
} from "@bjornpagen/grizzle-text/regex/charset"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { sourceSet } from "@bjornpagen/grizzle-text/regex/print"
import { alphabetOf, sourceFlags } from "@bjornpagen/grizzle-text/regex/source"
import { wildcardPattern } from "#compiler/ir/scalar.ts"
import { memberNode, type PatternAutomata } from "#compiler/scalar/regex/patterns.ts"

/**
 * The pattern a stretch of a text over `alphabet` is stated by where the stretch holds none of `excluded`, `^N*$`, N
 * the alphabet without `excluded`: the wildcard where N is every admitted character (ir/scalar.ts wildcardPattern),
 * that language's one spelling; `^$` where N is none, the empty text alone; and otherwise N's class as grizzle's grammar
 * spells a set (grizzle-text print.ts sourceSet), one spelling for each set.
 */
export const stretchOver = (alphabet: CharSet, excluded: CharSet): PatternSource => {
	const n = intersection(alphabet, complement(excluded))
	if (isEmpty(n)) {
		return { source: "^$", flags: sourceFlags }
	}
	return isEmpty(complement(n))
		? wildcardPattern
		: { source: `^${sourceSet(n)}*$`, flags: sourceFlags }
}

/**
 * The pattern a stretch of a text of `patterns`' conjunction is stated by where the stretch holds none of `excluded`: a
 * separator split's piece (r.split, ir/rel.ts TextSplit `pieces`, `excluded` its separator) and a rest after a prefix
 * (TextSplit `rest`, nothing excluded), each a run of the text's own characters, so a stretch over the characters every
 * pattern's alphabet holds (grizzle-text source.ts alphabetOf, stretchOver). It holds every such stretch of every text
 * the patterns admit, and is exactly those of a text over an alphabet, `^[A]*$`.
 */
export const stretchSource = (
	patterns: Patterns,
	automata: PatternAutomata,
	excluded: CharSet
): PatternSource =>
	stretchOver(
		patterns.reduce(
			(a, pattern) => intersection(a, alphabetOf(memberNode(pattern, automata))),
			domain
		),
		excluded
	)
