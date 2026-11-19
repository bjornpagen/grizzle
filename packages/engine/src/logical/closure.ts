import { appendAll } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Dependency, type Implication, implication } from "#compiler/ir/keys.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import {
	type Attributes,
	addTo,
	type Bits,
	bitsAt,
	copyBits,
	dropFrom,
	emptyLike,
	holdsAt,
	holdsName,
	lowest,
	intersect,
	minus,
	nameAt,
	namesOf,
	positions,
	sizeOf,
	union,
	subsetOf
} from "#compiler/logical/attributes.ts"

/**
 * Closure over a node's stated dependencies, and the minimal-key search, over the node's attributes interned
 * (logical/attributes.ts): a set of attributes is a bitset, so a step's test that its determinants are reached is a
 * word-wise subset and its firing an OR.
 *
 * A closure is what a start determines under the dependencies, each column with the dependency that first reached it:
 * the steps that name the value they fix a column to fire first, in table order until none adds a column, then every
 * step, in table order until none adds a column. So a column fixed both by a step that names its value and by one that
 * does not is reached by the first, and the value it holds is read off its derivation. Its derivation of some targets is
 * the dependencies that reached them, transitively, in the order they first fired, which is an order in which each
 * one's determinants are known: an Implication (ir/keys.ts).
 *
 * Each round is at most one pass more than the columns it adds, since a pass that adds none ends it, so a closure
 * visits each of the node's dependencies at most once for each attribute it adds and twice more: its work is bounded by
 * its dependencies times its attributes, each visit a few words (test/unit/analysis/logical/closure-cost.test.ts).
 *
 * The minimal keys are found by Lucchesi and Osborn's exchange: every minimal key follows from any other by exchanging
 * the columns a dependency determines for its determinants and minimizing, so the keys the seeds minimize to, closed
 * under the exchange over every stated dependency, are every minimal key the dependencies prove. The search has no bound:
 * its work grows with the keys it finds, and no key is dropped.
 */

/** A dependency a node states, interned: its determinants as a set, and its targets that are attributes, in its order. */
export interface Row {
	readonly dependency: Dependency
	readonly from: Bits
	readonly to: ReadonlyArray<number>
}

/** A node's dependencies as its closures read them: over its attributes interned, each a row, in table order. */
export interface Rows {
	readonly node: NodeId
	readonly attributes: Attributes
	readonly rows: ReadonlyArray<Row>
}

/**
 * A node's dependencies interned over its attributes: each one's determinants, every one an attribute of the node, as
 * every builder of a node's dependencies states them (logical/props.ts), and its targets among the attributes.
 */
export const rowsOf = (
	node: NodeId,
	attributes: Attributes,
	dependencies: ReadonlyArray<Dependency>
): Rows => ({
	node,
	attributes,
	rows: dependencies.map((dependency) => ({
		dependency,
		from: bitsAt(
			attributes,
			dependency.from.map((c) =>
				defined(attributes.at.get(c), "a dependency's determinant is an attribute of its node")
			)
		),
		to: dependency.to.flatMap((c) => {
			const p = attributes.at.get(c)
			return p === undefined ? [] : [p]
		})
	}))
})

/** The rows of a node's dependencies `kept` holds, in table order: a closure over some of its dependencies. */
export const rowsAmong = (rows: Rows, kept: ReadonlyArray<Row>): Rows => ({
	node: rows.node,
	attributes: rows.attributes,
	rows: kept
})

/**
 * What a start determines at a node, each position reached with how: the start's, ascending, then each step's targets in
 * the order its dependency states them, as the step fired; the row each step's targets were reached by; and the value
 * each column a step naming its value reached holds.
 */
export interface Closure<V> {
	readonly rows: Rows
	/** The start, which the closure keeps: the caller never changes it. */
	readonly start: Bits
	readonly reached: Bits
	/** The positions reached, in the order reached. */
	readonly sequence: ReadonlyArray<number>
	/** How each position was reached, by its row's index plus one: 0 by the start, or for a position not reached. */
	readonly by: Int32Array
	/** The indexes of the rows that reached a position, in the order they first did. */
	readonly fired: ReadonlyArray<number>
	readonly named: ReadonlyMap<number, V>
}

/**
 * What names the values a closure's steps fix its columns to: nothing, or `naming`, which names a step's column given the
 * values named before it, or leaves it unnamed.
 */
export type Naming<V> =
	| { readonly kind: "none" }
	| {
			readonly kind: "named"
			readonly naming: (
				dependency: Dependency,
				column: string,
				named: (column: string) => V | undefined
			) => V | undefined
	  }

