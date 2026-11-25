/**
 * What the properties of chains.test.ts read: their spaces of families of sets and of chained requests, their brute-force
 * oracles, the kept families, and a family grown by repeating its requests and the requests that ride them.
 */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen, int, shuffled, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import {
	fewestSharingGroups,
	type OrderKey,
	type SharingRequest
} from "#compiler/physical/indexes/chains.ts"

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

/** A column's name. */
const columnName = (c: number): string => `c${c}`

/** A set's members as column names. */
const membersOf = (set: number, columns: number): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(
			Array.from({ length: columns }, (_, c) => c),
			(c) => (((set >>> c) & 1) === 1 ? [columnName(c)] : [])
		)
	)

/**
 * One family's case: its sets as one-set requests, lookups, are grouped into chains, every member exactly once, each
 * group's sets pairwise comparable, in as many groups as the fewest any partition into chains needs.
 */
export const coverCase = (family: Family, c: Case<ChainFeature>) =>
	Effect.sync(() => {
		const { sets, columns } = family
		const { groups } = fewestSharingGroups(
			Arr.map(sets, (set) => ({ sets: [membersOf(set, columns)] as const, order: undefined }))
		)
		assert.deepEqual(
			Arr.sort(Arr.flatten(groups), Order.Number),
			Arr.map(sets, (_, at) => at),
			"every member is held by exactly one chain"
		)
		for (const group of groups) {
			for (const a of group) {
				for (const b of group) {
					assert.ok(
						comparable(sets[a] ?? 0, sets[b] ?? 0),
						`${Arr.join(Arr.map(group, String), ", ")} is a chain`
					)
				}
			}
		}
		const fewest = fewestChains(sets)
		assert.equal(
			groups.length,
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
	| "a family needing more groups than its largest clash"
	| "two ordered requests apart"
	| "an ordered request whose sets are all an unordered one's"

/** Whole rules' lookups over one unit {A} beside equality lookups, which share around a cycle of seven (the module's
 * doc of physical/indexes/chains.ts). */
const cycleOfSeven: ReadonlyArray<ReadonlyArray<string>> = [
	["A", "ABC"],
	["A", "ABCD"],
	["AD"],
	["ADE"],
	["E"],
	["ABE"],
	["A", "ABCE"]
]

/** Two lookups of one unit's prefixes that interleave, beside equality lookups, around a cycle of five. */
const cycleOfFive: ReadonlyArray<ReadonlyArray<string>> = [
	["B", "ABCD"],
	["BCD", "ABCDE"],
	["C"],
	["ABCE"],
	["AB"]
]

/** A key of a drawn order: its column and direction. */
interface DrawnKey {
	readonly column: number
	readonly descending: boolean
}

/** A drawn request: its chain of sets as bits, each a proper subset of the next, and its order keys, none unordered. */
export interface Drawn {
	readonly sets: ReadonlyArray<number>
	readonly order: ReadonlyArray<DrawnKey> | undefined
}

/** Requests over shared columns. */
export interface Requests {
	readonly columns: number
	readonly requests: ReadonlyArray<Drawn>
}

/** A lookup, or a set and a proper superset of it it must lead the same index with (a range, a whole rule's lookup). */
const unorderedGen =
	(all: number): Gen<Drawn> =>
	(source) => {
		const lower = source.draw(int(1, all))
		const upper = lower | source.draw(int(0, all))
		return { sets: upper === lower ? [lower] : [lower, upper], order: undefined }
	}

/** A seek along `along`, an order of every column: its first columns fixed, none or some, then the next one to three
 * as its order keys, each ascending or descending, its sets the fixed columns and then each order key added (the first
 * key alone where none is fixed). */
const seekGen =
	(along: ReadonlyArray<number>): Gen<Drawn> =>
	(source) => {
		const fixed = source.draw(int(0, along.length - 1))
		const count = source.draw(int(1, Math.min(3, along.length - fixed)))
		const keys = along.slice(fixed, fixed + count)
		const order = Arr.map(keys, (column) => ({ column, descending: source.draw(boolean) }))
		const base = Arr.reduce(along.slice(0, fixed), 0, (bits, column) => bits | (1 << column))
		const steps = Arr.scan(keys, base, (bits, column) => bits | (1 << column))
		return { sets: base === 0 ? Arr.drop(steps, 1) : steps, order }
	}

/** Requests over three to six columns, one to ten of them, a seek one time in three along one of two orders of the
 * columns, so seeks share keys, else a lookup or a set and a superset. */
const freeGen: Gen<Requests> = (source) => {
	const columns = source.draw(int(3, 6))
	const all = Array.from({ length: columns }, (_, c) => c)
	const along = [
		source.draw(shuffled(all, { min: columns, max: columns })),
		source.draw(shuffled(all, { min: columns, max: columns }))
	]
	const requests = source.draw(
		array(
			(s) =>
				s.draw(int(0, 2)) === 0
					? s.draw(seekGen(along[s.draw(int(0, 1))] ?? all))
					: s.draw(unorderedGen(2 ** columns - 1)),
			{ min: 1, max: 10 }
		)
	)
	return { columns, requests }
}

/** The kept cycles of seven and five (`keptFamilies`), their five letters drawn onto five or six columns, then none to
 * three more requests. */
const cycleGen: Gen<Requests> = (source) => {
	const columns = source.draw(int(5, 6))
	const letters = source.draw(
		shuffled(
			Array.from({ length: columns }, (_, c) => c),
			{ min: 5, max: 5 }
		)
	)
	const columnOf = new Map(Arr.zip(Arr.fromIterable("ABCDE"), letters))
	const bitsOf = (word: string): number =>
		Arr.reduce(
			Arr.fromIterable(word),
			0,
			(bits, letter) => bits | (1 << (columnOf.get(letter) ?? 0))
		)
	const cycle = source.draw(boolean) ? cycleOfSeven : cycleOfFive
	const extra = source.draw(array(unorderedGen(2 ** columns - 1), { min: 0, max: 3 }))
	return {
		columns,
		requests: [
			...Arr.map(cycle, (sets): Drawn => ({ sets: Arr.map(sets, bitsOf), order: undefined })),
			...extra
		]
	}
}

/** Requests of shared columns: free three times in four, else a kept cycle and a few more. */
export const requestsGen: Gen<Requests> = weighted([
	[3, freeGen],
	[1, cycleGen]
])

/** Whether two drawn orders take one direction on the columns they share, each key alike or each opposite. */
const ordersAgree = (a: ReadonlyArray<DrawnKey>, b: ReadonlyArray<DrawnKey>): boolean => {
	const along = Arr.flatMap(a, (k) =>
		Arr.flatMap(b, (l) => (l.column === k.column ? [l.descending === k.descending] : []))
	)
	return Arr.every(along, (same) => same) || Arr.every(along, (same) => !same)
}

/** Whether two requests may lead one index: every set of the one comparable with every set of the other, and their
 * orders, where both have one, agreeing. */
const sharing = (a: Drawn, b: Drawn): boolean =>
	Arr.every(a.sets, (x) => Arr.every(b.sets, (y) => comparable(x, y))) &&
	(a.order === undefined || b.order === undefined || ordersAgree(a.order, b.order))

/** The fewest groups of pairwise sharing requests, by trying every assignment to k groups for k from one. */
const fewestGroups = (requests: ReadonlyArray<Drawn>): number => {
	const fits = (groups: ReadonlyArray<ReadonlyArray<Drawn>>, at: number): boolean => {
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

/** The most requests that pairwise may not share, by trying every subset: no grouping needs fewer groups. */
const largestClash = (requests: ReadonlyArray<Drawn>): number => {
	const grow = (chosen: ReadonlyArray<Drawn>, at: number): number => {
		const r = requests[at]
		if (r === undefined) {
			return chosen.length
		}
		const without = grow(chosen, at + 1)
		return Arr.every(chosen, (x) => !sharing(x, r))
			? Math.max(without, grow([...chosen, r], at + 1))
			: without
	}
	return grow([], 0)
}

/** A drawn request as the cover reads it, each column by its name. */
const sharingRequestOf = (r: Drawn, columns: number): SharingRequest => {
	const [first = 0, ...rest] = r.sets
	return {
		sets: [membersOf(first, columns), ...Arr.map(rest, (set) => membersOf(set, columns))],
		order:
			r.order === undefined
				? undefined
				: Arr.map(r.order, (k): OrderKey => ({
						key: columnName(k.column),
						dir: k.descending ? "desc" : "asc"
					}))
	}
}

/**
 * One family of requests' case: each group's requests share pairwise, every request is in exactly one group, and there
 * are as many groups as the fewest any grouping needs.
 */
export const groupCase = (family: Requests, c: Case<GroupFeature>) =>
	Effect.sync(() => {
		const { requests, columns } = family
		const { groups } = fewestSharingGroups(Arr.map(requests, (r) => sharingRequestOf(r, columns)))
		assert.deepEqual(
			Arr.sort(Arr.flatten(groups), Order.Number),
			Arr.map(requests, (_, at) => at),
			"every request is in exactly one group"
		)
		for (const group of groups) {
			for (const a of group) {
				for (const b of group) {
					assert.ok(
						sharing(
							requests[a] ?? { sets: [], order: undefined },
							requests[b] ?? { sets: [], order: undefined }
						),
						`requests ${a} and ${b} share an index`
					)
				}
			}
		}
		const fewest = fewestGroups(requests)
		assert.equal(groups.length, fewest, "the fewest groups")
		if (Arr.some(requests, (r) => r.order === undefined && r.sets.length === 2)) {
			c.note("a request of two sets")
		}
		const pairs = Arr.flatMap(requests, (a, i) =>
			Arr.map(Arr.drop(requests, i + 1), (b) => [a, b] as const)
		)
		if (
			Arr.some(
				pairs,
				([a, b]) =>
					a.sets.length === 2 &&
					b.sets.length === 2 &&
					!sharing(a, b) &&
					comparable(a.sets[1] ?? 0, b.sets[1] ?? 0)
			)
		) {
			c.note("two requests whose lower sets clash below a shared set")
		}
		const tops = Arr.dedupe(Arr.map(requests, (r) => r.sets[r.sets.length - 1] ?? 0))
		if (fewest > fewestChains(tops)) {
			c.note("a family needing more groups than its widest sets' chains")
		}
		if (fewest > largestClash(requests)) {
			c.note("a family needing more groups than its largest clash")
		}
		const sameSets = (a: Drawn, b: Drawn): boolean => Arr.every(a.sets, (x) => b.sets.includes(x))
		if (
			Arr.some(
				pairs,
				([a, b]) =>
					a.order !== undefined &&
					b.order !== undefined &&
					Arr.every(a.sets, (x) => Arr.every(b.sets, (y) => comparable(x, y))) &&
					!ordersAgree(a.order, b.order)
			)
		) {
			c.note("two ordered requests apart")
		}
		if (
			Arr.some(
				pairs,
				([a, b]) =>
					(a.order !== undefined &&
						a.order.length >= 2 &&
						b.order === undefined &&
						sameSets(a, b)) ||
					(b.order !== undefined && b.order.length >= 2 && a.order === undefined && sameSets(b, a))
			)
		) {
			c.note("an ordered request whose sets are all an unordered one's")
		}
	})

/** A kept family, by name: its requests, each column by name, and the fewest groups it needs. */
export interface KeptFamily {
	readonly name: KeptName
	readonly requests: ReadonlyArray<SharingRequest>
	readonly fewest: number
}

export type KeptName =
	| "a cycle of seven over one unit"
	| "a cycle of five over two prefixes of a unit's key"
	| "edullm's Node"

/** Requests of sets of letters, each set its letters, unordered. */
const lettered = (requests: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<SharingRequest> =>
	Arr.map(requests, (sets) => {
		const [first = "", ...rest] = sets
		return { sets: [new Set(first), ...Arr.map(rest, (s) => new Set(s))], order: undefined }
	})

/**
 * Edullm's Node relation's chained requests, STOREDERIVE3's instrumented generate of the app (vorxvrmx, before
 * mxrtrkuk; ~/.cache/grizzle/STOREDERIVE3-logs/node-chains.json), on which e5a20b1c4's branch and bound ran 536 s of CPU
 * and did not finish: each distinct chain of sets, by its columns, and how many of the 336 requests asked it.
 */
const nodeChains: ReadonlyArray<readonly [number, ReadonlyArray<ReadonlyArray<string>>]> = [
	[6, [["kind", "package", "parent", "parentKind", "path"]]],
	[3, [["kind", "package", "parent", "path"]]],
	[2, [["kind", "package", "parentKind", "parentParentKind", "path"]]],
	[
		1,
		[
			["kind", "package", "parentKind", "path"],
			["end", "kind", "package", "parentKind", "path"]
		]
	],
	[6, [["package"], ["elementChildren", "kind", "package", "parentKind", "path"]]],
	[3, [["package"], ["end", "kind", "package", "parent", "path"]]],
	[4, [["package"], ["kind", "package", "parentKind", "parentParentKind", "path"]]],
	[
		7,
		[
			["package", "path"],
			["elementChildren", "kind", "package", "parentKind", "path"]
		]
	],
	[
		1,
		[
			["package", "path"],
			["elements", "kind", "package", "parent", "path"]
		]
	],
	[
		4,
		[
			["package", "path"],
			["elements", "kind", "package", "parentKind", "path"]
		]
	],
	[
		8,
		[
			["package", "path"],
			["kind", "package", "parent", "parentKind", "path"]
		]
	],
	[17, [["kind", "package", "parentKind", "path"]]],
	[
		1,
		[
			["kind", "package", "path"],
			["end", "kind", "package", "path"]
		]
	],
	[18, [["kind", "package", "path"]]],
	[1, [["kind", "parentKind", "parentParentKind", "path"]]],
	[1, [["package"], ["elementChildren", "kind", "package", "parentKind"]]],
	[6, [["package"], ["elementChildren", "kind", "package", "path"]]],
	[57, [["package"], ["kind", "package", "parent", "path"]]],
	[6, [["package"], ["kind", "package", "parentKind", "path"]]],
	[8, [["package"], ["end", "kind", "package", "path"]]],
	[
		1,
		[
			["package", "path"],
			["at", "package", "parent", "path"]
		]
	],
	[
		5,
		[
			["package", "path"],
			["elements", "package", "parent", "path"]
		]
	],
	[
		1,
		[
			["package", "path"],
			["end", "kind", "package", "path"]
		]
	],
	[
		16,
		[
			["package", "path"],
			["kind", "package", "parent", "path"]
		]
	],
	[
		7,
		[
			["package", "path"],
			["kind", "package", "parentKind", "path"]
		]
	],
	[1, [["kind", "package", "parentKind"]]],
	[2, [["kind", "path"]]],
	[5, [["package"], ["kind", "package", "parentKind"]]],
	[43, [["package"], ["kind", "package", "path"]]],
	[1, [["package"], ["kind", "package", "start"]]],
	[2, [["package"], ["package", "parent", "path"]]],
	[1, [["package"], ["package", "parentKind", "path"]]],
	[9, [["package"], ["end", "package", "path"]]],
	[
		49,
		[
			["package", "path"],
			["kind", "package", "path"]
		]
	],
	[
		7,
		[
			["package", "path"],
			["package", "parent", "path"]
		]
	],
	[
		1,
		[
			["package", "path"],
			["package", "parentKind", "path"]
		]
	],
	[22, [["package"], ["kind", "package"]]],
	[2, [["package"], ["package", "parentKind"]]],
	[1, [["package"], ["package", "start"]]]
]

/** The kept families (see chains.test.ts). */
export const keptFamilies: Arr.NonEmptyReadonlyArray<KeptFamily> = [
	{
		name: "a cycle of seven over one unit",
		requests: lettered(cycleOfSeven),
		fewest: 4
	},
	{
		name: "a cycle of five over two prefixes of a unit's key",
		requests: lettered(cycleOfFive),
		fewest: 3
	},
	{
		name: "edullm's Node",
		requests: Arr.flatMap(nodeChains, ([asked, sets]) =>
			Array.from({ length: asked }, (): SharingRequest => {
				const [first = [], ...rest] = sets
				return { sets: [new Set(first), ...Arr.map(rest, (s) => new Set(s))], order: undefined }
			})
		),
		fewest: 12
	}
]

/** The distinct requests of `requests`, by their sets and orders. */
export const distinctRequests = (requests: ReadonlyArray<SharingRequest>): number =>
	new Set(
		Arr.map(
			requests,
			(r) =>
				`${Arr.join(
					Arr.map(r.sets, (s) => Arr.join(Arr.sort([...s], Order.String), ",")),
					";"
				)}|${
					r.order === undefined
						? ""
						: Arr.join(
								Arr.map(r.order, (k) => `${k.key}:${k.dir}`),
								","
							)
				}`
		)
	).size

/** Whether every two requests of each group of `requests` may share an index. */
export const groupsShare = (
	requests: ReadonlyArray<SharingRequest>,
	groups: ReadonlyArray<ReadonlyArray<number>>
): boolean => {
	const comparableSets = (x: ReadonlySet<string>, y: ReadonlySet<string>): boolean =>
		Arr.every([...x], (m) => y.has(m)) || Arr.every([...y], (m) => x.has(m))
	const agree = (a: ReadonlyArray<OrderKey>, b: ReadonlyArray<OrderKey>): boolean => {
		const along = Arr.flatMap(a, (k) =>
			Arr.flatMap(b, (l) => (l.key === k.key ? [l.dir === k.dir] : []))
		)
		return Arr.every(along, (same) => same) || Arr.every(along, (same) => !same)
	}
	return Arr.every(groups, (group) =>
		Arr.every(group, (a) =>
			Arr.every(group, (b) => {
				const r = requests[a]
				const s = requests[b]
				return (
					r !== undefined &&
					s !== undefined &&
					Arr.every(r.sets, (x) => Arr.every(s.sets, (y) => comparableSets(x, y))) &&
					(r.order === undefined || s.order === undefined || agree(r.order, s.order))
				)
			})
		)
	)
}

/**
 * `requests` grown `times` over: each request, then each set of it alone, which rides it, repeated as a block `times`
 * times, so every size holds the same distinct requests, the first block's the first of each.
 */
const grown = (requests: ReadonlyArray<Drawn>, times: number): ReadonlyArray<Drawn> => {
	const block = Arr.flatMap(requests, (r): ReadonlyArray<Drawn> => [
		r,
		...Arr.map(r.sets, (set): Drawn => ({ sets: [set], order: undefined }))
	])
	return Arr.flatten(Array.from({ length: times }, () => block))
}

/** The steps the cover of `family` grown `times` over takes. */
export const grownSteps = (family: Requests, times: number): number =>
	fewestSharingGroups(
		Arr.map(grown(family.requests, times), (r) => sharingRequestOf(r, family.columns))
	).steps
