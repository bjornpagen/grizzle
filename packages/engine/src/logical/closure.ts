import { appendAll } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
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
