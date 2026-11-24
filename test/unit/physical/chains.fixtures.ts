/** What the property of chains.test.ts reads: its space of families of sets, and its brute-force oracle. */

import { assert } from "@bjornpagen/testing/assert"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { fewestSharingGroups, minimumChainCover } from "#compiler/physical/indexes/chains.ts"

export type ChainFeature =
	| "an antichain of three"
	| "a chain of three"
	| "members overlapping without inclusion"
	| "a family first-fit covers with more chains than the fewest"

/** A family: the columns its sets are drawn from, and each set as the bits of the columns it holds, distinct. */
export interface Family {
	readonly columns: number
	readonly sets: ReadonlyArray<number>
}

/** Families of one to eight distinct nonempty sets over two to five columns. */
export const familyGen: Gen<Family> = (source) => {
	const columns = source.draw(int(2, 5))
	const drawn = source.draw(array(int(1, 2 ** columns - 1), { min: 1, max: 8 }))
	return { columns, sets: Arr.dedupe(drawn) }
}

/** Whether set `a` is a proper subset of set `b`, both as bits. */
const proper = (a: number, b: number): boolean => a !== b && (a & b) === a

/** Whether `a` and `b` are comparable under inclusion. */
const comparable = (a: number, b: number): boolean => (a & b) === a || (a & b) === b

/** Whether `set` is comparable with every set of `chain`. */
const fitsIn = (chain: ReadonlyArray<number>, set: number): boolean =>
	Arr.every(chain, (x) => comparable(x, set))

/** The fewest chains that partition `sets`, by trying every assignment of each set to one of k chains for k from one. */
const fewestChains = (sets: ReadonlyArray<number>): number => {
	const fits = (chains: ReadonlyArray<ReadonlyArray<number>>, at: number): boolean => {
		const set = sets[at]
		return (
			set === undefined ||
			Arr.some(chains, (chain, c) =>
				fitsIn(chain, set)
					? fits(
							Arr.map(chains, (x, i) => (i === c ? [...x, set] : x)),
							at + 1
						)
					: false
			)
		)
	}
	const k = Arr.findFirst(
		Array.from({ length: sets.length }, (_, at) => at + 1),
		(n) =>
			fits(
				Array.from({ length: n }, () => []),
				0
			)
	)
	return Option.getOrElse(k, () => sets.length)
}

const popcount = (x: number): number => (x === 0 ? 0 : (x & 1) + popcount(x >>> 1))

/** The chains first-fit makes, each set taken by size into the first chain whose every set it is comparable with. */
const firstFit = (sets: ReadonlyArray<number>): number =>
	Arr.reduce(
		Arr.sort(sets, Order.mapInput(Order.Number, popcount)),
		Arr.empty<ReadonlyArray<number>>(),
		(chains, set) => {
			const at = Arr.findFirstIndex(chains, (chain) => fitsIn(chain, set))
			return Option.match(at, {
				onNone: () => [...chains, [set]],
				onSome: (i) => Arr.map(chains, (chain, j) => (j === i ? [...chain, set] : chain))
			})
		}
	).length

/** A set's members as column names. */
const membersOf = (set: number, columns: number): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(
			Array.from({ length: columns }, (_, c) => c),
			(c) => (((set >>> c) & 1) === 1 ? [`c${c}`] : [])
		)
	)

/**
 * One family's case: the cover holds every member exactly once, each chain's members proper subsets of the next, in as
 * many chains as the fewest any partition into chains needs.
 */
export const coverCase = (family: Family, c: Case<ChainFeature>) =>
	Effect.sync(() => {
		const { sets, columns } = family
		const cover = minimumChainCover(Arr.map(sets, (set) => membersOf(set, columns)))
		assert.deepEqual(
			Arr.sort(Arr.flatten(cover), Order.Number),
			Arr.map(sets, (_, at) => at),
			"every member is held by exactly one chain"
		)
		for (const chain of cover) {
			for (const [at, member] of chain.entries()) {
				const after = chain[at + 1]
				if (after !== undefined) {
					assert.ok(
						proper(sets[member] ?? 0, sets[after] ?? 0),
						`${Arr.join(Arr.map(chain, String), " < ")} is a chain`
					)
				}
			}
		}
		const fewest = fewestChains(sets)
		assert.equal(
			cover.length,
			fewest,
			`the fewest chains for ${Arr.join(Arr.map(sets, String), ", ")} over ${columns} columns`
		)
		const pairs = Arr.flatMap(sets, (a, i) =>
			Arr.map(Arr.drop(sets, i + 1), (b) => [a, b] as const)
		)
		if (
			Arr.some(
				pairs,
				([a, b]) =>
					!comparable(a, b) && Arr.some(sets, (x) => !comparable(a, x) && !comparable(b, x))
			)
		) {
			c.note("an antichain of three")
		}
		if (
			Arr.some(pairs, ([a, b]) =>
				Arr.some(sets, (x) => (proper(a, b) && proper(b, x)) || (proper(b, a) && proper(a, x)))
			)
		) {
			c.note("a chain of three")
		}
		if (Arr.some(pairs, ([a, b]) => (a & b) !== 0 && !comparable(a, b))) {
			c.note("members overlapping without inclusion")
		}
		if (firstFit(sets) > fewest) {
			c.note("a family first-fit covers with more chains than the fewest")
		}
	})

