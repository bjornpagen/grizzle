import {
	type CharSet,
	complement,
	domain,
	intersection,
	isEmpty,
	maxUtf8Width,
	union,
	utf8Classes
} from "#text/regex/charset.ts"
import {
	type CanonicalDfa,
	type DfaLimits,
	longestWithin,
	type WithinOutcome
} from "#text/regex/dfa.ts"
import type { Inclusion } from "#text/regex/inclusion.ts"
import { entry } from "#text/regex/table.ts"
import { codePointsText } from "#text/text.ts"

/**
 * Inclusion of a language within a byte bound, exactly, within bounds: whether every member of one canonical DFA's
 * language that takes at most so many UTF-8 bytes is a member of another's (`includedWithin`), and whether a language
 * holds a member past a byte bound (`exceedsBytes`). A text type is a language and a byte bound its domain enforces
 * beside it, so one text type guarantees another exactly when its language within its bound lies inside the other's
 * language, and none of its members within its bound passes the other's bound: the engine's text guarantee
 * (check/refinement guarantees) reads both, where an inclusion of the languages alone (inclusion.ts) misses a bound
 * that cuts the inner language inside the outer, a learner's id of 69 bytes inside a person's of 255 characters.
 */

/**
 * A state of the walk over the product of two canonical DFAs within a byte bound: a state of the first, a state of the
 * second or none where the second has rejected the prefix (a canonical DFA omits its dead state), the fewest bytes a
 * prefix reaching the pair takes, and how the walk reached it: the state it extends and the code point it read, the
 * least of the set it stands for.
 */
interface Reached {
	readonly a: number
	readonly b: number | undefined
	readonly bytes: number
	readonly parent: number
	readonly last: number
}

/**
 * Whether every member of `inner`'s language of at most `octets` UTF-8 bytes is a member of `outer`'s language, two
 * canonical DFAs which read whole values: a walk of their product from the pair of initial states, each pair reached at
 * the fewest bytes a prefix reaching it takes, pairs taken in order of their bytes, so a pair is taken first at its
 * fewest, from a ring of a bucket for each byte count up to a code point's widest past the one taken (Dial's queue), so
 * the walk's memory is its pairs' whatever the bound, a text's of 2^28 bytes among them; a pair whose first state accepts and whose second does not, or has none, refutes the
 * inclusion with the prefix that reached it, a member of the fewest bytes outside. A prefix reaching a pair at more
 * bytes has no continuation the fewest's lacks, so the walk finds a refutation within the bound exactly when one is,
 * and proves the inclusion otherwise. Each edge of the first state is split by the second state's edges, the rest of
 * its set leading nowhere in the second, and each piece by the UTF-8 widths of its code points (charset.ts
 * utf8Classes), a code point of w bytes moving the count by w. The walk is one more product the analysis builds,
 * bounded as the subset construction is: its pairs by `limits.maxStates`, the edges it splits by `limits.maxWork`.
 */
export const includedWithin = (
	inner: CanonicalDfa,
	octets: number,
	outer: CanonicalDfa,
	limits: DfaLimits
): Inclusion => {
	if (inner.states.length === 0) {
		return { kind: "included" }
	}
	const initial = outer.states.length === 0 ? undefined : 0
	const reached: Array<Reached> = [{ a: 0, b: initial, bytes: 0, parent: -1, last: -1 }]
	/** The fewest bytes each pair is reached at so far, with its place in `reached`. */
	const fewest = new Map<string, number>([[`0,${initial ?? "-"}`, 0]])
	/** The pairs to take at each byte count, by the count modulo the ring's length, one more than the widest code point's. */
	const ring: Array<Array<number>> = Array.from({ length: maxUtf8Width(domain) + 1 }, () => [])
	entry(ring, 0).push(0)
	let work = 0
	const witness = (at: number): string => {
		const points: Array<number> = []
		for (let p = entry(reached, at); p.parent >= 0; p = entry(reached, p.parent)) {
			points.push(p.last)
		}
		return codePointsText(points.toReversed())
	}
	for (let bytes = 0, idle = 0; bytes <= octets && idle < ring.length; bytes++) {
		const taken = entry(ring, bytes % ring.length)
		ring[bytes % ring.length] = []
		idle = taken.length === 0 ? idle + 1 : 0
		for (const at of taken) {
			const { a, b } = entry(reached, at)
			if (fewest.get(`${a},${b ?? "-"}`) !== at) {
				continue
			}
			const first = entry(inner.states, a)
			const second = b === undefined ? undefined : entry(outer.states, b)
			if (first.accept && second?.accept !== true) {
				return { kind: "refuted", witness: witness(at) }
			}
			const visit = (to: number, next: number | undefined, set: CharSet): Inclusion | undefined => {
				for (const { width, set: of } of utf8Classes) {
					const piece = intersection(set, of)
					const least = piece[0]
					const after = bytes + width
					if (least === undefined || after > octets) {
						continue
					}
					const key = `${to},${next ?? "-"}`
					const known = fewest.get(key)
					if (known !== undefined && entry(reached, known).bytes <= after) {
						continue
					}
					if (known === undefined && fewest.size >= limits.maxStates) {
						return { kind: "bounded" }
					}
					fewest.set(key, reached.length)
					entry(ring, after % ring.length).push(reached.length)
					reached.push({ a: to, b: next, bytes: after, parent: at, last: least[0] })
				}
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
	}
	return { kind: "included" }
}

/** Whether a language holds a member past a byte bound, or unknown past the analysis's bounds. */
export type Exceeds =
	| { readonly kind: "exceeds" }
	| { readonly kind: "within" }
	| { readonly kind: "bounded" }

/**
 * Whether `dfa`'s language holds a member of more than `octets` UTF-8 bytes: exactly where it holds one of more than
 * `octets` and at most `octets` + 4n bytes, n its states, so the longest member within that bound (dfa.ts
 * longestWithin) passes `octets`. A member past the bound of the fewest code points has at most n of them past the
 * bound, or the pumping lemma would remove a loop of at most n code points, at most 4n bytes, from it and leave a
 * shorter member still past the bound, since a loop of a canonical DFA's walk is at most n code points long; so it
 * takes at most `octets` + 4n bytes.
 */
export const exceedsBytes = (dfa: CanonicalDfa, octets: number, limits: DfaLimits): Exceeds => {
	const longest: WithinOutcome = longestWithin(dfa, octets + 4 * dfa.states.length, limits)
	return longest.kind === "bounded"
		? { kind: "bounded" }
		: longest.bytes > octets
			? { kind: "exceeds" }
			: { kind: "within" }
}
