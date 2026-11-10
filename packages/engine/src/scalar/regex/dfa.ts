import { indices } from "#compiler/core/array.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import { type TextBounds, textBounds } from "#compiler/ir/scalar.ts"
import {
	type CharSet,
	charSet,
	domain,
	maxUtf8Width,
	size,
	utf8Width
} from "#compiler/scalar/regex/charset.ts"
import { closure, type Nfa } from "#compiler/scalar/regex/match.ts"
import { type CharPartition, partitionOf } from "#compiler/scalar/regex/partition.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

export interface DfaLimits {
	/** The most DFA states the subset construction may create. */
	readonly maxStates: number
	/**
	 * The most NFA-state visits the subset construction may be charged: the initial closure's states, then for every
	 * transition its source subset's states and its target's.
	 */
	readonly maxWork: number
}

/** What a subset construction spent: the DFA states it created and the NFA-state visits it was charged. */
export interface DfaSpent {
	readonly states: number
	readonly work: number
}

/** A subset construction stopped where it would have passed `limit`, with what it spent up to there. */
export interface DfaBounded {
	readonly kind: "bounded"
	readonly limit: keyof DfaLimits
	readonly spent: DfaSpent
}

/** What the bounded construction of a pattern's minimal DFA came to: the minimal DFA, or the limit it stopped at. */
export type DfaOutcome =
	| { readonly kind: "minimal"; readonly dfa: CanonicalDfa; readonly spent: DfaSpent }
	| DfaBounded

/**
 * A minimal DFA in canonical form: states numbered breadth-first from 0, the initial state; each state's edges sorted
 * by their smallest code point, one edge per target with the union of its code points. The dead state and every edge
 * into it are omitted, so a missing code point means rejection.
 */
export interface CanonicalDfa {
	readonly states: ReadonlyArray<{
		readonly accept: boolean
		readonly edges: ReadonlyArray<{ readonly set: CharSet; readonly to: number }>
	}>
}

/** A set's bounds in order, each interval's low then high: equal exactly for two sets of the same intervals. */
const setBounds = (set: CharSet): ReadonlyArray<number> => set.flatMap(([lo, hi]) => [lo, hi])

/** A set edge of an NFA state: the position of its set among the distinct sets, and its target. */
interface SetEdge {
	readonly set: number
	readonly to: number
}

/** The element of `xs` at `i`, which the caller's bounds make present (scalar/regex/table.ts entry). */
const at = (xs: ArrayLike<number>, i: number): number => entry(xs, i)

/**
 * The alphabet of a subset construction. Its segments are the maximal intervals of the admitted domain that no NFA
 * set's boundary cuts, in code point order; its atoms are the classes of segments every NFA set holds alike, numbered
 * in the order their first segments come, so an atom's least code point grows with its number. Each distinct set of
 * the NFA's edges holds whole atoms, which `setAtoms` lists, and `setEdges` holds each state's set edges.
 */
interface Alphabet extends CharPartition {
	readonly setEdges: ReadonlyArray<ReadonlyArray<SetEdge>>
}

/**
 * The alphabet of an NFA: its distinct sets in first-seen order and the partition they cut the domain into
 * (partition.ts partitionOf).
 */
const alphabetOf = (nfa: Nfa): Alphabet => {
	const sets: Array<CharSet> = []
	/** Each distinct set's position, by its bounds (setBounds). */
	const positions = new TupleMap<ReadonlyArray<number>, number>()
	const positionOf = (set: CharSet): number => {
		const bounds = setBounds(set)
		const known = positions.get(bounds)
		if (known !== undefined) {
			return known
		}
		positions.set(bounds, sets.length)
		sets.push(set)
		return sets.length - 1
	}
	const setEdges = nfa.edges.map((edges) =>
		edges.flatMap((e): ReadonlyArray<SetEdge> =>
			e.kind === "set" ? [{ set: positionOf(e.set), to: e.to }] : []
		)
	)
	return { ...partitionOf(sets, domain), setEdges }
}

/**
 * A state of the subset construction: the search's accepting sink, which every later input keeps once a match was
 * found, or a set of NFA states with whether it is the initial one, whose closure at the end of the text reads the start
 * context.
 */
type Subset =
	| { readonly kind: "done" }
	| { readonly kind: "set"; readonly states: ReadonlyArray<number>; readonly initial: boolean }

