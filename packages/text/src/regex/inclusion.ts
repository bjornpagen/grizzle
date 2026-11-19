import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#text/base/nonempty.ts"
import { type CharSet, complement, intersection, isEmpty, union } from "#text/regex/charset.ts"
import {
	type CanonicalDfa,
	type DfaLimits,
	type IntersectionOutcome,
	intersectionDfa,
	minimalDfa
} from "#text/regex/dfa.ts"
import { end, type RegexNode, seq, start } from "#text/regex/ir.ts"
import { buildNfa, type Nfa } from "#text/regex/nfa.ts"
import { entry } from "#text/regex/table.ts"
import { codePointsText } from "#text/text.ts"

/**
 * Inclusion of regular languages, exactly, within bounds: whether every admitted text one conjunction of automata
 * holds the other holds too, by their canonical minimal DFAs (dfa.ts), proved, refuted by the shortest witness, or
 * unknown where a construction would pass the limits its caller states. The text analysis decides casts and parses by
 * it (the engine's scalar/regex/inclusion.ts, at its regexDfaMaxStates and regexDfaMaxWork), an intersection takes the
 * included side by it (intersection.ts), and a facet composition drops a facet another implies by it (`includedIn`).
 */

/**
 * Whether every admitted text value one conjunction of patterns matches the other matches too: proved, refuted by a
 * value that is a member of the first and not of the second, or unknown because a construction would pass its
 * bounds (DfaLimits: the text analysis's are the engine's regexDfaMaxStates and regexDfaMaxWork).
 */
export type Inclusion =
	| { readonly kind: "included" }
	| { readonly kind: "refuted"; readonly witness: string }
	| { readonly kind: "bounded" }

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
export const included = (
	inner: CanonicalDfa,
	outer: CanonicalDfa,
	limits: DfaLimits
): Inclusion => {
	if (inner.states.length === 0) {
		return { kind: "included" }
	}
	const initial = outer.states.length === 0 ? undefined : 0
	const pairs: Array<Pair> = [{ a: 0, b: initial, parent: -1, last: -1 }]
	const seen = new Set<string>([`0,${initial ?? "-"}`])
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

/** The canonical DFA of an automaton's search language within `limits`, or none past them. */
const dfaOf = (nfa: Nfa, limits: DfaLimits): CanonicalDfa | undefined => {
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
	outer: CanonicalDfa,
	limits: DfaLimits
): Inclusion => {
	const verdict: Inclusion =
		product.kind === "minimal" ? included(product.dfa, outer, limits) : { kind: "bounded" }
	return verdict.kind === "bounded" &&
		inner.some(
			(member) => member !== undefined && included(member, outer, limits).kind === "included"
		)
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
	outer: NonEmptyReadonlyArray<Nfa>,
	limits: DfaLimits
): Inclusion => {
	const innerDfas = mapNonEmpty(inner, (nfa) => dfaOf(nfa, limits))
	const known = innerDfas.filter((dfa) => dfa !== undefined)
	const product: IntersectionOutcome =
		known.length === innerDfas.length && isNonEmpty(known)
			? intersectionDfa(known, limits)
			: { kind: "bounded" }
	const verdicts = outer.map((nfa): Inclusion => {
		const dfa = dfaOf(nfa, limits)
		return dfa === undefined ? { kind: "bounded" } : inclusionInto(innerDfas, product, dfa, limits)
	})
	return (
		verdicts.find((v) => v.kind === "refuted") ??
		verdicts.find((v) => v.kind === "bounded") ?? { kind: "included" }
	)
}

/**
 * Whether every whole text `small` holds `big` holds too: `inclusion` of the two languages of whole texts, each read as
 * `^(?:…)$`, within `limits`.
 */
export const includedIn = (small: RegexNode, big: RegexNode, limits: DfaLimits): Inclusion =>
	inclusion([buildNfa(seq([start, small, end]))], [buildNfa(seq([start, big, end]))], limits)
