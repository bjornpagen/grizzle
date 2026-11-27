import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { CharSet } from "@bjornpagen/grizzle-text/regex/charset"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import type { CountOp, Nfa, NfaEdge } from "@bjornpagen/grizzle-text/regex/nfa"
import type { PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import type { RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import { entry } from "@bjornpagen/grizzle-text/regex/table"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { matchFlags } from "#compiler/ir/pattern.ts"
import { octetsOf, type RegexRef } from "#compiler/ir/scalar.ts"

/**
 * Whether a text is a member of a regex refinement, each of its patterns' matchers read by `matcherOf`: within its byte
 * bound where str.bytes cuts it (ir/scalar.ts octetsOf), and a match of every member's automaton.
 */
export const memberOf = (
	regex: RegexRef,
	matcherOf: (pattern: PatternSource) => Matcher,
	text: string
): boolean => {
	const octets = octetsOf(regex.check)
	return (
		(octets === undefined || utf8Length(text) <= octets) &&
		regex.patterns.every((pattern) => matcherOf(pattern).matches(text))
	)
}

/**
 * The code of a served automaton's edge (ServedMatcher edges): `^`, `$` and ε by their own codes, and a step on a char
 * set by `set` plus the set's index in the file's table (ServedMatchers sets).
 */
export const edgeCode = { start: 0, end: 1, eps: 2, set: 3 } as const

/**
 * The code of an operation on a repetition's counter (nfa.ts CountOp) in a served automaton, each negative, so no edge's
 * code is one: the five on the top counter by their own codes, and a consumed operation of the counter k under the top
 * by `consumed` less k.
 */
export const countCode = {
	enter: -1,
	again: -2,
	counted: -3,
	loop: -4,
	leave: -5,
	consumed: -6
} as const

/**
 * An admitted pattern and its automaton as `grizzle generate` built it (nfa.ts buildNfa over the pattern's parse), held
 * as data where a served file carries it: its start and accepting states; each state's outgoing edges as integers, two
 * per edge, its code (edgeCode) and then the state it leads to, each edge after its counter operations, two per
 * operation, its code (countCode) and then the repetition it counts; and each repetition as its least count, its copies
 * and whether it loops and counts only consuming iterations, 1 or 0 (nfa.ts NfaRepeat). A load rebuilds the automaton
 * buildNfa made from them and parses nothing (ServedPatterns).
 */
export interface ServedMatcher {
	readonly pattern: PatternSource
	readonly start: number
	readonly accept: number
	readonly edges: ReadonlyArray<ReadonlyArray<number>>
	readonly repeats: ReadonlyArray<readonly [number, number, number, number]>
}

/**
 * Every automaton a served file carries: each char set their edges step on, once, and each pattern's automaton over
 * them, in the order the compile's table first met the patterns (scalar/regex/patterns.ts ProgramPatterns served).
 */
export interface ServedMatchers {
	readonly sets: ReadonlyArray<CharSet>
	readonly matchers: ReadonlyArray<ServedMatcher>
}

/** The edge of code `code` leading to `to` after the operations `counts`, its set read from `sets` (ServedMatcher edges). */
const edgeOf = (
	sets: ReadonlyArray<CharSet>,
	code: number,
	to: number,
	counts: ReadonlyArray<CountOp>
): NfaEdge => {
	switch (code) {
		case edgeCode.start:
			return { kind: "start", to, counts }
		case edgeCode.end:
			return { kind: "end", to, counts }
		case edgeCode.eps:
			return { kind: "eps", to, counts }
		default:
			return { kind: "set", set: entry(sets, code - edgeCode.set), to, counts }
	}
}

/** The counter operation of code `code` on the repetition `repeat` (ServedMatcher edges). */
const countOf = (code: number, repeat: number): CountOp => {
	switch (code) {
		case countCode.enter:
			return { kind: "enter", repeat }
		case countCode.again:
			return { kind: "again", repeat }
		case countCode.counted:
			return { kind: "counted", repeat }
		case countCode.loop:
			return { kind: "loop", repeat }
		case countCode.leave:
			return { kind: "leave", repeat }
		default:
			return { kind: "consumed", repeat, below: countCode.consumed - code }
	}
}

/** The automaton a served matcher holds, its edges' sets read from `sets`. */
const nfaOf = (sets: ReadonlyArray<CharSet>, matcher: ServedMatcher): Nfa => {
	const edges: Array<ReadonlyArray<NfaEdge>> = []
	for (const flat of matcher.edges) {
		const out: Array<NfaEdge> = []
		let counts: Array<CountOp> = []
		for (let at = 0; at < flat.length; at += 2) {
			const code = entry(flat, at)
			const operand = entry(flat, at + 1)
			if (code < 0) {
				counts.push(countOf(code, operand))
			} else {
				out.push(edgeOf(sets, code, operand, counts))
				counts = []
			}
		}
		edges.push(out)
	}
	return {
		start: matcher.start,
		accept: matcher.accept,
		edges,
		repeats: matcher.repeats.map(([least, copies, loops, consuming]) => ({
			least,
			copies,
			loops: loops === 1,
			consuming: consuming === 1
		}))
	}
}

/** Matchers by flags and then source. */
type MatcherTable = ReadonlyMap<RegexFlags, ReadonlyMap<string, Matcher>>

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

	/** The table of `served`, each pattern by the matcher of its automaton, rebuilt once over the file's sets. */
	static of(served: ServedMatchers): ServedPatterns {
		const table = new Map<RegexFlags, Map<string, Matcher>>()
		for (const matcher of served.matchers) {
			const bySource = table.getOrInsertComputed(
				matcher.pattern.flags,
				() => new Map<string, Matcher>()
			)
			bySource.set(matcher.pattern.source, Matcher.of(nfaOf(served.sets, matcher)))
		}
		return new ServedPatterns(table)
	}

	/** The matcher of `pattern`'s served automaton. */
	readonly matcher = (pattern: PatternSource): Matcher => {
		const known = this.#table.get(pattern.flags)?.get(pattern.source)
		if (known === undefined) {
			defect(`a pattern its served file's matchers hold: /${pattern.source}/${pattern.flags}`)
		}
		return known
	}

	readonly member = (regex: RegexRef, text: string): boolean => memberOf(regex, this.matcher, text)

	readonly matches = (source: string, text: string): boolean =>
		this.matcher({ source, flags: matchFlags }).matches(text)
}