const done: Subset = { kind: "done" }

/** The key a subset is interned under. */
const subsetKey = (subset: Subset): string =>
	subset.kind === "done"
		? "done"
		: `${subset.initial ? "i" : "n"}${[...subset.states].toSorted((a, b) => a - b).join(",")}`

interface RawDfa {
	/** Transition table: target per atom; one row per state, the initial one first. */
	readonly next: ReadonlyArray<ReadonlyArray<number>>
	readonly accept: ReadonlyArray<boolean>
	readonly alphabet: CharPartition
}

/** What the subset construction came to: the raw DFA, or the limit it stopped at. */
type Construction =
	| { readonly kind: "built"; readonly dfa: RawDfa; readonly spent: DfaSpent }
	| DfaBounded

/**
 * The subset construction with search semantics folded in, within the limits. Every transition counts as work its
 * subset's states and the states it reaches. A subset's set edges are dealt to the atoms of their sets once, and an
 * atom none of them holds reaches the restart closure, computed once, so a transition costs about the work it counts.
 */
const determinize = (nfa: Nfa, limits: DfaLimits): Construction => {
	const alphabet = alphabetOf(nfa)
	const { atomCount, setAtoms, setEdges } = alphabet
	const mark = new Int32Array(nfa.edges.length).fill(-1)
	let stamp = 0
	let work = 0

	const keys = new Map<string, number>()
	const members: Array<Subset> = []
	const next: Array<Array<number>> = []
	/** Each interned state not yet expanded: its number, its subset and its transition row, which expansion fills. */
	const queue: Array<{
		readonly id: number
		readonly subset: Subset
		readonly row: Array<number>
	}> = []

	const intern = (subset: Subset): number | undefined => {
		const key = subsetKey(subset)
		const known = keys.get(key)
		if (known !== undefined) {
			return known
		}
		if (members.length >= limits.maxStates) {
			return undefined
		}
		const id = members.length
		const row: Array<number> = []
		keys.set(key, id)
		members.push(subset)
		next.push(row)
		queue.push({ id, subset, row })
		return id
	}

	/** The subset `states` reach: the sink once they hold the NFA's accepting state. */
	const settle = (states: ReadonlyArray<number>, initial: boolean): Subset =>
		states.includes(nfa.accept) ? done : { kind: "set", states, initial }

	const bounded = (limit: keyof DfaLimits): DfaBounded => ({
		kind: "bounded",
		limit,
		spent: { states: members.length, work }
	})

	const initialStates = closure(nfa, [nfa.start], { atStart: true, atEnd: false }, mark, stamp++)
	work += initialStates.length
	if (intern(settle(initialStates, true)) === undefined) {
		return bounded("maxStates")
	}
	/** The states past the first code point that the start state alone reaches, where an unanchored search restarts. */
	const restart = closure(nfa, [nfa.start], { atStart: false, atEnd: false }, mark, stamp++)
	/** The restart subset's state, once a transition has interned it. */
	let restartId: number | undefined
	const restartTarget = (): number | undefined => {
		restartId ??= intern(settle(restart, false))
		return restartId
	}
	/** The targets of the expanded subset's set edges that hold each atom, and the atoms some edge holds. */
	const moved: ReadonlyArray<Array<number>> = Array.from(
		{ length: atomCount },
		(): Array<number> => []
	)
	const touched: Array<number> = []
	for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
		const { id, subset, row } = item
		if (subset.kind === "done") {
			for (let a = 0; a < atomCount; a++) {
				row.push(id)
			}
			continue
		}
		for (const s of subset.states) {
			for (const edge of entry(setEdges, s)) {
				for (const a of entry(setAtoms, edge.set)) {
					const targets = entry(moved, a)
					if (targets.length === 0) {
						touched.push(a)
					}
					targets.push(edge.to)
				}
			}
		}
		for (let a = 0; a < atomCount; a++) {
			const targets = entry(moved, a)
			const reached =
				targets.length === 0
					? restart
					: closure(nfa, [nfa.start, ...targets], { atStart: false, atEnd: false }, mark, stamp++)
			work += subset.states.length + reached.length
			if (work > limits.maxWork) {
				return bounded("maxWork")
			}
			const target = targets.length === 0 ? restartTarget() : intern(settle(reached, false))
			if (target === undefined) {
				return bounded("maxStates")
			}
			row.push(target)
		}
		for (const a of touched) {
			entry(moved, a).length = 0
		}
		touched.length = 0
	}
	const accept = members.map((subset) => {
		if (subset.kind === "done") {
			return true
		}
		const atEnd = closure(
			nfa,
			subset.states,
			{ atStart: subset.initial, atEnd: true },
			mark,
			stamp++
		)
		return atEnd.includes(nfa.accept)
	})
	return { kind: "built", dfa: { next, accept, alphabet }, spent: { states: members.length, work } }
}

