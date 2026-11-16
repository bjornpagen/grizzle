import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { codePointsText } from "#compiler/core/text.ts"
import type { Patterns } from "#compiler/ir/scalar.ts"
import { formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import { type CharSet, complement, isEmpty, union } from "#compiler/scalar/regex/charset.ts"
import {
	type CanonicalDfa,
	type DfaLimits,
	type IntersectionOutcome,
	intersectionDfa,
	longestWithin,
	minimalDfa
} from "#compiler/scalar/regex/dfa.ts"
import type { Nfa } from "#compiler/scalar/regex/match.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

/**
 * The DFA states a pattern's subset construction may create (scalar/regex/dfa.ts minimalDfa), a bound on the compiling
 * process's own work. Past it, or past regexDfaMaxWork, the analysis knows the language by its IR alone: the pattern
 * is enforced by its ARE with structural bounds and keyed by its IR ("ir:", text/refinement.ts keyOf). It refuses
 * nothing, but a change of either bound changes the key, and so the domain digest a snapshot records, of every pattern
 * whose construction lands between the two values.
 *
 * @limitKind measured
 * @owner grizzle's text analysis (scalar/regex/dfa.ts minimalDfa)
 * @unit DFA states
 * @scope the subset construction of one pattern's automaton, in the compiling process
 * @evidence ~/.cache/grizzle-release/LIMITS/out/evidence/dfa/ on cassowary: dfa-2026-11-16T075038.json, the
 *   uncommitted record of `pnpm bench dfa` (bench/dfa/main.ts), and run.log, its console output with the machine's
 *   uptime before it: scalar/regex/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first
 *   cold, then one run under 16 times each limit, on 29 patterns analyzeText admits: `^(?:a|b)*a(?:a|b){k}$` for k
 *   from 6 to 12, 14 and 16 (minimal DFAs of 2^(k+1) states), wide classes over chains of up to 255 copies, chains of
 *   255 copies, and chains of up to 1,024 distinct code points and 512 scattered classes
 * @observed 2026-11-16 07:50:32 to 07:51:05 UTC, one run
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1, one single-threaded process; load average 155 over the 64 CPUs from
 *   other sessions as it started, so the times are a loaded machine's; grizzle ac71cfbb with lane LIMITS's move of the
 *   limits into @grizzle/limits, which changes no construction
 * @workload one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing
 *   and the NFA build untimed
 * @result at k = 9 the construction completes, 1,024 minimal states of 1,026 created, in 20.1 ms median; for k = 10,
 *   11, 12, 14 and 16 it stops at this bound in 5.0 to 15.7 ms median, 25.5 ms at worst, where the whole constructions
 *   take 42.5, 62.7 and 149.1 ms for k = 10 to 12 (2,050 to 8,194 states) and reach 16 times the bound (32,768 states)
 *   in 118.6 and 129.0 ms for k = 14 and 16; `(?:[a-z]{0,255}x){2}` and `(?:[a-z]{0,255}x){8}`, which it cuts in 71.2
 *   and 38.4 ms median, 106.1 ms at worst, reach 16 times it in 3,937.8 and 877.8 ms; memory not measured
 * @decision kept at 2,048: every construction it cuts stops within 110 ms here on a machine loaded past twice its
 *   CPUs, well inside what regexDfaMaxWork allows, while past it the run shows constructions of 32,768 states taking
 *   up to 3.9 s; a change would change the key, and so the domain digest, of every pattern whose construction lands
 *   between the two values; no headroom beyond the run is claimed. The record of 2026-11-05 on a retired macOS VM
 *   (bench/results/dfa/dfa-2026-11-05T080355.json there) found the same order: cuts within 40 ms, 925 ms at 16 times
 * @revalidate a change to the subset construction, its alphabet, the minimization or the canonical form
 *   (scalar/regex/dfa.ts), or to the NFA builder (scalar/regex/nfa.ts); a Node or V8 upgrade; another machine; a
 *   pattern whose construction under the limits takes longer than the slowest here
 */
export const regexDfaMaxStates = 2_048

/**
 * The NFA-state visits a pattern's subset construction is charged (scalar/regex/dfa.ts minimalDfa): the initial closure's
 * states, then for every transition the states of its source subset and of its target, whether the target is computed
 * or is the restart closure computed once; the other bound on the compiling process's own work, with
 * regexDfaMaxStates. It leaves out the alphabet's partition, which grows with the segments the pattern's sets hold, and
 * the canonical form's walk over every segment for every class, at most regexDfaMaxStates times the segments.
 *
 * @limitKind measured
 * @owner grizzle's text analysis (scalar/regex/dfa.ts minimalDfa)
 * @unit NFA-state visits
 * @scope the subset construction of one pattern's automaton, in the compiling process
 * @evidence ~/.cache/grizzle-release/LIMITS/out/evidence/dfa/ on cassowary: dfa-2026-11-16T075038.json, the
 *   uncommitted record of `pnpm bench dfa` (bench/dfa/main.ts), and run.log, its console output with the machine's
 *   uptime before it: scalar/regex/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first
 *   cold, then one run under 16 times each limit, on 29 patterns analyzeText admits: `^(?:a|b)*a(?:a|b){k}$` for k
 *   from 6 to 12, 14 and 16 (minimal DFAs of 2^(k+1) states), wide classes over chains of up to 255 copies, chains of
 *   255 copies, and chains of up to 1,024 distinct code points and 512 scattered classes
 * @observed 2026-11-16 07:50:32 to 07:51:05 UTC, one run
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1, one single-threaded process; load average 155 over the 64 CPUs from
 *   other sessions as it started, so the times are a loaded machine's; grizzle ac71cfbb with lane LIMITS's move of the
 *   limits into @grizzle/limits, which changes no construction
 * @workload one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing
 *   and the NFA build untimed
 * @result the constructions it cuts stop in 17.1 to 370.5 ms median, 666.1 ms at worst (`^(?:.{0,255}){8}$`, at 538
 *   states); among them `^(?:[a-z]{0,255}){8}$`, `^(?:[a-z]{1,255}){16}$` and `^(?:.{0,255}){8}$` stop in 188.9, 260.4
 *   and 370.5 ms median, where their whole constructions take 579, 3,098 and 800 ms (5.5, 23.6 and 5.5 million
 *   visits); the slowest construction it admits, `<512 classes of 8 scattered code points>` (513 minimal states,
 *   789,506 visits), completes in 399.6 ms median, 740.2 ms at worst; memory not measured
 * @decision kept at 2,097,152: at it every construction of the run, cut or completed, ends within 750 ms on a machine
 *   loaded past twice its CPUs, while the constructions it cuts take up to 3.1 s whole; a change would change the key,
 *   and so the domain digest, of every pattern whose construction lands between the two values; no headroom beyond the
 *   run is claimed. The record of 2026-11-05 on a retired macOS VM found the same order: within 230 ms, 1.8 s whole
 * @revalidate a change to the subset construction, its alphabet, the minimization or the canonical form
 *   (scalar/regex/dfa.ts), or to the NFA builder (scalar/regex/nfa.ts); a Node or V8 upgrade; another machine; a
 *   pattern whose construction under the limits takes longer than the slowest here
 */
export const regexDfaMaxWork = 2_097_152

/**
 * Whether every admitted text value one conjunction of patterns matches the other matches too: proved, refuted by a
 * value that is a member of the first and not of the second, or unknown because a construction would pass the
 * analysis's bounds (regexDfaMaxStates, regexDfaMaxWork).
 */
export type Inclusion =
	| { readonly kind: "included" }
	| { readonly kind: "refuted"; readonly witness: string }
	| { readonly kind: "bounded" }

/** The analysis's bounds on one construction, the subset construction's own. */
const limits: DfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates,
	maxWork: regexDfaMaxWork
})

