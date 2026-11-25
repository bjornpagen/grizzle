import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import {
	combineAll,
	compareNumbers,
	compareStrings,
	type Direction,
	flip,
	mapInput
} from "#compiler/core/order.ts"

/**
 * The fewest indexes a relation's chained requests share (physical/indexes/engine.ts `chainsOf`): each request is a
 * chain of sets its index must lead with in order (a lookup's one set; a range's prefix and then its range column; a
 * whole rule's unit and then the rest of its lookup; a seek's fixed columns and then each of its order keys), and the
 * requests are grouped so that the sets of every group are one chain under inclusion, which one index orders its columns
 * along, in the fewest groups.
 *
 * Two requests may share an index exactly when every set of the one is comparable with every set of the other and their
 * orders are together (`together`); a group whose members do pairwise has sets that are one chain and orders together
 * all at once, so the groups are the cliques of a cover of the graph that joins the requests that may share, and the
 * fewest groups are its fewest cliques.
 *
 * **No exact algorithm is polynomial unless P = NP.** The fewest groups are NP-hard already over requests of at most two
 * sets, none ordered, by a reduction from the colouring of circular-arc graphs (Garey, Johnson, Miller and
 * Papadimitriou, "The complexity of coloring circular arcs and chords", 1980). Cut the circle at a point: an arc that
 * holds it, [s, 1) ∪ [0, e], is the interval [s, 1 + e] on a first track and [s − 1, e] on a second, and any other arc
 * is the same interval on both; two arcs meet exactly when their intervals meet on one track. The intervals of each
 * track ordered by lying wholly left of one another are an interval order, embedded in sets by down-sets: interval v
 * is the set D(v) of the intervals at or left of it, over the track's own columns, so D(u) ⊆ D(v) exactly when u lies
 * left of v or is v. Arc v is the request (D₁(v), X₁ ∪ D₂(v)), X₁ every column of the first track: each request's first
 * set lies within every request's second, so two requests may share exactly when their first sets are comparable and
 * their second sets are, when their arcs meet on neither track, and the fewest groups are the arcs' chromatic number.
 * Do not look for a polynomial exact algorithm: the search below is exponential only in what this theorem forces.
 *
 * Nor is the graph perfect over the requests grizzle makes, so no orientation, canonical form or Dilworth argument is
 * exact over all of them: whole rules' lookups over one unit {A}, {A} < {ABC}, {A} < {ABCD} and {A} < {ABCE}, beside
 * equality lookups {AD}, {ADE}, {E} and {ABE}, may share around a cycle of seven and no further (each with its two
 * neighbours), which needs four groups where no three of them pairwise clash; two lookups of one unit's prefixes,
 * {B} < {ABCD} and {BCD} < {ABCDE}, interleave, beside {C}, {AB} and {ABCE}, around a cycle of five, three groups where
 * no three clash.
 *
 * So the fewest groups are found in exact stages, each polynomial but the last, and the last searches only the requests
 * no earlier stage settles:
 * 1. **Canonical requests.** Requests of the same sets whose orders constrain alike (`constraintOf`: an order of two keys
 *    or more, taken up to reversing it whole and to its keys' order, since `together` reads neither; an order of one key
 *    or none constrains nothing) are one request: whatever may share with one may share with the other, and they may
 *    share with each other. A request whose sets are all sets of another's and whose order the other's implies (none, or
 *    its keys among the other's and together with them) rides the other's group: whatever may share with the other may
 *    share with it, every set of it among the other's and every pair of order keys it shares with a third one the other
 *    shares in the same directions, so adding it to the other's group keeps the group's sets one chain and its orders
 *    together, and the fewest groups of the rest are the fewest of all. Riding is transitive, and the requests are read
 *    widest first, the most sets, then the most order keys, then in their given order, so each one that rides finds a
 *    request it rides among those kept before it. Edullm's Node relation asks 336 chained requests: 39 distinct, 33 that
 *    ride no other.
 * 2. **Components.** The kept requests that may share fall into the components of their graph; a group lies within
 *    one, so each component's fewest groups are found apart and the fewest of all are their sum.
 * 3. **Ordered components.** Each component's requests are ranked by their first set's size, then their last set's,
 *    then their place, and each may-share pair oriented from the lower rank to the higher. Where that orientation is
 *    transitive the graph is a comparability graph, a group is exactly a chain of the order, and the fewest groups are
 *    the fewest chains (`fewestChains`): the requests less a maximum matching (Dilworth, Fulkerson; Hopcroft and Karp).
 *    It is transitive over lookups and unit-step chains, whose every set after the first holds one column more than the
 *    one before (ranges, suffix seeks, seeks), every request of two steps or more ordered (a seek), as the requests
 *    grizzle makes are: with r below s below q, a set x of r and z of q are comparable, since x of at most s's first
 *    set's size lies within it and so within q's first set, which z holds; x of a size within s's lies in s, which has a
 *    set of every size between its ends, every one comparable with x, so x is the one of its size; and x is no larger
 *    than s's last set, a request riding no other being ranked below one whose first set it starts below only where its
 *    last set lies below too. Each pair of order keys r and q share enters their chain at a size within s's span, so s
 *    orders it too and r and q agree with s and so with each other; except where s fixes the first key r and q both
 *    order, its first set that key alone, which the check reads as it reads any other component. The check is the
 *    orientation's every two-step path, and decides every component exactly whatever its requests.
 * 4. **Searched components.** A component the orientation leaves untransitive is coloured exactly, its clashing pairs
 *    the edges, by a branch and bound in DSatur's order (Brélaz): the request clashing with the most distinct colours
 *    goes next, then the one clashing with the most requests yet uncoloured, each colour in use tried in order and a new
 *    one last, so no two branches differ by a renaming of colours, and a branch is cut where it needs as many colours as
 *    the best colouring found. DSatur's order colours a set of pairwise clashing requests first, which bounds every
 *    branch below, so the search proves its colouring fewest within a few branches more than its first descent: Node's
 *    searched component of 33 requests, 12 groups, takes 65 branches, 34 to its first leaf and 31 that find no 11. A
 *    lower bound computed beside it (a largest clash, Tomita and Seki's branch and bound, its colours fixed first) saved
 *    at most 4 steps over 6,000 drawn families of 5 to 30 requests, none on Node, and cost Instance 15, so the search
 *    holds none. Its work is exponential in a component's size at worst, as the theorem forces, and never in the
 *    requests canonical requests merged.
 *
 * `steps` counts the work: one for each request read, each riding test, each pair of kept requests, each two-step path
 * of a component's orientation and each branch of the search. Over a family grown by repeating its requests and the
 * requests that ride them, every stage but the first reads the same kept requests at every size, so the work grows by
 * one step a request.
 */