/** A closure that names nothing: what each column is reached by, whatever value it holds. */
export const namesNothing: Naming<never> = Object.freeze({ kind: "none" })

/** Which steps a round of a closure lets reach a column: those its naming names the column by, or every step. */
type Admission<V> = Extract<Naming<V>, { readonly kind: "named" }> | { readonly kind: "every" }

const every: Admission<never> = Object.freeze({ kind: "every" })

/**
 * Every attribute `start` determines under `rows`: first by the steps `naming` gives a value, given the values the
 * closure named before them, then by every step. A closure that names nothing has the second round alone, since the
 * first would reach no column.
 *
 * Each round passes over the rows in table order until a pass adds no column, and a step fires at its turn in the pass
 * once its determinants are reached. A row's standing only advances: its determinants not all reached yet; asked when
 * the closure had named so many values, each target it did not reach then unnamed at those values; or every target
 * reached, so it adds nothing again. A pass visits again only what can still add a column: a row whose determinants were
 * not all reached, or whose targets a naming may now answer otherwise, since `naming` reads nothing but the values named
 * so far, and a target reached since only leaves it fewer to ask about. A visit it skips is one that would add nothing
 * and learn nothing, so the columns, each one's step and the order the steps fire in are the passes' own. A step's
 * targets are reached when its visit ends, each once, so a target it lists twice is asked about twice.
 */
export const closure = <V>(rows: Rows, start: Bits, naming: Naming<V>): Closure<V> => {
	const { attributes } = rows
	const table = rows.rows
	const reached = copyBits(start)
	const sequence = positions(start)
	const by = new Int32Array(attributes.names.length)
	const fired: Array<number> = []
	/** The values named so far, by position: none until a step names one. */
	let named: Map<number, V> | undefined
	/** Each row's marks: spent, every target it can reach reached, and fired, a target reached by it. */
	const marks = new Uint8Array(table.length)
	/** The namings the closure had when each row was last asked, plus one: 0 before it was asked. */
	const askedAt = new Int32Array(table.length)
	/** How many times the closure named a value: all a naming's answer can differ by. */
	let names = 0
	const valueOf = (column: string): V | undefined => {
		const p = attributes.at.get(column)
		return p === undefined ? undefined : named?.get(p)
	}
	const added: Array<number> = []
	/** A pass's visit of the row at `i`, adding the attributes it reaches; whether it added any. */
	const step = (row: Row, i: number, admission: Admission<V>): boolean => {
		if (
			(marks[i] ?? 0) & spentMark ||
			!subsetOf(row.from, reached) ||
			(admission.kind === "named" && askedAt[i] === names + 1)
		) {
			return false
		}
		const asked = names
		added.length = 0
		let unreached = 0
		for (const p of row.to) {
			if (holdsAt(reached, p)) {
				continue
			}
			unreached++
			if (admission.kind === "every") {
				added.push(p)
				continue
			}
			const value = admission.naming(row.dependency, nameAt(attributes, p), valueOf)
			if (value !== undefined) {
				named ??= new Map()
				named.set(p, value)
				names++
				added.push(p)
			}
		}
		if (added.length === unreached) {
			marks[i] = (marks[i] ?? 0) | spentMark
		} else {
			askedAt[i] = asked + 1
		}
		if (added.length === 0) {
			return false
		}
		if (((marks[i] ?? 0) & firedMark) === 0) {
			marks[i] = (marks[i] ?? 0) | firedMark
			fired.push(i)
		}
		for (const p of added) {
			if (holdsAt(reached, p)) {
				continue
			}
			addTo(reached, p)
			by[p] = i + 1
			sequence.push(p)
		}
		return true
	}
	const reach = (admission: Admission<V>): void => {
		for (let changed = true; changed;) {
			changed = false
			let i = 0
			for (const row of table) {
				if (step(row, i, admission)) {
					changed = true
				}
				i++
			}
		}
	}
	if (naming.kind === "named") {
		reach(naming)
	}
	reach(every)
	return { rows, start, reached, sequence, by, fired, named: named ?? namedNothing }
}

/** A row's mark that every target it can reach is reached, so it adds nothing again. */
const spentMark = 1

/** A row's mark that it reached a column, so it is among the closure's fired rows. */
const firedMark = 2

/** The values of a closure that named none. */
const namedNothing: ReadonlyMap<number, never> = new Map<number, never>()

/** Whether a closure holds every attribute of `targets`. */
export const covers = <V>(c: Closure<V>, targets: Bits): boolean => subsetOf(targets, c.reached)