/** The code points both sets hold. */
const intersection = (a: CharSet, b: CharSet): CharSet =>
	complement(union([complement(a), complement(b)]))

/**
 * A state of the walk over the product of two canonical DFAs: a state of the first, a state of the second or none
 * where the second has rejected the prefix (a canonical DFA omits its dead state), and how the walk reached it: the
 * state it extends and the code point it read, the least of the set it stands for.
 */
interface Pair {
	readonly a: number
	readonly b: number | undefined
	readonly parent: number
	readonly last: number
}

/**
 * Whether the language of `inner` is included in that of `outer`, two canonical DFAs, which read whole values: a
 * breadth-first walk of their product from the pair of initial states, where a pair whose first state accepts and
 * whose second does not, or has none, ends it with the prefix that reached it, the shortest such value. Every state of
 * a canonical DFA leads to a member, so a pair whose second state is gone still leads to a refutation, and the walk
 * follows each edge of the first state split by the second state's edges, the rest of its set leading nowhere in the
 * second. The product is one more DFA the analysis builds, bounded as the subset construction is.
 */
const included = (inner: CanonicalDfa, outer: CanonicalDfa): Inclusion => {
	if (inner.states.length === 0) {
		return { kind: "included" }
	}
	const start = outer.states.length === 0 ? undefined : 0
	const pairs: Array<Pair> = [{ a: 0, b: start, parent: -1, last: -1 }]
	const seen = new Set<string>([`0,${start ?? "-"}`])
	let work = 0
	const witness = (at: number): string => {
		const points: Array<number> = []
		for (let p = entry(pairs, at); p.parent >= 0; p = entry(pairs, p.parent)) {
			points.push(p.last)
		}
		return codePointsText(points.toReversed())
	}
	for (let at = 0; at < pairs.length; at++) {
		const { a, b } = entry(pairs, at)
		const first = entry(inner.states, a)
		const second = b === undefined ? undefined : entry(outer.states, b)
		if (first.accept && second?.accept !== true) {
			return { kind: "refuted", witness: witness(at) }
		}
		const visit = (to: number, next: number | undefined, set: CharSet): Inclusion | undefined => {
			const key = `${to},${next ?? "-"}`
			const least = set[0]
			if (least === undefined || seen.has(key)) {
				return undefined
			}
			if (seen.size >= limits.maxStates) {
				return { kind: "bounded" }
			}
			seen.add(key)
			pairs.push({ a: to, b: next, parent: at, last: least[0] })
			return undefined
		}
		for (const edge of first.edges) {
			work += 1 + (second?.edges.length ?? 0)
			if (work > limits.maxWork) {
				return { kind: "bounded" }
			}
			for (const along of second?.edges ?? []) {
				const both = intersection(edge.set, along.set)
				const stop = isEmpty(both) ? undefined : visit(edge.to, along.to, both)
				if (stop !== undefined) {
					return stop
				}
			}
			const rest = intersection(
				edge.set,
				complement(union((second?.edges ?? []).map((e) => e.set)))
			)
			const stop = isEmpty(rest) ? undefined : visit(edge.to, undefined, rest)
			if (stop !== undefined) {
				return stop
			}
		}
	}
	return { kind: "included" }
}

