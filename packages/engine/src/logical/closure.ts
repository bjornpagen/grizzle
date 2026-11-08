import { appendAll } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
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

/** A dependency of the factor search: its determinants, each once, and the columns it determines as it now stands. */
interface Row {
	readonly from: ReadonlyArray<string>
	to: ReadonlyArray<string>
}

/** Each column's dependencies reading it. */
const readersOf = (rows: ReadonlyArray<Row>): ReadonlyMap<string, ReadonlyArray<Row>> => {
	const readers = new Map<string, Array<Row>>()
	for (const row of rows) {
		for (const c of row.from) {
			const reading = readers.get(c)
			if (reading === undefined) {
				readers.set(c, [row])
			} else {
				reading.push(row)
			}
		}
	}
	return readers
}

/**
 * A closure that grows: what the columns added so far determine under `rows` but `skipped`. Each dependency fires once
 * its last determinant is known, so the closure of everything ever added is linear in the table's size.
 */
const growing = (
	rows: ReadonlyArray<Row>,
	readers: ReadonlyMap<string, ReadonlyArray<Row>>,
	skipped: Row | undefined
): { readonly known: ReadonlySet<string>; readonly add: (columns: Iterable<string>) => void } => {
	const known = new Set<string>()
	const queue: Array<string> = []
	const missing = new Map<Row, number>()
	const reach = (c: string): void => {
		if (!known.has(c)) {
			known.add(c)
			queue.push(c)
		}
	}
	const fire = (row: Row): void => {
		if (row !== skipped) {
			row.to.forEach(reach)
		}
	}
	const drain = (): void => {
		for (let c = queue.pop(); c !== undefined; c = queue.pop()) {
			for (const row of readers.get(c) ?? []) {
				const left = (missing.get(row) ?? row.from.length) - 1
				missing.set(row, left)
				if (left === 0) {
					fire(row)
				}
			}
		}
	}
	for (const row of rows) {
		if (row.from.length === 0) {
			fire(row)
		}
	}
	drain()
	return {
		known,
		add: (columns) => {
			for (const c of columns) {
				reach(c)
			}
			drain()
		}
	}
}

/**
 * The dependencies with each one of several determinants stating only what the others do not reach from them, in
 * table order, each judged against the ones before it as they now stand and the ones after it as stated: the same
 * closure of every start. A dependency a parent closes over a key of its input's independent factors, or a view's key
 * beside its alternatives, determines what each factor's own dependencies already reach, and states none of it here.
 * A dependency of one determinant joins nothing its targets do not: what it reaches through the others, it reaches
 * through dependencies its determinant stands in.
 *
 * One closure per dependency of several determinants.
 */
const irredundant = (
	dependencies: ReadonlyArray<{ readonly from: KeySet; readonly to: KeySet }>
): ReadonlyArray<Row> => {
	const rows: ReadonlyArray<Row> = dependencies.map((d) => ({
		from: [...new Set(d.from)],
		to: d.to
	}))
	const readers = readersOf(rows)
	for (const judged of rows.filter((row) => row.from.length > 1)) {
		const closed = growing(rows, readers, judged)
		closed.add(judged.from)
		judged.to = judged.to.filter((c) => !closed.known.has(c))
	}
	return rows.filter((row) => row.to.length > 0)
}

/** A strongly connected set of columns, and the sets it leans on: each with a column a dependency reaching it reads. */
interface Part {
	readonly columns: NonEmptyReadonlyArray<string>
	readonly leansOn: Set<Part>
}

/**
 * The strongly connected sets of `columns` under `next` (Tarjan), ordered so that each set comes after every set that
 * reaches it, and otherwise in the order of its first column: each column's set in turn, after the sets it leans on
 * that have not come yet.
 */
