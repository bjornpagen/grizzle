import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { compareNumbers, compareStrings } from "#compiler/core/order.ts"

/** Whether `a` is a proper subset of `b`. */
const properSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
	a.size < b.size && [...a].every((x) => b.has(x))

/**
 * A minimum chain cover of a family of distinct sets under inclusion: the fewest chains, each a list of members of the
 * family every one a proper subset of the next, that together hold every member exactly once, each chain by its members'
 * positions in `members`, the chains in the order of their first members. The prefix sets of one index's columns are a
 * chain, and every chain is the prefix sets of an index that orders its columns along it, so the fewest chains are the
 * fewest indexes whose leading columns are exactly each member (physical/indexes/engine.ts `planIndexes`).
 *
 * By Dilworth's theorem the fewest chains are as many as the largest antichain, and by Fulkerson's reduction they are the
 * members less a maximum matching of the bipartite graph that joins member i on the left to member j on the right where i
 * is a proper subset of j: each matched edge makes j the next member of i's chain, every member is the next of at most
 * one and has at most one next, and inclusion is transitive, so each path of matched edges is a chain. The matching is
 * Hopcroft and Karp's, O(E √V): rounds of a breadth-first layering from the unmatched left members and a depth-first
 * search for vertex-disjoint shortest augmenting paths along it, until a round finds none. Members are taken in their
 * given order and each one's supersets in theirs, so equal families give equal covers.
 */
export const minimumChainCover = (
	members: ReadonlyArray<ReadonlySet<string>>
): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
	const n = members.length
	const above: ReadonlyArray<ReadonlyArray<number>> = members.map((a) =>
		members.flatMap((b, j) => (properSubset(a, b) ? [j] : []))
	)
	const next: Array<number | undefined> = Array.from({ length: n }, () => undefined)
	const previous: Array<number | undefined> = Array.from({ length: n }, () => undefined)
	const layer: Array<number> = Array.from({ length: n }, () => 0)
	/** One breadth-first layering from the unmatched left members: whether an augmenting path exists. */
	const layered = (): boolean => {
		const queue: Array<number> = []
		for (let i = 0; i < n; i++) {
			layer[i] = next[i] === undefined ? 0 : Number.POSITIVE_INFINITY
			if (next[i] === undefined) {
				queue.push(i)
			}
		}
		let found = false
		for (let at = 0; at < queue.length; at++) {
			const i = queue[at] ?? 0
			for (const j of above[i] ?? []) {
				const back = previous[j]
				if (back === undefined) {
					found = true
				} else if (layer[back] === Number.POSITIVE_INFINITY) {
					layer[back] = (layer[i] ?? 0) + 1
					queue.push(back)
				}
			}
		}
		return found
	}
	/** A shortest augmenting path from left member `i` along the layering, matched as it is found. */
	const augmented = (i: number): boolean => {
		for (const j of above[i] ?? []) {
			const back = previous[j]
			if (back !== undefined && (layer[back] !== (layer[i] ?? 0) + 1 || !augmented(back))) {
				continue
			}
			next[i] = j
			previous[j] = i
			return true
		}
		layer[i] = Number.POSITIVE_INFINITY
		return false
	}
	while (layered()) {
		for (let i = 0; i < n; i++) {
			if (next[i] === undefined) {
				augmented(i)
			}
		}
	}
	return members.flatMap((_, first): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
		if (previous[first] !== undefined) {
			return []
		}
		const chain: [number, ...Array<number>] = [first]
		for (let at = next[first]; at !== undefined; at = next[at]) {
			chain.push(at)
		}
		return [chain]
	})
}

/** Whether `a` and `b` are comparable under inclusion. */
const comparable = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
	(a.size <= b.size ? [...a].every((x) => b.has(x)) : false) ||
	(b.size <= a.size ? [...b].every((x) => a.has(x)) : false)

/**
 * The fewest groups of `requests`, each a chain of sets an index must lead with together (a range's prefix and then its
 * range column, a whole rule's unit and then the rest), such that the sets of each group are one chain under inclusion,
 * so one index orders its columns along it and serves every request of the group; each group by its members' positions,
 * in the order of their first members.
 *
 * Two requests may share an index exactly when every set of the one is comparable with every set of the other and they
 * are not `apart` (two orders in no one direction), and a group whose members do pairwise has sets that are one chain, so the groups are the colour classes of the fewest
 * colours of the graph that joins two requests that may not share an index. Its colouring is searched exactly, by
 * branch and bound in DSatur's order (Brélaz): the uncoloured request with the most distinct colours among the requests
 * it may not share with goes next, each colour tried in order and a new one last, a branch cut as soon as it needs as
 * many colours as the best found. The search stops at the floor, the fewest chains of the requests' widest sets under
 * inclusion (`minimumChainCover`), which every grouping's widest sets make: where every request is one set, the floor
 * is the answer, and a family of chains whose lower sets agree reaches it at its first leaf.
 */
export const fewestSharingGroups = (
	requests: ReadonlyArray<NonEmptyReadonlyArray<ReadonlySet<string>>>,
	apart: (i: number, j: number) => boolean
): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
	const n = requests.length
	const clash: ReadonlyArray<ReadonlyArray<boolean>> = requests.map((r, i) =>
		requests.map((s, j) => !r.every((x) => s.every((y) => comparable(x, y))) || apart(i, j))
	)
	const tops = new Map<string, ReadonlySet<string>>()
	for (const r of requests) {
		const top = r[r.length - 1] ?? r[0]
		tops.set([...top].toSorted(compareStrings).join("\u0000"), top)
	}
	const floor = minimumChainCover([...tops.values()]).length
	const colours: Array<number> = Array.from({ length: n }, () => -1)
	let best: ReadonlyArray<number> = Array.from({ length: n }, (_, at) => at)
	let bestCount = n
	/** The next request DSatur colours: the most distinct colours among those it clashes with, then the most clashes. */
	const next = (): number => {
		let pick = -1
		let pickSaturation = -1
		let pickDegree = -1
		for (let v = 0; v < n; v++) {
			if (colours[v] !== -1) {
				continue
			}
			const seen = new Set<number>()
			let degree = 0
			for (let u = 0; u < n; u++) {
				if (clash[v]?.[u] !== true) {
					continue
				}
				degree++
				const c = colours[u] ?? -1
				if (c !== -1) {
					seen.add(c)
				}
			}
			if (seen.size > pickSaturation || (seen.size === pickSaturation && degree > pickDegree)) {
				pick = v
				pickSaturation = seen.size
				pickDegree = degree
			}
		}
		return pick
	}
	const search = (coloured: number, used: number): void => {
		if (used >= bestCount || bestCount === floor) {
			return
		}
		if (coloured === n) {
			best = [...colours]
			bestCount = used
			return
		}
		const v = next()
		for (let c = 0; c <= used && c < bestCount - (c === used ? 1 : 0); c++) {
			let free = true
			for (let u = 0; u < n && free; u++) {
				free = !(clash[v]?.[u] === true && colours[u] === c)
			}
			if (free) {
				colours[v] = c
				search(coloured + 1, Math.max(used, c + 1))
				colours[v] = -1
			}
		}
	}
	search(0, 0)
	const groups = new Map<number, [number, ...Array<number>]>()
	for (const [at, colour] of best.entries()) {
		const group = groups.get(colour)
		if (group === undefined) {
			groups.set(colour, [at])
		} else {
			group.push(at)
		}
	}
	return [...groups.values()].toSorted((a, b) => compareNumbers(a[0], b[0]))
}