/**
 * A partition of a DFA's states into blocks, refined by Hopcroft's algorithm: each block is a contiguous range of
 * `order`, and a split moves the states that enter the splitter to the front of their block, then cuts it there,
 * enqueueing the smaller part (the new part when the block itself still waits).
 */
class Partition {
	readonly #order: Int32Array
	readonly #position: Int32Array
	readonly #blockOf: Int32Array
	readonly #start: Array<number> = []
	readonly #end: Array<number> = []
	/** How many of a block's states the current split has moved to its front. */
	readonly #marked: Array<number> = []
	readonly #queued: Array<boolean> = []
	readonly #waiting: Array<number> = []

	constructor(accept: ReadonlyArray<boolean>) {
		const accepting = accept.flatMap((x, s) => (x ? [s] : []))
		this.#order = Int32Array.from([...accepting, ...accept.flatMap((x, s) => (x ? [] : [s]))])
		this.#position = new Int32Array(accept.length)
		for (const [i, s] of this.#order.entries()) {
			this.#position[s] = i
		}
		this.#blockOf = new Int32Array(accept.length)
		if (accepting.length > 0) {
			this.#enqueue(this.#add(0, accepting.length))
		}
		if (accepting.length < accept.length) {
			this.#enqueue(this.#add(accepting.length, accept.length))
		}
	}