/** The canonical DFA of an automaton's search language within the analysis's bounds, or none past them. */
const dfaOf = (nfa: Nfa): CanonicalDfa | undefined => {
	const outcome = minimalDfa(nfa, limits)
	return outcome.kind === "minimal" ? outcome.dfa : undefined
}

/**
 * Whether the intersection of `inner`'s languages is included in `outer`'s language, the canonical DFA of one member of
 * the outer conjunction: by the inner intersection's own DFA `product` where the bounds reach it (`included`); where
 * they reach neither the intersection nor its walk, proved where one inner member's language lies inside, which holds
 * the intersection's, and unknown otherwise.
 */
const inclusionInto = (
	inner: ReadonlyArray<CanonicalDfa | undefined>,
	product: IntersectionOutcome,
	outer: CanonicalDfa
): Inclusion => {
	const verdict: Inclusion =
		product.kind === "minimal" ? included(product.dfa, outer) : { kind: "bounded" }
	return verdict.kind === "bounded" &&
		inner.some((member) => member !== undefined && included(member, outer).kind === "included")
		? { kind: "included" }
		: verdict
}

/**
 * Whether the language of the conjunction `inner` is included in that of the conjunction `outer`, automata of the
 * admitted grammar under its search semantics (nfa.ts buildNfa): each is determinized and minimized to its canonical
 * DFA (dfa.ts minimalDfa), which reads whole values, the inner ones intersected (dfa.ts intersectionDfa), and the
 * intersection's walked against each outer member's (inclusionInto). Refuted where it falls outside an outer member, by
 * the first such member's witness; proved where it lies inside every one; and unknown where a construction past the
 * bounds leaves one undecided.
 */
export const inclusion = (
	inner: NonEmptyReadonlyArray<Nfa>,
	outer: NonEmptyReadonlyArray<Nfa>
): Inclusion => {
	const innerDfas = mapNonEmpty(inner, dfaOf)
	const known = innerDfas.filter((dfa) => dfa !== undefined)
	const product: IntersectionOutcome =
		known.length === innerDfas.length && isNonEmpty(known)
			? intersectionDfa(known, limits)
			: { kind: "bounded" }
	const verdicts = outer.map((nfa): Inclusion => {
		const dfa = dfaOf(nfa)
		return dfa === undefined ? { kind: "bounded" } : inclusionInto(innerDfas, product, dfa)
	})
	return (
		verdicts.find((v) => v.kind === "refuted") ??
		verdicts.find((v) => v.kind === "bounded") ?? { kind: "included" }
	)
}

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
	const dfas = mapNonEmpty(inner, (p) => dfaOf(patterns.parse(p).nfa))
	const known = dfas.filter((dfa) => dfa !== undefined)
	const product: IntersectionOutcome =
		known.length === dfas.length && isNonEmpty(known)
			? intersectionDfa(known, limits)
			: { kind: "bounded" }
	if (product.kind === "bounded") {
		return { kind: "bounded" }
	}
	const walked = longestWithin(product.dfa, octets, limits)
	return walked.kind === "within" ? walked : { kind: "bounded" }
}

/**
 * Whether every value one admitted conjunction's language holds the other's holds too (inclusion): what makes a cast of
 * a text of the first language into a text type of the second total.
 */
export const patternIncludes = (
	inner: Patterns,
	outer: Patterns,
	patterns: PatternAutomata
): Inclusion =>
	inclusion(
		mapNonEmpty(inner, (p) => patterns.parse(p).nfa),
		mapNonEmpty(outer, (p) => patterns.parse(p).nfa)
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