/** A key an ordered request's index holds in its direction, every one of them, or opposite, every one: its identity
 * and direction. */
export interface OrderKey {
	readonly key: string
	readonly dir: Direction
}

/**
 * Whether two orders take one direction on the keys they share: each key of one in the other's direction, or each
 * opposite. An index holds an order when its keys and the order are together, its leading columns having placed the
 * order's keys, since a B-tree scanned backward yields the exact reverse of its order; two orders one index holds are
 * together, and orders together pairwise are together all at once on any index whose leading runs hold each, since each
 * order fixes only the relative direction of keys adjacent in it, adjacent in the index too, and those pairs make a
 * path, which no two of them constrain apart (physical/indexes/engine.ts `directionsOf`).
 */
export const together = (a: ReadonlyArray<OrderKey>, b: ReadonlyArray<OrderKey>): boolean => {
	const along = a.flatMap((k) => b.filter((l) => l.key === k.key).map((l) => l.dir === k.dir))
	return along.every((same) => same) || along.every((same) => !same)
}

/** A chained request: the chain of sets, each a proper subset of the next, its index must lead with in order, and its
 * order keys, whose directions its index takes up to reversal (none for an unordered request). */
export interface SharingRequest {
	readonly sets: NonEmptyReadonlyArray<ReadonlySet<string>>
	readonly order: ReadonlyArray<OrderKey> | undefined
}

/** The fewest groups of chained requests, each by its members' positions, ascending, the groups in the order of their
 * first members; and the steps the work took (see the module's doc). */
export interface SharingGroups {
	readonly groups: ReadonlyArray<NonEmptyReadonlyArray<number>>
	readonly steps: number
}

/** A request as the stages read it: its position, its sets by their identities, the sizes of its first and last sets,
 * and its order where it constrains one (`constraintOf`). */
interface Read {
	readonly at: number
	readonly sets: NonEmptyReadonlyArray<number>
	readonly held: ReadonlySet<number>
	readonly first: number
	readonly last: number
	readonly constraint: NonEmptyReadonlyArray<OrderKey> | undefined
	readonly signature: string
}

/** An order where it constrains its index's directions: two keys or more, since `together` holds of any order of one. */
const constraintOf = (
	order: ReadonlyArray<OrderKey> | undefined
): NonEmptyReadonlyArray<OrderKey> | undefined =>
	order !== undefined && order.length >= 2
		? sortNonEmpty([defined(order[0], "an order's first key"), ...order.slice(1)], (a, b) =>
				compareStrings(a.key, b.key)
			)
		: undefined