export type GroupFeature =
	| "a request of two sets"
	| "two requests whose lower sets clash below a shared set"
	| "a family needing more groups than its widest sets' chains"

/** Requests: each one set, or a set and a proper superset of it it must lead the same index with, over shared columns. */
export interface Requests {
	readonly columns: number
	readonly requests: ReadonlyArray<ReadonlyArray<number>>
}

/** One to ten requests over three to six columns, each one set or a set and a proper superset of it. */
export const requestsGen: Gen<Requests> = (source) => {
	const columns = source.draw(int(3, 6))
	const all = 2 ** columns - 1
	const requests = source.draw(
		array(
			(s) => {
				const lower = s.draw(int(1, all))
				const extra = s.draw(int(0, all))
				const upper = lower | extra
				return upper === lower ? [lower] : [lower, upper]
			},
			{ min: 1, max: 10 }
		)
	)
	return { columns, requests }
}

/** Whether two requests may lead one index: every set of the one comparable with every set of the other. */
const sharing = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
	Arr.every(a, (x) => Arr.every(b, (y) => comparable(x, y)))

/** The fewest groups of pairwise sharing requests, by trying every assignment to k groups for k from one. */
const fewestGroups = (requests: ReadonlyArray<ReadonlyArray<number>>): number => {
	const fits = (
		groups: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>,
		at: number
	): boolean => {
		const r = requests[at]
		return (
			r === undefined ||
			Arr.some(groups, (g, i) =>
				Arr.every(g, (x) => sharing(x, r))
					? fits(
							Arr.map(groups, (x, j) => (j === i ? [...x, r] : x)),
							at + 1
						)
					: false
			)
		)
	}
	return Option.getOrElse(
		Arr.findFirst(
			Array.from({ length: requests.length }, (_, at) => at + 1),
			(k) =>
				fits(
					Array.from({ length: k }, () => []),
					0
				)
		),
		() => requests.length
	)
}

/**
 * One family of requests' case: each group's requests share pairwise, every request is in exactly one group, and there
 * are as many groups as the fewest any grouping needs.
 */
export const groupCase = (family: Requests, c: Case<GroupFeature>) =>
	Effect.sync(() => {
		const { requests, columns } = family
		const groups = fewestSharingGroups(
			Arr.map(requests, (r) => {
				const [first = 0, ...rest] = r
				return [
					membersOf(first, columns),
					...Arr.map(rest, (set) => membersOf(set, columns))
				] as const
			}),
			() => false
		)
		assert.deepEqual(
			Arr.sort(Arr.flatten(groups), Order.Number),
			Arr.map(requests, (_, at) => at),
			"every request is in exactly one group"
		)
		for (const group of groups) {
			for (const a of group) {
				for (const b of group) {
					assert.ok(
						sharing(requests[a] ?? [], requests[b] ?? []),
						`requests ${a} and ${b} share an index`
					)
				}
			}
		}
		const fewest = fewestGroups(requests)
		assert.equal(groups.length, fewest, "the fewest groups")
		if (Arr.some(requests, (r) => r.length === 2)) {
			c.note("a request of two sets")
		}
		const pairs = Arr.flatMap(requests, (a, i) =>
			Arr.map(Arr.drop(requests, i + 1), (b) => [a, b] as const)
		)
		if (
			Arr.some(
				pairs,
				([a, b]) =>
					a.length === 2 && b.length === 2 && !sharing(a, b) && comparable(a[1] ?? 0, b[1] ?? 0)
			)
		) {
			c.note("two requests whose lower sets clash below a shared set")
		}
		const tops = Arr.dedupe(Arr.map(requests, (r) => r[r.length - 1] ?? 0))
		if (fewest > fewestChains(tops)) {
			c.note("a family needing more groups than its widest sets' chains")
		}
	})
