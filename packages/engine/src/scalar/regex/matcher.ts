import { defect } from "#compiler/core/invariant.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { octetsOf, type PatternSource, type RegexRef } from "#compiler/ir/scalar.ts"
import { matches, type Nfa } from "#compiler/scalar/regex/match.ts"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"

/** The flags every Compute.matches pattern is read under: str.regex's default. */
export const matchFlags: RegexFlags = "u"

/**
 * Whether a text is a member of a regex refinement, each of its patterns' automata read by `nfaOf`: within its byte
 * bound where str.bytes cuts it (ir/scalar.ts octetsOf), and a match of every member's automaton.
 */
export const memberOf = (
	regex: RegexRef,
	nfaOf: (pattern: PatternSource) => Nfa,
	text: string
): boolean => {
	const octets = octetsOf(regex.check)
	return (
		(octets === undefined || utf8Length(text) <= octets) &&
		regex.patterns.every((pattern) => matches(nfaOf(pattern), text))
	)
}

/**
 * An admitted pattern and its automaton as `grizzle generate` built it (nfa.ts buildNfa over the pattern's parse), held
 * as data where a served file carries it: its JSON form is the automaton's own records and arrays, so a load reads it
 * back as buildNfa made it and parses nothing (ServedPatterns).
 */
export interface ServedMatcher {
	readonly pattern: PatternSource
	readonly nfa: Nfa
}

/** Automata by flags and then source. */
type MatcherTable = ReadonlyMap<RegexFlags, ReadonlyMap<string, Nfa>>

/**
 * The patterns a served program checks, each by the automaton its served file carries (ServedMatcher), so a load
 * builds its matchers without the parser: what a refined parameter's value and a match a served program evaluates are
 * judged by, as the compile's own tables judge them (scalar/regex/patterns.ts ProgramPatterns). A pattern outside the
 * file's matchers is a defect of the generate that wrote them, which holds every pattern its types read.
 */
export class ServedPatterns {
	readonly #table: MatcherTable

	private constructor(table: MatcherTable) {
		this.#table = table
	}

	/** The table of `matchers`, each pattern by its served automaton. */
	static of(matchers: Iterable<ServedMatcher>): ServedPatterns {
		const table = new Map<RegexFlags, Map<string, Nfa>>()
		for (const { pattern, nfa } of matchers) {
			const bySource = table.get(pattern.flags) ?? new Map<string, Nfa>()
			table.set(pattern.flags, bySource)
			bySource.set(pattern.source, nfa)
		}
		return new ServedPatterns(table)
	}

	/** The served automaton of `pattern`. */
	readonly nfa = (pattern: PatternSource): Nfa => {
		const known = this.#table.get(pattern.flags)?.get(pattern.source)
		if (known === undefined) {
			throw defect(`a pattern its served file's matchers hold: /${pattern.source}/${pattern.flags}`)
		}
		return known
	}

	readonly member = (regex: RegexRef, text: string): boolean => memberOf(regex, this.nfa, text)

	readonly matches = (source: string, text: string): boolean =>
		matches(this.nfa({ source, flags: matchFlags }), text)
}