	#add(from: number, to: number): number {
		const b = this.#start.length
		this.#start.push(from)
		this.#end.push(to)
		this.#marked.push(0)
		this.#queued.push(false)
		for (let i = from; i < to; i++) {
			this.#blockOf[at(this.#order, i)] = b
		}
		return b
	}

	#enqueue(b: number): void {
		if (this.#queued[b] !== true) {
			this.#queued[b] = true
			this.#waiting.push(b)
		}
	}

	/** The states of the next waiting block, dequeued; undefined when no block waits. */
	next(): ReadonlyArray<number> | undefined {
		const splitter = this.#waiting.pop()
		if (splitter === undefined) {
			return undefined
		}
		this.#queued[splitter] = false
		return Array.from(this.#order.slice(at(this.#start, splitter), at(this.#end, splitter)))
	}

	/** Splits every block some of whose states `entering` holds. */
	split(entering: Iterable<number>): void {
		const parted: Array<number> = []
		for (const s of entering) {
			const b = this.#mark(s)
			if (b !== undefined) {
				parted.push(b)
			}
		}
		for (const b of parted) {
			this.#cut(b)
		}
	}

	/** Moves `s` to the front of its block: the block when `s` is its first state moved, else undefined. */
	#mark(s: number): number | undefined {
		const b = at(this.#blockOf, s)
		const front = at(this.#start, b) + at(this.#marked, b)
		const p = at(this.#position, s)
		if (p < front) {
			return undefined
		}
		const other = at(this.#order, front)
		this.#order[front] = s
		this.#position[s] = front
		this.#order[p] = other
		this.#position[other] = p
		const first = this.#marked[b] === 0
		this.#marked[b] = at(this.#marked, b) + 1
		return first ? b : undefined
	}

	/** Cuts block `b` after its moved states, unless every state moved. */
	#cut(b: number): void {
		const moved = at(this.#marked, b)
		this.#marked[b] = 0
		const from = at(this.#start, b)
		const blockSize = at(this.#end, b) - from
		if (moved === blockSize) {
			return
		}
		this.#start[b] = from + moved
		const part = this.#add(from, from + moved)
		this.#enqueue(this.#queued[b] === true || moved <= blockSize - moved ? part : b)
	}

	/** Each state's block, numbered densely from 0 in the order the blocks' first states come. */
	classes(): ReadonlyArray<number> {
		const number = new Map<number, number>()
		return Array.from(this.#blockOf, (b) => {
			const known = number.get(b)
			if (known !== undefined) {
				return known
			}
			number.set(b, number.size)
			return number.size - 1
		})
	}
}

/**
 * The coarsest partition of the states that separates accepting from rejecting states and that every atom's
 * transitions respect (Hopcroft's refinement), as each state's class, numbered in first-seen state order. The coarsest
 * such partition is unique, so the classes are the states' language equivalence whatever order the splits take.
 *
 * The blocks are runs of one permutation of the states, `order`, block b at start[b] up to end[b], and `position[s]` is
 * s's index in it. A splitter is a block waiting to refine the others: for each atom, the states it enters on that atom
 * are moved to the front of their blocks, and every block they part becomes two. A parted block that waits already
 * waits beside its new part; one that does not is refined by its smaller part, which suffices, since the larger one
 * refines exactly what the whole block and the smaller part refine together.
 */
const minimizeClasses = (dfa: RawDfa): ReadonlyArray<number> => {
	const n = dfa.next.length
	const atomCount = dfa.alphabet.atomCount
	/**
	 * The states entering each state on each atom: sources[offsets[a * n + t]] up to sources[offsets[a * n + t + 1]]
	 * are every s with next[s][a] = t.
	 */
	const offsets = new Int32Array(atomCount * n + 1)
	for (const row of dfa.next) {
		for (const [a, t] of row.entries()) {
			offsets[a * n + t + 1] = at(offsets, a * n + t + 1) + 1
		}
	}
	for (let i = 1; i < offsets.length; i++) {
		offsets[i] = at(offsets, i) + at(offsets, i - 1)
	}
	const cursor = offsets.slice(0, atomCount * n)
	const sources = new Int32Array(atomCount * n)
	for (const [s, row] of dfa.next.entries()) {
		for (const [a, t] of row.entries()) {
			const slot = at(cursor, a * n + t)
			sources[slot] = s
			cursor[a * n + t] = slot + 1
		}
	}
	/** The states entering any of `members` on atom `a`. */
	const entering = function* (a: number, members: ReadonlyArray<number>): Generator<number> {
		for (const t of members) {
			for (let i = at(offsets, a * n + t); i < at(offsets, a * n + t + 1); i++) {
				yield at(sources, i)
			}
		}
	}
	const partition = new Partition(dfa.accept)
	for (let members = partition.next(); members !== undefined; members = partition.next()) {
		for (let a = 0; a < atomCount; a++) {
			partition.split(entering(a, members))
		}
	}
	return partition.classes()
}

/**
 * The minimal DFA of the raw one, in canonical form: its states numbered in breadth-first order from the initial one,
 * the order a loop over the growing list of states reached gives.
 */
const canonicalize = (dfa: RawDfa): CanonicalDfa => {
	const classes = minimizeClasses(dfa)
	const classCount = new Set(classes).size
	/**
	 * Each class's first state: the classes are numbered densely from 0 in the order their first states come, and a DFA
	 * has its initial state, so class 0 is always there.
	 */
	const representative: NonEmptyReadonlyArray<number> = [
		classes.indexOf(0),
		...indices(classCount - 1).map((c) => classes.indexOf(c + 1))
	]
	const accept = mapNonEmpty(representative, (s) => dfa.accept[s] === true)
	const targets = mapNonEmpty(representative, (s) =>
		entry(dfa.next, s).map((t) => entry(classes, t))
	)
	/**
	 * Live classes reach an accepting class: the accepting classes and, breadth first, every class with an edge into a
	 * live one.
	 */
	const predecessors = new Map<number, Set<number>>()
	for (const [c, row] of targets.entries()) {
		for (const t of row) {
			predecessors.set(t, (predecessors.get(t) ?? new Set<number>()).add(c))
		}
	}
	const live = new Set(accept.flatMap((accepting, c) => (accepting ? [c] : [])))
	const pending = [...live]
	for (const t of pending) {
		for (const c of [...(predecessors.get(t) ?? [])].filter((p) => !live.has(p))) {
			live.add(c)
			pending.push(c)
		}
	}
	const { segments, atomOf } = dfa.alphabet
	/**
	 * A class's edges into live classes, in the order of their least code points: each target's segments, walked in
	 * code point order with adjacent ones joined, so a target enters the map at its least code point.
	 */
	const edgesOf = (c: number): Array<{ set: CharSet; target: number }> => {
		const row = entry(targets, c)
		const byTarget = new Map<number, Array<[number, number]>>()
		for (const [segment, [lo, hi]] of segments.entries()) {
			const t = entry(row, at(atomOf, segment))
			if (!live.has(t)) {
				continue
			}
			const intervals = byTarget.get(t)
			const last = intervals?.at(-1)
			if (intervals === undefined) {
				byTarget.set(t, [[lo, hi]])
			} else if (last !== undefined && last[1] + 1 === lo) {
				last[1] = hi
			} else {
				intervals.push([lo, hi])
			}
		}
		return Array.from(byTarget, ([target, intervals]) => ({ set: charSet(intervals), target }))
	}
	const initial = entry(classes, 0)
	if (!live.has(initial)) {
		return { states: [] }
	}
	/** Each live class's number, breadth first: its own, or the next one when an edge first reaches it. */
	const number = new Map<number, number>([[initial, 0]])
	const order = [initial]
	const numberOf = (target: number): number => {
		const known = number.get(target)
		if (known !== undefined) {
			return known
		}
		const assigned = order.length
		number.set(target, assigned)
		order.push(target)
		return assigned
	}
	const states: Array<CanonicalDfa["states"][number]> = []
	for (const c of order) {
		states.push({
			accept: accept[c] === true,
			edges: edgesOf(c).map(({ set, target }) => ({ set, to: numberOf(target) }))
		})
	}
	return { states }
}

/**
 * Bounded automaton reasoning over a pattern's language.
 *
 * A pattern denotes the set of admitted text values in which a match exists. This module determinizes that language
 * into a minimal DFA over the admitted code points, within fixed bounds, so no determinization is uncontrolled.
 * When the bounds hold, the minimal DFA proves the facts the schema compiler uses:
 *
 * - the language is every admitted value, a tautology whose CHECK erases;
 * - the language is finite, so its members can be listed, `VALUE IN (...)` where that prints shorter than the regex;
 * - two patterns recognize the same values, because minimal DFAs are unique up to the canonical numbering below, which
 *   is the language proof that domain sharing needs rather than a cosmetic rewrite.
 *
 * When a bound is exceeded the analysis proves nothing, and every caller falls back to the conservative choice:
 * keep the regex CHECK, share only structurally equal IR. Nothing here validates application values.
 *
 * The DFA reads whole values. Search semantics are folded in: the NFA's start state is re-entered at every position,
 * `^` edges are followed only before the first code point, `$` edges only after the last, and reaching the accept
 * state before the end makes every extension a member (the absorbing state DONE).
 *
 * The canonical minimal DFA of the NFA's search language, or the limit its construction would have passed, with what
 * the construction spent.
 */
export const minimalDfa = (nfa: Nfa, limits: DfaLimits): DfaOutcome => {
	const construction = determinize(nfa, limits)
	switch (construction.kind) {
		case "built":
			return { kind: "minimal", dfa: canonicalize(construction.dfa), spent: construction.spent }
		case "bounded":
			return construction
	}
}

/**
 * What the bounded construction of an intersection's minimal DFA came to: the minimal DFA, or a bound a product would
 * have passed.
 */
export type IntersectionOutcome =
	| { readonly kind: "minimal"; readonly dfa: CanonicalDfa }
	| { readonly kind: "bounded" }

/**
 * Each state's target on each atom of `partition`, -1 where the state has no edge holding it: a canonical DFA's edges,
 * whose sets are `sets` from `offset` on in the order of its states' edges.
 */
const atomTargets = (
	dfa: CanonicalDfa,
	partition: CharPartition,
	offset: number
): ReadonlyArray<Int32Array> => {
	let set = offset
	return dfa.states.map((state) => {
		const row = new Int32Array(partition.atomCount).fill(-1)
		for (const edge of state.edges) {
			for (const atom of entry(partition.setAtoms, set)) {
				row[atom] = edge.to
			}
			set += 1
		}
		return row
	})
}

/** A state of an intersection's product: a pair of the two DFAs' states, or the dead state a pair leaves past either. */
type ProductState =
	| { readonly kind: "pair"; readonly a: number; readonly b: number }
	| { readonly kind: "dead" }

/**
 * The canonical minimal DFA of the intersection of two canonical DFAs' languages, within `limits`: the initial pair of
 * their states, the dead state, and every pair the initial one reaches, over the atoms their edges' sets cut the domain
 * into, an atom either state has no edge on leading to the dead state; then minimized and numbered as a pattern's own
 * (canonicalize), so one language has one canonical DFA however it is spelled. Every state counts against the bound on
 * states, and every state expanded is charged its transitions as work.
 */
const intersect = (a: CanonicalDfa, b: CanonicalDfa, limits: DfaLimits): IntersectionOutcome => {
	if (a.states.length === 0 || b.states.length === 0) {
		return { kind: "minimal", dfa: { states: [] } }
	}
	const sets = [...a.states, ...b.states].flatMap((state) => state.edges.map((edge) => edge.set))
	const alphabet = partitionOf(sets, domain)
	const onA = atomTargets(a, alphabet, 0)
	const onB = atomTargets(
		b,
		alphabet,
		a.states.reduce((n, state) => n + state.edges.length, 0)
	)
	const states: Array<ProductState> = [{ kind: "pair", a: 0, b: 0 }, { kind: "dead" }]
	const dead = 1
	const ids = new Map<number, number>([[0, 0]])
	const intern = (x: number, y: number): number | undefined => {
		const key = x * b.states.length + y
		const known = ids.get(key)
		if (known !== undefined) {
			return known
		}
		if (states.length >= limits.maxStates) {
			return undefined
		}
		ids.set(key, states.length)
		states.push({ kind: "pair", a: x, b: y })
		return states.length - 1
	}
	const next: Array<ReadonlyArray<number>> = []
	let work = 0
	for (let id = 0; id < states.length; id++) {
		const state = entry(states, id)
		work += alphabet.atomCount
		if (work > limits.maxWork) {
			return { kind: "bounded" }
		}
		const row: Array<number> = []
		for (let atom = 0; atom < alphabet.atomCount; atom++) {
			const target =
				state.kind === "dead"
					? dead
					: transition(at(entry(onA, state.a), atom), at(entry(onB, state.b), atom), dead, intern)
			if (target === undefined) {
				return { kind: "bounded" }
			}
			row.push(target)
		}
		next.push(row)
	}
	const accept = states.map(
		(state) =>
			state.kind === "pair" && entry(a.states, state.a).accept && entry(b.states, state.b).accept
	)
	return { kind: "minimal", dfa: canonicalize({ next, accept, alphabet }) }
}

/**
 * A pair's target on one atom, from its two states' targets on it: the dead state where either has none (-1, an atom no
 * edge of the state holds), else the pair of the targets, undefined where interning it would pass the bound on states.
 */
const transition = (
	toA: number,
	toB: number,
	dead: number,
	intern: (x: number, y: number) => number | undefined
): number | undefined => (toA < 0 || toB < 0 ? dead : intern(toA, toB))

/**
 * The canonical minimal DFA of the intersection of canonical DFAs' languages, within `limits` at each product
 * (intersect): the first one alone where there is one, so one pattern's DFA is its own.
 */
export const intersectionDfa = (
	dfas: NonEmptyReadonlyArray<CanonicalDfa>,
	limits: DfaLimits
): IntersectionOutcome => {
	const [first, ...rest] = dfas
	let product: IntersectionOutcome = { kind: "minimal", dfa: first }
	for (const dfa of rest) {
		if (product.kind === "bounded") {
			return product
		}
		product = intersect(product.dfa, dfa, limits)
	}
	return product
}

/** The canonical text of a minimal DFA: equal texts, equal languages. */
export const dfaKey = (dfa: CanonicalDfa): string =>
	JSON.stringify(dfa.states.map((s) => [s.accept ? 1 : 0, s.edges.map((e) => [e.set, e.to])]))

/** Every admitted value is a member: one accepting state looping on the whole domain. */
export const isUniversal = (dfa: CanonicalDfa): boolean => {
	const [only, ...others] = dfa.states
	if (only === undefined || others.length > 0) {
		return false
	}
	const [edge, ...more] = only.edges
	return only.accept && edge !== undefined && more.length === 0 && size(edge.set) === size(domain)
}

/**
 * Topological order of the DFA, or undefined when it has a cycle (every remaining state is live, so a cycle means
 * infinitely many members).
 */
const topologicalOrder = (dfa: CanonicalDfa): ReadonlyArray<number> | undefined => {
	const indegree = dfa.states.map(() => 0)
	for (const s of dfa.states) {
		for (const e of s.edges) {
			indegree[e.to] = entry(indegree, e.to) + 1
		}
	}
	const ready = indegree.flatMap((d, i) => (d === 0 ? [i] : []))
	const order: Array<number> = []
	for (let s = ready.pop(); s !== undefined; s = ready.pop()) {
		order.push(s)
		for (const e of entry(dfa.states, s).edges) {
			indegree[e.to] = entry(indegree, e.to) - 1
			if (indegree[e.to] === 0) {
				ready.push(e.to)
			}
		}
	}
	return order.length === dfa.states.length ? order : undefined
}

/** A state on the path a walk of the members is on: the steps it has left, and the UTF-8 bytes of the path up to it. */
interface PathState {
	readonly steps: Iterator<readonly [number, number]>
	readonly bytes: number
}

/**
 * The members of a language in code point order when together they weigh at most `ceiling`, undefined when they weigh
 * more: a member weighs `each` and its UTF-8 bytes, so an infinite language always weighs more. Every state of a
 * canonical DFA is live, so the path being walked leads to a member at least as long as itself, which the walk has not
 * met yet; it stops as soon as the members met and that one would weigh more, so it never walks past the ceiling.
 */
export const membersWithin = (
	dfa: CanonicalDfa,
	each: number,
	ceiling: number
): ReadonlyArray<string> | undefined => {
	const out: Array<string> = []
	if (dfa.states.length === 0) {
		return out
	}
	/** The path to the state being walked: its code points, and each state on it. */
	const prefix: Array<number> = []
	const path: Array<PathState> = []
	let weight = 0
	const fits = (bytes: number): boolean => weight + each + bytes <= ceiling
	const enter = (s: number, bytes: number): void => {
		const state = entry(dfa.states, s)
		if (state.accept) {
			out.push(codePointsText(prefix))
			weight += each + bytes
		}
		path.push({ steps: stepsOf(state), bytes })
	}
	if (!fits(0)) {
		return undefined
	}
	enter(0, 0)
	for (let top = path.at(-1); top !== undefined; top = path.at(-1)) {
		const step = top.steps.next()
		if (step.done === true) {
			path.pop()
			prefix.pop()
		} else {
			const [c, to] = step.value
			const bytes = top.bytes + utf8Width(c)
			if (!fits(bytes)) {
				return undefined
			}
			prefix.push(c)
			enter(to, bytes)
		}
	}
	return out.toSorted(compareByCodePoint)
}

/** Every step out of a state, in edge and code point order: each code point of each edge's set, with its target. */
function* stepsOf(state: CanonicalDfa["states"][number]): Generator<readonly [number, number]> {
	for (const e of state.edges) {
		for (const [lo, hi] of e.set) {
			for (let c = lo; c <= hi; c++) {
				yield [c, e.to]
			}
		}
	}
}

/** Code point order, PostgreSQL's order under pg_c_utf8. */
const compareByCodePoint = (a: string, b: string): number => {
	const x = codePoints(a)
	const y = codePoints(b)
	for (const [i, xi] of x.entries()) {
		const yi = y[i]
		if (yi === undefined) {
			break
		}
		if (xi !== yi) {
			return xi - yi
		}
	}
	return x.length - y.length
}

/** The longest member, in code points and in UTF-8 bytes; undefined for an infinite or empty language. */
export const longest = (dfa: CanonicalDfa): TextBounds | undefined => {
	const order = topologicalOrder(dfa)
	if (order === undefined || dfa.states.length === 0) {
		return undefined
	}
	const length: Array<number> = dfa.states.map(() => -1)
	const bytes: Array<number> = dfa.states.map(() => -1)
	for (const s of order.toReversed()) {
		const state = entry(dfa.states, s)
		let l = state.accept ? 0 : -1
		let b = state.accept ? 0 : -1
		for (const e of state.edges) {
			const toLength = entry(length, e.to)
			const toBytes = entry(bytes, e.to)
			if (toLength >= 0) {
				l = Math.max(l, 1 + toLength)
			}
			if (toBytes >= 0) {
				b = Math.max(b, maxUtf8Width(e.set) + toBytes)
			}
		}
		length[s] = l
		bytes[s] = b
	}
	return textBounds(entry(length, 0), entry(bytes, 0))
}
