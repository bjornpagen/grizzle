import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type IntersectionOutcome,
	intersectionDfa,
	longestWithin,
	minimalDfa
} from "@bjornpagen/grizzle-text/regex/dfa"
import { type Inclusion, inclusion } from "@bjornpagen/grizzle-text/regex/inclusion"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import { formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"

/** The most UTF-8 bytes a conjunction's value within a byte bound takes, or unknown past the analysis's bounds. */
export type Within =
	| { readonly kind: "within"; readonly bytes: number }
	| { readonly kind: "bounded" }

/**
 * The most UTF-8 bytes a value of the conjunction `inner`'s language of at most `octets` bytes takes (dfa.ts
 * longestWithin), by its intersection's canonical DFA, every automaton read from `patterns`: what a value of a text
 * type of those patterns within that byte bound takes, which a cast or a parse compares with its target's bound.
 * Unknown where a construction would pass the analysis's bounds.
 */
export const bytesWithin = (inner: Patterns, octets: number, patterns: PatternAutomata): Within => {
	const dfas = mapNonEmpty(inner, (p) => {
		const outcome = minimalDfa(patterns.parse(p).matcher.nfa, regexDfaLimits)
		return outcome.kind === "minimal" ? outcome.dfa : undefined
	})
	const known = dfas.filter((dfa) => dfa !== undefined)
	const product: IntersectionOutcome =
		known.length === dfas.length && isNonEmpty(known)
			? intersectionDfa(known, regexDfaLimits)
			: { kind: "bounded" }
	if (product.kind === "bounded") {
		return { kind: "bounded" }
	}
	const walked = longestWithin(product.dfa, octets, regexDfaLimits)
	return walked.kind === "within" ? walked : { kind: "bounded" }
}

/**
 * Whether every value one admitted conjunction's language holds the other's holds too (regex/inclusion.ts inclusion,
 * within the analysis's bounds): what makes a cast of
 * a text of the first language into a text type of the second total.
 */
export const patternIncludes = (
	inner: Patterns,
	outer: Patterns,
	patterns: PatternAutomata
): Inclusion =>
	inclusion(
		mapNonEmpty(inner, (p) => patterns.parse(p).matcher.nfa),
		mapNonEmpty(outer, (p) => patterns.parse(p).matcher.nfa),
		regexDfaLimits
	)

/**
 * Whether every value of a conjunction's language is a member of a target's lexical form (patternIncludes): what
 * makes a parse of a value of that language total. The conjunction is a RegexRef's, admitted by the text analysis; every
 * automaton is read from `patterns`.
 */
export const formIncludes = (
	conjunction: Patterns,
	target: LexicalTarget,
	patterns: PatternAutomata
): Inclusion => patternIncludes(conjunction, [{ source: formSource(target), flags: "u" }], patterns)
