import { appendAll } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Dependency, type Implication, implication } from "#compiler/ir/keys.ts"
import type { KeySet } from "#compiler/ir/rel.ts"

/**
 * Closure over a node's stated dependencies, and the minimal-key search.
 *
 * A closure is what a start determines under the dependencies, each column with the dependency that first reached it:
 * the steps that name the value they fix a column to fire first, in table order until none adds a column, then every
 * step, in table order until none adds a column. So a column fixed both by a step that names its value and by one that
 * does not is reached by the first, and the value it holds is read off its derivation. Its derivation of some targets is
 * the dependencies that reached them, transitively, in the order they first fired, which is an order in which each
 * one's determinants are known: an Implication (ir/keys.ts).
 *
 * The minimal keys are found by Lucchesi and Osborn's exchange: every minimal key follows from any other by exchanging
 * the columns a dependency determines for its determinants and minimizing, so the keys the seeds minimize to, closed
 * under the exchange over every stated dependency, are every minimal key the dependencies prove. The search has no bound:
 * its work grows with the keys it finds, and no key is dropped.
 */

/** How a column of a closure was reached: from the start, or by a dependency, the one at `index`, as the `order`th to fire. */
type Reached =
	| { readonly kind: "start" }
	| {
			readonly kind: "step"
			readonly index: number
			readonly order: number
			readonly dependency: Dependency
	  }

const fromStart: Reached = Object.freeze({ kind: "start" })

/**
 * What a start determines at a node, each column with how it was reached, and the value each column a step naming its
 * value reached holds.
 */
export interface Closure<V> {
	readonly node: NodeId
	readonly start: KeySet
	readonly columns: ReadonlyMap<string, Reached>
	readonly dependencies: ReadonlyArray<Dependency>
	readonly named: ReadonlyMap<string, V>
}

/**
 * Every column `start` determines under `dependencies`, over the node's columns `heading`: first by the steps `naming`
 * gives a value, given the values the closure named before them, then by every step.
 */
export const closure = <V>(
	node: NodeId,
	heading: ReadonlySet<string>,
	dependencies: ReadonlyArray<Dependency>,
	start: Iterable<string>,
	naming: (dependency: Dependency, column: string, named: ReadonlyMap<string, V>) => V | undefined
): Closure<V> => {
	const columns = new Map<string, Reached>()
	const given: Array<string> = []
	for (const c of start) {
		if (heading.has(c) && !columns.has(c)) {
			columns.set(c, fromStart)
			given.push(c)
		}
	}
	const named = new Map<string, V>()
	/** Each dependency that reached a column, by its index, with its place among them: when it first did. */
	const orders = new Map<number, number>()
	const reach = (admitted: (d: Dependency, column: string) => boolean): void => {
		for (let changed = true; changed;) {
			changed = false
			for (const [index, d] of dependencies.entries()) {
				if (!d.from.every((c) => columns.has(c))) {
					continue
				}
				const added = d.to.filter((c) => heading.has(c) && !columns.has(c) && admitted(d, c))
				if (added.length === 0) {
					continue
				}
				const order = orders.get(index) ?? orders.size
				orders.set(index, order)
				for (const c of added) {
					columns.set(c, { kind: "step", index, order, dependency: d })
				}
				changed = true
			}
		}
	}
	reach((d, column) => {
		const value = naming(d, column, named)
		if (value !== undefined) {
			named.set(column, value)
		}
		return value !== undefined
	})
	reach(() => true)
	return { node, start: given, columns, dependencies, named }
}

/** Whether a closure holds every column of `targets`. */
export const covers = <V>(c: Closure<V>, targets: Iterable<string>): boolean => {
	for (const t of targets) {
		if (!c.columns.has(t)) {
			return false
		}
	}
	return true
}

/**
 * The derivation that the closure's start determines `targets`: the dependencies that reached them, transitively, in
 * the order they first fired. Every target is in the closure.
 */