/** Whether a closure holds the attribute named `column`: never a name its node lacks. */
export const reaches = <V>(c: Closure<V>, column: string): boolean =>
	holdsName(c.rows.attributes, c.reached, column)

/** The positions a closure reached past its start, in the order reached. */
export const stepsOf = <V>(c: Closure<V>): ReadonlyArray<number> =>
	c.sequence.filter((p) => !holdsAt(c.start, p))

/**
 * The rows that reached `targets` (positions of the closure's attributes), transitively, in the order they first fired:
 * a target the closure did not reach, or reached from the start, needs none.
 */
export const derivationRows = <V>(c: Closure<V>, targets: Iterable<number>): ReadonlyArray<Row> => {
	const table = c.rows.rows
	const used = new Uint8Array(table.length)
	const seen = emptyLike(c.reached)
	const stack = [...targets]
	for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
		if (holdsAt(seen, p)) {
			continue
		}
		addTo(seen, p)
		const how = c.by[p]
		if (how === undefined || how === 0) {
			continue
		}
		if (used[how - 1] === 1) {
			continue
		}
		used[how - 1] = 1
		appendAll(stack, positions(defined(table[how - 1], "a step's row is its closure's").from))
	}
	return c.fired.flatMap((i) =>
		used[i] === 1 ? [defined(table[i], "a fired row is its closure's")] : []
	)
}

/**
 * The derivation that the closure's start determines `targets`, positions of its attributes: the dependencies that
 * reached them, transitively, in the order they first fired. Every target is in the closure.
 */
export const derivation = <V>(c: Closure<V>, targets: Iterable<number>): Implication =>
	implication(
		c.rows.node,
		namesOf(c.rows.attributes, c.start),
		derivationRows(c, targets).map((row) => row.dependency)
	)

/**
 * The order of keys over attributes in heading order: the smaller first, then the one holding the first attribute that
 * only one of them holds, which is where the two, read in heading order, first differ.
 */
const keyOrder = (a: Bits, b: Bits): number => {
	const sizeA = sizeOf(a)
	const sizeB = sizeOf(b)
	if (sizeA !== sizeB) {
		return sizeA - sizeB
	}
	const first = lowest(union(minus(a, b), minus(b, a)))
	return first === undefined ? 0 : holdsAt(a, first) ? -1 : 1
}

/** The given columns that a heading has, each once, in heading order. */
export const inHeadingOrder = (columns: ReadonlyArray<string>, given: Iterable<string>): KeySet => {
	const set = new Set(given)
	return columns.filter((c) => set.has(c))
}

/**
 * The minimal keys `witness` proves among `columns`, each with the witness it gave for that key: each seed, its columns
 * among `columns`, minimized greedily from the end of the heading, closed under the exchange over `dependencies` (each
 * `from` for the columns `closureOf` gives it), as a sorted antichain. A superset of a key found is no new key. The
 * iteration reaches the keys the exchange appends to `found` as well.
 */
export const minimalKeys = <W>(
	columns: Bits,
	seeds: Iterable<Bits>,
	witness: (key: Bits) => W | undefined,
	dependencies: ReadonlyArray<{ readonly from: Bits; readonly to: Bits }>
): ReadonlyArray<{ readonly key: Bits; readonly witness: W }> => {
	const found: Array<{ readonly key: Bits; readonly witness: W }> = []
	const contains = (set: Bits) => found.some((k) => subsetOf(k.key, set))
	const add = (candidate: Bits): void => {
		const key = intersect(candidate, columns)
		const proved = contains(key) ? undefined : witness(key)
		if (proved === undefined) {
			return
		}
		let shrunk = { key, witness: proved }
		for (const p of positions(key).toReversed()) {
			const without = copyBits(shrunk.key)
			dropFrom(without, p)
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
			add(union(d.from, minus(key, d.to)))
		}
	}
	const antichain = found.filter(
		(k) => !found.some((o) => sizeOf(o.key) < sizeOf(k.key) && subsetOf(o.key, k.key))
	)
	return antichain.toSorted((a, b) => keyOrder(a.key, b.key))
}

/** A dependency of the factor search: its determinants, each once, and the positions it determines as it now stands. */
interface FactorRow {
	readonly from: ReadonlyArray<number>
	to: ReadonlyArray<number>
}