/** An order constraint as one text, up to reversing it whole: each key by whether it runs as the first key does. */
const constraintText = (constraint: NonEmptyReadonlyArray<OrderKey> | undefined): string =>
	constraint === undefined
		? ""
		: constraint
				.map((k) => `${k.key}\u0000${k.dir === constraint[0].dir ? "=" : "~"}`)
				.join("\u0001")

/** Whether order constraint `a` is implied by `b`: none, or its keys among `b`'s and together with them. */
const implied = (
	a: ReadonlyArray<OrderKey> | undefined,
	b: ReadonlyArray<OrderKey> | undefined
): boolean =>
	a === undefined ||
	(b !== undefined && a.every((k) => b.some((l) => l.key === k.key)) && together(a, b))

/** Whether request `r` rides `s` (see the module's doc): every set of `r` is one of `s`'s, and `s`'s order implies
 * `r`'s. */
const rides = (r: Read, s: Read): boolean =>
	r.sets.every((x) => s.held.has(x)) && implied(r.constraint, s.constraint)

/** The requests no other absorbs (see the module's doc, stage 1), by position, and the request each other one rides. */
interface Canonical {
	readonly kernel: ReadonlyArray<Read>
	readonly riders: ReadonlyMap<number, number>
}

/** Canonical requests (see the module's doc, stage 1), `count` told of each step. */
const canonical = (reads: ReadonlyArray<Read>, count: () => void): Canonical => {
	const riders = new Map<number, number>()
	const distinct = new Map<string, Read>()
	for (const r of reads) {
		count()
		const twin = distinct.get(r.signature)
		if (twin === undefined) {
			distinct.set(r.signature, r)
		} else {
			riders.set(r.at, twin.at)
		}
	}
	const widestFirst = [...distinct.values()].toSorted(
		combineAll<Read>([
			flip(mapInput(compareNumbers, (r) => r.sets.length)),
			flip(mapInput(compareNumbers, (r) => r.constraint?.length ?? 0)),
			mapInput(compareNumbers, (r) => r.at)
		])
	)
	const kept: Array<Read> = []
	for (const r of widestFirst) {
		const host = kept.find((s) => {
			count()
			return rides(r, s)
		})
		if (host === undefined) {
			kept.push(r)
		} else {
			riders.set(r.at, host.at)
		}
	}
	return { kernel: kept.toSorted((a, b) => compareNumbers(a.at, b.at)), riders }
}

/**
 * The fewest chains of a strict order given by its successors `above` (each node's successors by position, the order
 * transitive), each chain by its nodes' positions from the least, in the order of their least nodes: the nodes less a
 * maximum matching of the bipartite graph that joins node i on the left to j on the right where j is above i (Dilworth;
 * Fulkerson), each matched edge making j the next node of i's chain, every node the next of at most one and with at
 * most one next, so each path of matched edges is a chain. The matching is Hopcroft and Karp's, O(E √V): rounds of a
 * breadth-first layering from the unmatched left nodes and a depth-first search for vertex-disjoint shortest augmenting
 * paths along it, until a round finds none. Nodes are taken in their given order and each one's successors in theirs,
 * so equal orders give equal chains.
 */