export const derivation = <V>(c: Closure<V>, targets: Iterable<string>): Implication => {
	const used = new Map<number, Extract<Reached, { readonly kind: "step" }>>()
	const seen = new Set<string>()
	const stack = [...targets]
	for (let column = stack.pop(); column !== undefined; column = stack.pop()) {
		if (seen.has(column)) {
			continue
		}
		seen.add(column)
		const how = c.columns.get(column)
		if (how === undefined || how.kind === "start") {
			continue
		}
		if (used.has(how.index)) {
			continue
		}
		used.set(how.index, how)
		appendAll(stack, how.dependency.from)
	}
	const steps = [...used.values()]
		.toSorted((a, b) => a.order - b.order)
		.map((step) => step.dependency)
	return implication(c.node, c.start, steps)
}

/**
 * The order of keys of a heading whose columns are in heading order: the shorter first, then the one holding the first
 * heading column that only one of them holds, which is where the two, read in heading order, first differ.
 */
const keyOrder =
	(columns: ReadonlyArray<string>): ((a: KeySet, b: KeySet) => number) =>
	(a, b) => {
		if (a.length !== b.length) {
			return a.length - b.length
		}
		const inA = new Set(a)
		const inB = new Set(b)
		for (const c of columns) {
			const held = inA.has(c)
			if (held !== inB.has(c)) {
				return held ? -1 : 1
			}
		}
		return 0
	}

/** The given columns that a heading has, each once, in heading order. */
export const inHeadingOrder = (columns: ReadonlyArray<string>, given: Iterable<string>): KeySet => {
	const set = new Set(given)
	return columns.filter((c) => set.has(c))
}

/**
 * The minimal keys `witness` proves, each with the witness it gave for that key: each seed minimized greedily from the
 * end of the heading, closed under the exchange over `dependencies` (each `from` for the columns `closureOf` gives it),
 * as a sorted antichain with its columns in heading order. A superset of a key found is no new key. The iteration
 * reaches the keys the exchange appends to `found` as well.
 */
export const minimalKeys = <W>(
	columns: ReadonlyArray<string>,
	seeds: Iterable<ReadonlyArray<string>>,
	witness: (columns: ReadonlyArray<string>) => W | undefined,
	dependencies: ReadonlyArray<{ readonly from: KeySet; readonly to: ReadonlySet<string> }>
): ReadonlyArray<{ readonly key: KeySet; readonly witness: W }> => {
	const found: Array<{ readonly key: KeySet; readonly witness: W }> = []
	const contains = (set: ReadonlyArray<string>) =>
		found.some((k) => k.key.every((c) => set.includes(c)))
	const add = (candidate: ReadonlyArray<string>): void => {
		const key = inHeadingOrder(columns, candidate)
		const proved = contains(key) ? undefined : witness(key)
		if (proved === undefined) {
			return
		}
		let shrunk = { key, witness: proved }
		for (let i = key.length - 1; i >= 0; i--) {
			const without = shrunk.key.toSpliced(i, 1)
			const w = witness(without)
			if (w !== undefined) {
				shrunk = { key: without, witness: w }
			}
		}
		if (!contains(shrunk.key)) {
			found.push(shrunk)
		}
	}
	for (const seed of seeds) {
		add(seed)
	}
	for (const { key } of found) {
		for (const d of dependencies) {
			add([...d.from, ...key.filter((c) => !d.to.has(c))])
		}
	}
	const antichain = found.filter(
		(k) => !found.some((o) => o.key.length < k.key.length && o.key.every((c) => k.key.includes(c)))
	)
	const order = keyOrder(columns)
	return antichain.toSorted((a, b) => order(a.key, b.key))
}

