import { regexDfaMaxStates, regexDfaMaxWork } from "#compiler/core/limits.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { codePointsText } from "#compiler/core/text.ts"
import type { Patterns } from "#compiler/ir/scalar.ts"
import { type CharSet, complement, isEmpty, union } from "#compiler/scalar/regex/charset.ts"
import {
	type CanonicalDfa,
	type DfaLimits,
	type IntersectionOutcome,
	intersectionDfa,
	minimalDfa
} from "#compiler/scalar/regex/dfa.ts"
import type { Nfa } from "#compiler/scalar/regex/match.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

/**
 * Whether every admitted text value one conjunction of patterns matches the other matches too: proved, refuted by a
 * value that is a member of the first and not of the second, or unknown because a construction would pass the
 * analysis's bounds (core/limits.ts regexDfaMaxStates, regexDfaMaxWork).
 */
export type Inclusion =
	| { readonly kind: "included" }
	| { readonly kind: "refuted"; readonly witness: string }
	| { readonly kind: "bounded" }

/** The analysis's bounds on one construction, the subset construction's own. */
const limits: DfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates.value,
	maxWork: regexDfaMaxWork.value
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
