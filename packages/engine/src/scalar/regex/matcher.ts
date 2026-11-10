import { defect } from "#compiler/core/invariant.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { octetsOf, type PatternSource, type RegexRef } from "#compiler/ir/scalar.ts"
import type { CharSet } from "#compiler/scalar/regex/charset.ts"
import { matches, type Nfa, type NfaEdge } from "#compiler/scalar/regex/match.ts"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

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
 * The code of a served automaton's edge (ServedMatcher edges): `^`, `$` and ε by their own codes, and a step on a char
 * set by `set` plus the set's index in the file's table (ServedMatchers sets).
 */
export const edgeCode = { start: 0, end: 1, eps: 2, set: 3 } as const

/**
 * An admitted pattern and its automaton as `grizzle generate` built it (nfa.ts buildNfa over the pattern's parse), held
 * as data where a served file carries it: its start and accepting states, and each state's outgoing edges as integers,
 * two per edge, its code (edgeCode) and then the state it leads to. A load rebuilds the automaton buildNfa made from
 * them and parses nothing (ServedPatterns).
 */
export interface ServedMatcher {
	readonly pattern: PatternSource
	readonly start: number
	readonly accept: number
	readonly edges: ReadonlyArray<ReadonlyArray<number>>
}

/**
 * Every automaton a served file carries: each char set their edges step on, once, and each pattern's automaton over
 * them, in the order the compile's table first met the patterns (scalar/regex/patterns.ts ProgramPatterns served).
 */
export interface ServedMatchers {
	readonly sets: ReadonlyArray<CharSet>
	readonly matchers: ReadonlyArray<ServedMatcher>
}

/** The edge of code `code` leading to `to`, its set read from `sets` (ServedMatcher edges). */
const edgeOf = (sets: ReadonlyArray<CharSet>, code: number, to: number): NfaEdge => {
	switch (code) {
		case edgeCode.start:
			return { kind: "start", to }
		case edgeCode.end:
			return { kind: "end", to }
		case edgeCode.eps:
			return { kind: "eps", to }
		default:
			return { kind: "set", set: entry(sets, code - edgeCode.set), to }
	}
}

/** The automaton a served matcher holds, its edges' sets read from `sets`. */
const nfaOf = (sets: ReadonlyArray<CharSet>, matcher: ServedMatcher): Nfa => {
	const edges: Array<ReadonlyArray<NfaEdge>> = []
	for (const flat of matcher.edges) {
		const out: Array<NfaEdge> = []
		for (let at = 0; at < flat.length; at += 2) {
			out.push(edgeOf(sets, entry(flat, at), entry(flat, at + 1)))
		}
		edges.push(out)
	}
	return { start: matcher.start, accept: matcher.accept, edges }
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

	/** The table of `served`, each pattern by its automaton, rebuilt once over the file's sets. */
	static of(served: ServedMatchers): ServedPatterns {
		const table = new Map<RegexFlags, Map<string, Nfa>>()
		for (const matcher of served.matchers) {
			const bySource = table.get(matcher.pattern.flags) ?? new Map<string, Nfa>()
			table.set(matcher.pattern.flags, bySource)
			bySource.set(matcher.pattern.source, nfaOf(served.sets, matcher))
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
