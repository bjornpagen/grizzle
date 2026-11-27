import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type IntersectionOutcome,
	intersectionDfa,
	longestWithin
} from "@bjornpagen/grizzle-text/regex/dfa"
import {
	conjunctionInclusion,
	type Inclusion,
	inclusion
} from "@bjornpagen/grizzle-text/regex/inclusion"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import { type Exceeds, exceedsBytes, includedWithin } from "@bjornpagen/grizzle-text/regex/within"
import { octetsOf, type RegexRef } from "#compiler/ir/scalar.ts"
import { formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"

/** What the inclusion and length proofs read of admitted patterns: each one's canonical DFA (PatternAutomata minimal). */
export type PatternDfas = Pick<PatternAutomata, "minimal">

/** The most UTF-8 bytes a conjunction's value within a byte bound takes, or unknown past the analysis's bounds. */
export type Within =
	| { readonly kind: "within"; readonly bytes: number }
	| { readonly kind: "bounded" }

/** The canonical DFA of a conjunction's language, its members' intersection (dfa.ts intersectionDfa), or none past the bounds. */
const conjunctionDfa = (inner: Patterns, patterns: PatternDfas): IntersectionOutcome => {
	const dfas = mapNonEmpty(inner, (p) => {
		const outcome = patterns.minimal(p)
		return outcome.kind === "minimal" ? outcome.dfa : undefined
	})
	const known = dfas.filter((dfa) => dfa !== undefined)
	return known.length === dfas.length && isNonEmpty(known)
		? intersectionDfa(known, regexDfaLimits)
		: { kind: "bounded" }
}

/**
 * The most UTF-8 bytes a value of the conjunction `inner`'s language of at most `octets` bytes takes (dfa.ts
 * longestWithin), by its intersection's canonical DFA, every automaton read from `patterns`: what a value of a text
 * type of those patterns within that byte bound takes, which a cast or a parse compares with its target's bound.
 * Unknown where a construction would pass the analysis's bounds.
 */
export const bytesWithin = (inner: Patterns, octets: number, patterns: PatternDfas): Within => {
	const product = conjunctionDfa(inner, patterns)
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
	patterns: PatternDfas
): Inclusion =>
	inclusion(
		mapNonEmpty(inner, (p) => patterns.minimal(p)),
		mapNonEmpty(outer, (p) => patterns.minimal(p)),
		regexDfaLimits
	)

/**
 * Whether every value of a conjunction's language of at most `octets` UTF-8 bytes is a member of another conjunction's
 * language (regex/inclusion.ts conjunctionInclusion by regex/within.ts includedWithin: the inner intersection's
 * canonical DFA against each outer member's, or, past the analysis's bounds, one inner member's that lies inside, which
 * holds the intersection's): what a text type of the first language within its byte bound guarantees of the second's,
 * whose bound may cut the first language inside the second, as LearnerId's 69 bytes cut `^.+$` inside `^.{1,255}$`.
 * Refuted where one outer member refutes it, unknown where one is past the bounds, proved otherwise.
 */
const patternIncludesWithin = (
	inner: Patterns,
	octets: number,
	outer: Patterns,
	patterns: PatternDfas
): Inclusion =>
	conjunctionInclusion(
		mapNonEmpty(inner, (p) => patterns.minimal(p)),
		mapNonEmpty(outer, (p) => patterns.minimal(p)),
		(a, b) => includedWithin(a, octets, b, regexDfaLimits),
		regexDfaLimits
	)

/**
 * Whether a conjunction's language holds a value of more than `octets` UTF-8 bytes (regex/within.ts exceedsBytes, by
 * its intersection's canonical DFA): what a text type of that language and no byte bound of its own fails to guarantee
 * of a type whose bound is `octets`. Unknown past the analysis's bounds.
 */
const patternExceeds = (inner: Patterns, octets: number, patterns: PatternDfas): Exceeds => {
	const product = conjunctionDfa(inner, patterns)
	return product.kind === "bounded"
		? { kind: "bounded" }
		: exceedsBytes(product.dfa, octets, regexDfaLimits)
}

/**
 * Whether every value of a conjunction's language is a member of a target's lexical form (patternIncludes): what
 * makes a parse of a value of that language total. The conjunction is a RegexRef's, admitted by the text analysis; every
 * automaton is read from `patterns`.
 */
export const formIncludes = (
	conjunction: Patterns,
	target: LexicalTarget,
	patterns: PatternDfas
): Inclusion => patternIncludes(conjunction, [{ source: formSource(target), flags: "u" }], patterns)

/**
 * A text's language as the inclusion proofs read it: its patterns, and the most UTF-8 bytes any of its values takes,
 * where something bounds them: a type's str.bytes bound or its language's proved bound (RegexCheck bounds), a premise's.
 */
export interface BoundedLanguage {
	readonly patterns: Patterns
	readonly octets: number | undefined
}

/** What an inclusion judgment came to: proved, refuted, or unknown past the text analysis's bounds. */
export type Judgment = Inclusion["kind"]

/**
 * Whether every value of language `inner` is a value of language `outer`, the one inclusion judgment of texts (a type's
 * guarantee of another, check/refinement guarantees; a cast's or a parse's language premise, scalar/compute/lower.ts;
 * the tests' proof kernel's re-derivation of either): the inner language within its byte bound lies inside the outer
 * language (patternIncludesWithin; patternIncludes where it has none), and none of those values takes more bytes than
 * the outer bound allows (bytesWithin within the inner bound; patternExceeds where it has none). Both halves are exact
 * within the analysis's bounds, and a construction past them is `bounded`, deciding nothing: a value of a text is a
 * member of its language within its bound, and of nothing else. metis's LearnerId of 69 bytes, `^.+$`, is a Timeback
 * user of 255 characters, `^.{1,255}$`, only within its bound.
 */
export const languageIncludes = (
	inner: BoundedLanguage,
	outer: BoundedLanguage,
	patterns: PatternDfas
): Judgment => {
	const language =
		inner.octets === undefined
			? patternIncludes(inner.patterns, outer.patterns, patterns)
			: patternIncludesWithin(inner.patterns, inner.octets, outer.patterns, patterns)
	if (language.kind !== "included") {
		return language.kind
	}
	if (outer.octets === undefined || (inner.octets !== undefined && inner.octets <= outer.octets)) {
		return "included"
	}
	if (inner.octets !== undefined) {
		const most = bytesWithin(inner.patterns, inner.octets, patterns)
		return most.kind === "bounded" ? "bounded" : most.bytes <= outer.octets ? "included" : "refuted"
	}
	const past = patternExceeds(inner.patterns, outer.octets, patterns)
	return past.kind === "bounded" ? "bounded" : past.kind === "within" ? "included" : "refuted"
}

/** A refinement's language as the inclusion judgment reads it: its patterns within its proved bytes, or its str.bytes bound. */
export const languageOf = (regex: RegexRef): BoundedLanguage => ({
	patterns: regex.patterns,
	octets: regex.check.bounds?.bytes ?? octetsOf(regex.check)
})