const fewestChains = (
	above: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
	const n = above.length
	const next: Array<number | undefined> = Array.from({ length: n }, () => undefined)
	const previous: Array<number | undefined> = Array.from({ length: n }, () => undefined)
	const layer: Array<number> = Array.from({ length: n }, () => 0)
	/** One breadth-first layering from the unmatched left nodes: whether an augmenting path exists. */
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
	/** A shortest augmenting path from left node `i` along the layering, matched as it is found. */
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
	return above.flatMap((_, first): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
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

/**
 * The fewest colours of the graph `clash` such that no two adjacent nodes share one, each node's colour by position, by
 * DSatur's branch and bound (see the module's doc, stage 4). `count` is told of each branch.
 */
const fewestColours = (
	clash: ReadonlyArray<ReadonlyArray<boolean>>,
	count: () => void
): ReadonlyArray<number> => {
	const n = clash.length
	const colours: Array<number> = Array.from({ length: n }, () => -1)
	let best: ReadonlyArray<number> = Array.from({ length: n }, (_, v) => v)
	let bestCount = n
	/** The next node DSatur colours: the most distinct colours among those it clashes with, then the most clashes with
	 * nodes yet uncoloured, then the first. */
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
				const c = colours[u] ?? -1
				if (c === -1) {
					degree++
				} else {
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
		count()
		if (used >= bestCount) {
			return
		}
		if (coloured === n) {
			best = [...colours]
			bestCount = used
			return
		}
		const v = next()
		for (let c = 0; c <= used; c++) {
			if (c === used && used + 1 >= bestCount) {
				break
			}
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
	return best
}

/**
 * A component's fewest groups, each by its members' positions in `members` (see the module's doc, stages 3 and 4), the
 * members by position and `may` whether two of them may share an index.
 */
const componentGroups = (
	members: ReadonlyArray<Read>,
	may: ReadonlyArray<ReadonlyArray<boolean>>,
	count: () => void
): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
	const rank = (i: number): readonly [number, number, number] => {
		const r = defined(members[i], "a member")
		return [r.first, r.last, i]
	}
	const below = (i: number, j: number): boolean => {
		const [fi, li, ai] = rank(i)
		const [fj, lj, aj] = rank(j)
		return fi !== fj ? fi < fj : li !== lj ? li < lj : ai < aj
	}
	const above = may.map((row, i) => row.flatMap((m, j) => (m && below(i, j) ? [j] : [])))
	const transitive = above.every((up, i) =>
		up.every((j) =>
			(above[j] ?? []).every((q) => {
				count()
				return may[i]?.[q] === true
			})
		)
	)
	if (transitive) {
		return fewestChains(above)
	}
	const colours = fewestColours(
		may.map((row, i) => row.map((m, j) => i !== j && !m)),
		count
	)
	const classes = new Map<number, [number, ...Array<number>]>()
	for (const [v, colour] of colours.entries()) {
		const held = classes.get(colour)
		if (held === undefined) {
			classes.set(colour, [v])
		} else {
			held.push(v)
		}
	}
	return [...classes.values()]
}

/** The fewest groups of `requests` (see the module's doc). */
export const fewestSharingGroups = (requests: ReadonlyArray<SharingRequest>): SharingGroups => {
	let steps = 0
	const count = (): void => {
		steps++
	}
	const ids = new Map<string, number>()
	const members: Array<ReadonlySet<string>> = []
	const idOf = (set: ReadonlySet<string>): number => {
		const text = [...set].toSorted(compareStrings).join("\u0000")
		const known = ids.get(text)
		if (known !== undefined) {
			return known
		}
		ids.set(text, members.length)
		members.push(set)
		return members.length - 1
	}
	const reads: ReadonlyArray<Read> = requests.map((r, at): Read => {
		const sets = mapNonEmpty(r.sets, idOf)
		const constraint = constraintOf(r.order)
		return {
			at,
			sets,
			held: new Set(sets),
			first: r.sets[0].size,
			last: lastNonEmpty(r.sets).size,
			constraint,
			signature: `${sets.join(",")}\u0002${constraintText(constraint)}`
		}
	})
	const within = members.map((a) => members.map((b) => [...a].every((x) => b.has(x))))
	const comparable = (x: number, y: number): boolean =>
		within[x]?.[y] === true || within[y]?.[x] === true
	const { kernel, riders } = canonical(reads, count)
	const may: ReadonlyArray<ReadonlyArray<boolean>> = kernel.map((a, i) =>
		kernel.map((b, j) => {
			count()
			return (
				i !== j &&
				a.sets.every((x) => b.sets.every((y) => comparable(x, y))) &&
				(a.constraint === undefined ||
					b.constraint === undefined ||
					together(a.constraint, b.constraint))
			)
		})
	)
	const component: Array<number> = Array.from({ length: kernel.length }, () => -1)
	const components: Array<Array<number>> = []
	for (const start of kernel.keys()) {
		if (component[start] !== -1) {
			continue
		}
		const held: Array<number> = [start]
		component[start] = components.length
		for (let at = 0; at < held.length; at++) {
			const i = defined(held[at], "a member of a component")
			for (const j of kernel.keys()) {
				if (component[j] === -1 && may[i]?.[j] === true) {
					component[j] = components.length
					held.push(j)
				}
			}
		}
		components.push(held.toSorted(compareNumbers))
	}
	const groupOf = new Map<number, number>()
	let groups = 0
	for (const held of components) {
		const groupsOfComponent = componentGroups(
			held.map((i) => defined(kernel[i], "a kept request")),
			held.map((i) => held.map((j) => may[i]?.[j] === true)),
			count
		)
		for (const group of groupsOfComponent) {
			for (const at of group) {
				groupOf.set(
					defined(kernel[defined(held[at], "a grouped member")], "a kept request").at,
					groups
				)
			}
			groups++
		}
	}
	const hostOf = (at: number): number => {
		const host = riders.get(at)
		return host === undefined ? at : hostOf(host)
	}
	const byGroup = new Map<number, [number, ...Array<number>]>()
	for (const r of reads) {
		const group = defined(groupOf.get(hostOf(r.at)), "a request's host's group")
		const held = byGroup.get(group)
		if (held === undefined) {
			byGroup.set(group, [r.at])
		} else {
			held.push(r.at)
		}
	}
	return {
		groups: [...byGroup.values()].toSorted((a, b) => compareNumbers(a[0], b[0])),
		steps
	}
}