/**
 * The independent factors of a table's minimal keys: the columns that can stand in a minimal key, partitioned so that
 * no dependency joins two parts, each part with the dependencies within it. Every minimal key of the table is one
 * minimal key of each factor together, and every such choice is one (a product), so the factors state 2^k keys in 2k
 * when each of k factors has two.
 *
 * The columns that can stand in a minimal key are found by pruning: a column some dependency determines and no
 * dependency still standing reads is never in a minimal key, since a key holding it determines it from its other
 * columns, its value reaching nothing a later step needs; a dependency whose every determined column was pruned stands
 * no longer, and the columns it read are judged again, until none is pruned. What remains splits into the connected
 * parts of the standing dependencies, each joining its determinants with the columns it determines among them; a
 * column no dependency touches is a factor alone, in every key. A start determines the heading exactly when it holds a
 * key of every factor, under that factor's dependencies alone, since the pruned columns follow from the factors in the
 * reverse of the order they were pruned in.
 *
 * Linear in the table's size: each dependency is retired once, each column pruned once.
 */
export const independentFactors = (
	columns: ReadonlyArray<string>,
	dependencies: ReadonlyArray<{ readonly from: KeySet; readonly to: KeySet }>
): {
	readonly factors: ReadonlyArray<NonEmptyReadonlyArray<string>>
	readonly factorOf: ReadonlyMap<string, number>
} => {
	/** Each dependency with its determined columns not yet pruned: zero once it stands no longer. */
	const states = dependencies.map((d) => ({ d, standing: d.to.length }))
	/** Each column's standing dependencies reading it, and the dependencies determining it. */
	const readers = new Map<string, number>()
	const determiners = new Map<string, Array<(typeof states)[number]>>()
	for (const state of states) {
		const d = state.d
		if (d.to.length === 0) {
			continue
		}
		for (const c of d.from) {
			readers.set(c, (readers.get(c) ?? 0) + 1)
		}
		for (const c of d.to) {
			const by = determiners.get(c)
			if (by === undefined) {
				determiners.set(c, [state])
			} else {
				by.push(state)
			}
		}
	}
	const pruned = new Set<string>()
	const queue = columns.filter((c) => determiners.has(c) && !readers.has(c))
	for (let c = queue.pop(); c !== undefined; c = queue.pop()) {
		if (pruned.has(c)) {
			continue
		}
		pruned.add(c)
		for (const state of determiners.get(c) ?? []) {
			state.standing -= 1
			if (state.standing > 0) {
				continue
			}
			for (const r of state.d.from) {
				const reading = (readers.get(r) ?? 0) - 1
				readers.set(r, reading)
				if (reading === 0 && determiners.has(r)) {
					queue.push(r)
				}
			}
		}
	}
	/** Union-find over the columns that remain, by the standing dependencies. */
	const parent = new Map<string, string>()
	const find = (c: string): string => {
		const path: Array<string> = []
		let at = c
		for (let up = parent.get(at); up !== undefined; up = parent.get(at)) {
			path.push(at)
			at = up
		}
		for (const below of path) {
			parent.set(below, at)
		}
		return at
	}
	for (const { d, standing } of states) {
		if (standing === 0) {
			continue
		}
		const [first, ...rest] = [...d.from, ...d.to.filter((c) => !pruned.has(c))]
		if (first === undefined) {
			continue
		}
		for (const c of rest) {
			const a = find(first)
			const b = find(c)
			if (a !== b) {
				parent.set(b, a)
			}
		}
	}
	const factors: Array<[string, ...Array<string>]> = []
	const factorOf = new Map<string, number>()
	/** Each root's factor, with its index among the factors. */
	const byRoot = new Map<
		string,
		{ readonly at: number; readonly factor: [string, ...Array<string>] }
	>()
	for (const c of columns) {
		if (pruned.has(c)) {
			continue
		}
		const root = find(c)
		const known = byRoot.get(root)
		if (known === undefined) {
			const factor: [string, ...Array<string>] = [c]
			byRoot.set(root, { at: factors.length, factor })
			factorOf.set(c, factors.length)
			factors.push(factor)
		} else {
			factorOf.set(c, known.at)
			known.factor.push(c)
		}
	}
	return { factors, factorOf }
}