/** Each position's dependencies reading it. */
const readersOf = (
	rows: ReadonlyArray<FactorRow>
): ReadonlyMap<number, ReadonlyArray<FactorRow>> => {
	const readers = new Map<number, Array<FactorRow>>()
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
 * A closure that grows: what the positions added so far determine under `rows` but `skipped`. Each dependency fires once
 * its last determinant is known, so the closure of everything ever added is linear in the table's size.
 */
const growing = (
	like: Bits,
	rows: ReadonlyArray<FactorRow>,
	readers: ReadonlyMap<number, ReadonlyArray<FactorRow>>,
	skipped: FactorRow | undefined
): { readonly known: Bits; readonly add: (columns: Iterable<number>) => void } => {
	const known = emptyLike(like)
	const queue: Array<number> = []
	const missing = new Map<FactorRow, number>()
	const reach = (c: number): void => {
		if (!holdsAt(known, c)) {
			addTo(known, c)
			queue.push(c)
		}
	}
	const fire = (row: FactorRow): void => {
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
	like: Bits,
	dependencies: ReadonlyArray<{ readonly from: Bits; readonly to: ReadonlyArray<number> }>
): ReadonlyArray<FactorRow> => {
	const rows: ReadonlyArray<FactorRow> = dependencies.map((d) => ({
		from: positions(d.from),
		to: d.to
	}))
	const readers = readersOf(rows)
	for (const judged of rows.filter((row) => row.from.length > 1)) {
		const closed = growing(like, rows, readers, judged)
		closed.add(judged.from)
		judged.to = judged.to.filter((c) => !holdsAt(closed.known, c))
	}
	return rows.filter((row) => row.to.length > 0)
}

/** A strongly connected set of positions, and the sets it leans on: each with a position a dependency reaching it reads. */
interface Part {
	readonly columns: NonEmptyReadonlyArray<number>
	readonly leansOn: Set<Part>
}

/**
 * The strongly connected sets of `columns` under `next` (Tarjan), ordered so that each set comes after every set that
 * reaches it, and otherwise in the order of its first position: each position's set in turn, after the sets it leans on
 * that have not come yet.
 */
const stronglyConnected = (
	columns: ReadonlyArray<number>,
	next: (column: number) => ReadonlyArray<number>
): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
	const index = new Map<number, number>()
	const stack: Array<number> = []
	const onStack = new Set<number>()
	const partOf = new Map<number, Part>()
	const visit = (c: number): number => {
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
			const set: Array<number> = []
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
	const out: Array<NonEmptyReadonlyArray<number>> = []
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
 * The factors of a table's minimal keys among `columns`: the attributes that can stand in a minimal key, in parts no
 * key's choice in one constrains in another, each in an order where a part's keys may lean only on the parts before it.
 * Every minimal key of the table is one minimal key of each factor, given the attributes of the factors before it,
 * together, and every such choice is one (a product), so the factors state 2^k keys in 2k when each of k factors has
 * two.
 *
 * The parts are the strongly connected sets of the attributes under what the dependencies reading them determine, read
 * off the dependencies irredundant (above), each after all that determine it and otherwise in the order of its first
 * attribute. A dependency determining an attribute of a set reads only it and the sets before it, so a key holds a key
 * of each set given the sets before it, which every key determines, and each set's keys are found apart: the product. A
 * dependency's targets the others reach from its determinants join nothing, so a key of k independent factors that a
 * parent closes over, or a view states beside its factors' alternatives, leaves them k factors; a set the ones before
 * it determine whole is in no minimal key and is no factor: an attribute a key determines, a cycle of attributes another
 * factor's key determines, an attribute two factors each determine. Each factor is a set of attributes.
 *
 * Linear in the table's size after the irredundant dependencies.
 */
export const independentFactors = (
	columns: Bits,
	stated: ReadonlyArray<{ readonly from: Bits; readonly to: ReadonlyArray<number> }>
): ReadonlyArray<Bits> => {
	const rows = irredundant(columns, stated)
	const readers = readersOf(rows)
	const before = growing(columns, rows, readers, undefined)
	const factors: Array<Bits> = []
	/** What the dependencies reading each position determine among `columns`, read once a position. */
	const nexts = new Map<number, ReadonlyArray<number>>()
	const next = (c: number): ReadonlyArray<number> => {
		const read = nexts.get(c)
		if (read !== undefined) {
			return read
		}
		const out = (readers.get(c) ?? []).flatMap((row) => row.to.filter((t) => holdsAt(columns, t)))
		nexts.set(c, out)
		return out
	}
	for (const set of stronglyConnected(positions(columns), next)) {
		if (isNonEmpty(set) && !set.every((c) => holdsAt(before.known, c))) {
			const factor = emptyLike(columns)
			for (const c of set) {
				addTo(factor, c)
			}
			factors.push(factor)
		}
		before.add(set)
	}
	return factors
}