const stronglyConnected = (
	columns: ReadonlyArray<string>,
	next: (column: string) => ReadonlyArray<string>
): ReadonlyArray<NonEmptyReadonlyArray<string>> => {
	const index = new Map<string, number>()
	const stack: Array<string> = []
	const onStack = new Set<string>()
	const partOf = new Map<string, Part>()
	const visit = (c: string): number => {
		const at = index.size
		index.set(c, at)
		let least = at
		stack.push(c)
		onStack.add(c)
		for (const d of next(c)) {
			const seen = index.get(d)
			if (seen === undefined) {
				least = Math.min(least, visit(d))
			} else if (onStack.has(d)) {
				least = Math.min(least, seen)
			}
		}
		if (least === at) {
			const set: Array<string> = []
			for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
				onStack.delete(top)
				set.push(top)
				if (top === c) {
					break
				}
			}
			const part: Part = { columns: [c, ...set.filter((m) => m !== c)], leansOn: new Set() }
			for (const m of part.columns) {
				partOf.set(m, part)
			}
		}
		return least
	}
	for (const c of columns) {
		if (!index.has(c)) {
			visit(c)
		}
	}
	for (const [c, part] of partOf) {
		for (const d of next(c)) {
			const reached = partOf.get(d)
			if (reached !== undefined && reached !== part) {
				reached.leansOn.add(part)
			}
		}
	}
	const out: Array<NonEmptyReadonlyArray<string>> = []
	const placed = new Set<Part>()
	const place = (part: Part): void => {
		if (placed.has(part)) {
			return
		}
		placed.add(part)
		part.leansOn.forEach(place)
		out.push(part.columns)
	}
	for (const c of columns) {
		const part = partOf.get(c)
		if (part !== undefined) {
			place(part)
		}
	}
	return out
}

/**
 * The factors of a table's minimal keys: the columns that can stand in a minimal key, in parts no key's choice in one
 * constrains in another, each in an order where a part's keys may lean only on the parts before it. Every minimal key
 * of the table is one minimal key of each factor, given the columns of the factors before it, together, and every such
 * choice is one (a product), so the factors state 2^k keys in 2k when each of k factors has two.
 *
 * The parts are the strongly connected sets of the columns under what the dependencies reading them determine, read off
 * the dependencies irredundant (above), each after all that determine it and otherwise in the order of its first
 * column. A dependency determining a column of a set reads only it and the sets before it, so a key holds a key of each
 * set given the sets before it, which every key determines, and each set's keys are found apart: the product. A
 * dependency's targets the others reach from its determinants join nothing, so a key of k independent factors that a
 * parent closes over, or a view states beside its factors' alternatives, leaves them k factors; a set the ones before
 * it determine whole is in no minimal key and is no factor: a column a key determines, a cycle of columns another
 * factor's key determines, a column two factors each determine. Each factor's columns are in table order.
 *
 * Linear in the table's size after the irredundant dependencies.
 */
export const independentFactors = (
	columns: ReadonlyArray<string>,
	stated: ReadonlyArray<{ readonly from: KeySet; readonly to: KeySet }>
): {
	readonly factors: ReadonlyArray<NonEmptyReadonlyArray<string>>
	readonly factorOf: ReadonlyMap<string, number>
} => {
	const rows = irredundant(stated)
	const readers = readersOf(rows)
	const inTable = new Set(columns)
	const before = growing(rows, readers, undefined)
	const factors: Array<NonEmptyReadonlyArray<string>> = []
	const factorOf = new Map<string, number>()
	const next = (c: string): ReadonlyArray<string> =>
		(readers.get(c) ?? []).flatMap((row) => row.to.filter((t) => inTable.has(t)))
	for (const set of stronglyConnected(columns, next)) {
		const members = new Set(set)
		const ordered = columns.filter((c) => members.has(c))
		if (isNonEmpty(ordered) && !set.every((c) => before.known.has(c))) {
			for (const c of ordered) {
				factorOf.set(c, factors.length)
			}
			factors.push(ordered)
		}
		before.add(set)
	}
	return { factors, factorOf }
}
