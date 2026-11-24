import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import type { NonEmptyReadonlyArray } from "#text/base/nonempty.ts"
import { TupleMap } from "#text/base/tuple-map.ts"
import {
	type CharSet,
	charSet,
	domain,
	intersection,
	isEmpty,
	maxUtf8Width,
	size,
	utf8Classes,
	utf8Width
} from "#text/regex/charset.ts"
import type { Nfa } from "#text/regex/nfa.ts"
import { type CharPartition, partitionOf } from "#text/regex/partition.ts"
import { SearchSubsets, type Subset, subsetKey } from "#text/regex/subset.ts"
import { cell, entry } from "#text/regex/table.ts"

/**
 * Proved bounds on every member of a language, in code points and UTF-8 bytes. The analysis makes one by textBounds
 * alone, frozen where it is made.
 */
export interface TextBounds {
	readonly length: number
	readonly bytes: number
}

/** Bounds of `length` code points and `bytes` UTF-8 bytes: the one constructor of a TextBounds, frozen. */
export const textBounds = (length: number, bytes: number): TextBounds =>
	Object.freeze({ length, bytes })

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

/** The element of `xs` at `i`, which the caller's bounds make present (scalar/regex/table.ts entry). */
const at = (xs: Int32Array, i: number): number => cell(xs, i)

interface RawDfa {
	/** Transition table: target per atom; one row per state, the initial one first. */
	readonly next: ReadonlyArray<Int32Array>
	readonly accept: ReadonlyArray<boolean>
	readonly alphabet: CharPartition
}

/** What the subset construction came to: the raw DFA, or the limit it stopped at. */
type Construction =
	| { readonly kind: "built"; readonly dfa: RawDfa; readonly spent: DfaSpent }
	| DfaBounded

/**
 * The subset construction (subset.ts SearchSubsets) run whole, within the limits: every state it reaches, numbered in
 * the order it is first reached, each expanded on every atom in turn. Every transition counts as work what its Step is
 * charged, and the initial subset its closure's states.
 *
 * Each state's row is read whole (SearchSubsets targets): its set edges walked once, and one closure and one interning
 * for each distinct step, which the atoms holding it share, where each atom walked every edge of the state, closed over
 * its targets and interned the subset it reached, a sort and a join of its configurations (subsetKey): O(Σ atoms of the
 * set edges' sets + d·c) a state for d distinct steps of closures of c configurations, where it was O(k·(e + c)) for k
 * atoms and e set edges, most of a pattern's atoms leading most of its states to its restart closure. The charge and
 * the numbering stay the atom-by-atom construction's: each atom is charged its step's work and checked against the
 * limits in turn, and a step is interned at the first atom that reaches it, so a construction stops where, and spends
 * what, it did (test/unit/text/construction.test.ts). Measured at grizzle 0624a312c over the 725 constructions of
 * edullm's QTI schema's laws (qti-pie 1bf7dcc's lawsOf, 43,387 states, 1,146,816 transitions), under a 50 µs CPU profile,
 * five runs in one process: 967 ms a run to 390 ms.
 */
const determinize = (nfa: Nfa, limits: DfaLimits): Construction => {
	const subsets = new SearchSubsets(nfa)
	const { alphabet } = subsets
	const { atomCount } = alphabet
	let work = subsets.initial.work

	const keys = new Map<string, number>()
	const members: Array<Subset> = []
	const next: Array<Int32Array> = []

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
		keys.set(key, id)
		members.push(subset)
		next.push(new Int32Array(atomCount))
		return id
	}

	const bounded = (limit: keyof DfaLimits): DfaBounded => ({
		kind: "bounded",
		limit,
		spent: { states: members.length, work }
	})

	if (intern(subsets.initial.to) === undefined) {
		return bounded("maxStates")
	}
	for (let id = 0; id < members.length; id++) {
		const row = entry(next, id)
		const { steps, stepOf } = subsets.targets(entry(members, id))
		/** Each distinct step's state, once an atom has interned it; -1 before. */
		const reached = new Int32Array(steps.length).fill(-1)
		for (let a = 0; a < atomCount; a++) {
			const s = at(stepOf, a)
			const step = entry(steps, s)
			work += step.work
			if (work > limits.maxWork) {
				return bounded("maxWork")
			}
			const known = at(reached, s)
			const target = known >= 0 ? known : intern(step.to)
			if (target === undefined) {
				return bounded("maxStates")
			}
			reached[s] = target
			row[a] = target
		}
	}
	const accept = members.map((subset) => subsets.acceptsAtEnd(subset))
	return { kind: "built", dfa: { next, accept, alphabet }, spent: { states: members.length, work } }
}

/**
 * A partition of the integers below a size into sets, refined by marking some of them and splitting every set they were
 * marked in (Valmari's refinable partition): each set is the run `elements[first[s]]` up to `elements[past[s]]`,
 * `location[e]` is e's index in `elements` and `setOf[e]` its set. A mark moves an element to the front of its set's
 * run; a split cuts each set some of whose elements were marked, unless all were, into its marked and unmarked parts,
 * the smaller one numbered as a new set, so an element moves into a new set only into one at most half its set's size.
 */
class Refinable {
	readonly elements: Int32Array
	readonly #location: Int32Array
	readonly setOf: Int32Array
	readonly first: Int32Array
	readonly past: Int32Array
	readonly #marked: Int32Array
	readonly #touched: Int32Array
	#touchedCount = 0
	/** How many sets there are, numbered from 0. */
	count: number

	/** The partition of the integers below `length` into one set, or none for length 0. */
	constructor(length: number) {
		this.elements = new Int32Array(length)
		this.#location = new Int32Array(length)
		for (let i = 0; i < length; i++) {
			this.elements[i] = i
			this.#location[i] = i
		}
		this.setOf = new Int32Array(length)
		this.first = new Int32Array(length)
		this.past = new Int32Array(length)
		this.#marked = new Int32Array(length)
		this.#touched = new Int32Array(length)
		this.count = length > 0 ? 1 : 0
		if (length > 0) {
			this.past[0] = length
		}
	}

	/** Marks `e`, which no mark since the last split marked: moves it to the front of its set's unmarked elements. */
	mark(e: number): void {
		const s = at(this.setOf, e)
		const i = at(this.#location, e)
		const j = at(this.first, s) + at(this.#marked, s)
		const other = at(this.elements, j)
		this.elements[i] = other
		this.#location[other] = i
		this.elements[j] = e
		this.#location[e] = j
		if (this.#marked[s] === 0) {
			this.#touched[this.#touchedCount] = s
			this.#touchedCount += 1
		}
		this.#marked[s] = at(this.#marked, s) + 1
	}

	/** Splits every set a mark since the last split touched, unless the marks took every element of it. */
	split(): void {
		while (this.#touchedCount > 0) {
			this.#touchedCount -= 1
			const s = at(this.#touched, this.#touchedCount)
			const cut = at(this.first, s) + at(this.#marked, s)
			this.#marked[s] = 0
			if (cut === at(this.past, s)) {
				continue
			}
			const part = this.count
			this.count += 1
			if (cut - at(this.first, s) <= at(this.past, s) - cut) {
				this.first[part] = at(this.first, s)
				this.past[part] = cut
				this.first[s] = cut
			} else {
				this.past[part] = at(this.past, s)
				this.first[part] = cut
				this.past[s] = cut
			}
			for (let i = at(this.first, part); i < at(this.past, part); i++) {
				this.setOf[at(this.elements, i)] = part
			}
		}
	}
}

/**
 * The live states of a raw DFA, those that reach an accepting state, by a breadth-first walk back from the accepting
 * states over each state's incoming transitions.
 */
const liveStates = (dfa: RawDfa): Uint8Array => {
	const n = dfa.next.length
	const offsets = new Int32Array(n + 1)
	for (const row of dfa.next) {
		for (const t of row) {
			offsets[t + 1] = at(offsets, t + 1) + 1
		}
	}
	for (let i = 1; i <= n; i++) {
		offsets[i] = at(offsets, i) + at(offsets, i - 1)
	}
	const cursor = offsets.slice(0, n)
	const sources = new Int32Array(at(offsets, n))
	for (const [s, row] of dfa.next.entries()) {
		for (const t of row) {
			sources[at(cursor, t)] = s
			cursor[t] = at(cursor, t) + 1
		}
	}
	const live = new Uint8Array(n)
	const pending: Array<number> = []
	for (const [s, accepting] of dfa.accept.entries()) {
		if (accepting) {
			live[s] = 1
			pending.push(s)
		}
	}
	for (let t = pending.pop(); t !== undefined; t = pending.pop()) {
		for (let i = at(offsets, t); i < at(offsets, t + 1); i++) {
			const s = at(sources, i)
			if (live[s] === 0) {
				live[s] = 1
				pending.push(s)
			}
		}
	}
	return live
}

/**
 * The language equivalence of a raw DFA's live states, as each live state's class (-1 for a state no accepting state
 * is reached from): the coarsest partition of the live states that separates accepting from rejecting states and that
 * every atom's transitions respect, the transitions into states that are not live left out, so every state that is
 * not live is one implicit state, the empty language's. The coarsest such partition is unique, so the classes are the
 * states' language equivalence whatever algorithm finds them.
 *
 * Valmari and Lehtinen's refinement of a partial DFA (Valmari, "Fast brief practical DFA minimization", 2012): the
 * live states are a refinable partition, accepting and rejecting first, and so are the transitions between them, by
 * atom first; a set of transitions (a cord) splits the states by whether they are its transitions' sources, and a new
 * set of states splits the cords by whether their transitions enter it. Every set is processed once, after its split,
 * the smaller part a new set, so each transition is marked O(log n) times: O(n·k + m log n) for n states, k atoms and m
 * live transitions, the n·k the table's scan for its live transitions.
 *
 * It replaces Hopcroft's refinement over the whole table, the states that are not live among them, which walked every
 * atom for every state of each splitter, O(k·n log n) steps through a generator whatever the transitions, where most of
 * a pattern's transitions lead to its restart closure, a state that is not live in an anchored pattern, and which found
 * each class's first state by a scan of every state (indexOf), O(n) a class. Measured as determinize is: the
 * minimization 374 ms a run to 77 ms, the canonical form with it 517 ms to 147 ms; minimalDfa whole, unprofiled, the
 * sum of each construction's best of five, 1,350 ms to 423 ms, its every outcome and spend byte for byte the same.
 */
const liveClasses = (dfa: RawDfa, live: Uint8Array): Int32Array => {
	const n = dfa.next.length
	const atomCount = dfa.alphabet.atomCount
	/** The live states, densely numbered: state[i] is the i-th, index[s] its number, -1 for a state not live. */
	const state: Array<number> = []
	const index = new Int32Array(n).fill(-1)
	for (let s = 0; s < n; s++) {
		if (live[s] === 1) {
			index[s] = state.length
			state.push(s)
		}
	}
	/**
	 * The transitions between live states, ordered by atom: tail[x] and head[x] the x-th one's source and target by
	 * number, those on atom a from perAtom[a] up to perAtom[a + 1].
	 */
	const perAtom = new Int32Array(atomCount + 1)
	for (const s of state) {
		const row = entry(dfa.next, s)
		for (let a = 0; a < atomCount; a++) {
			if (live[at(row, a)] === 1) {
				perAtom[a + 1] = at(perAtom, a + 1) + 1
			}
		}
	}
	for (let a = 1; a <= atomCount; a++) {
		perAtom[a] = at(perAtom, a) + at(perAtom, a - 1)
	}
	const m = at(perAtom, atomCount)
	const tail = new Int32Array(m)
	const head = new Int32Array(m)
	const slot = perAtom.slice(0, atomCount)
	for (const [i, s] of state.entries()) {
		const row = entry(dfa.next, s)
		for (let a = 0; a < atomCount; a++) {
			const t = at(row, a)
			if (live[t] !== 1) {
				continue
			}
			const x = at(slot, a)
			tail[x] = i
			head[x] = at(index, t)
			slot[a] = x + 1
		}
	}
	/** The transitions entering each live state: incoming[into[q]] up to incoming[into[q + 1]]. */
	const into = new Int32Array(state.length + 1)
	for (const q of head) {
		into[q + 1] = at(into, q + 1) + 1
	}
	for (let q = 1; q <= state.length; q++) {
		into[q] = at(into, q) + at(into, q - 1)
	}
	const incoming = new Int32Array(m)
	const fill = into.slice(0, state.length)
	for (const [x, q] of head.entries()) {
		incoming[at(fill, q)] = x
		fill[q] = at(fill, q) + 1
	}
	const blocks = new Refinable(state.length)
	for (const [i, s] of state.entries()) {
		if (dfa.accept[s] === true) {
			blocks.mark(i)
		}
	}
	blocks.split()
	/** The cords: the transitions in atom order, one set for each atom some transition is on. */
	const cords = new Refinable(m)
	cords.count = 0
	for (let a = 0; a < atomCount; a++) {
		const from = at(perAtom, a)
		const to = at(perAtom, a + 1)
		if (from === to) {
			continue
		}
		const c = cords.count
		cords.count += 1
		cords.first[c] = from
		cords.past[c] = to
		for (let x = from; x < to; x++) {
			cords.setOf[x] = c
		}
	}
	let b = 1
	for (let c = 0; c < cords.count; c++) {
		for (let i = at(cords.first, c); i < at(cords.past, c); i++) {
			blocks.mark(at(tail, at(cords.elements, i)))
		}
		blocks.split()
		for (; b < blocks.count; b++) {
			for (let i = at(blocks.first, b); i < at(blocks.past, b); i++) {
				const q = at(blocks.elements, i)
				for (let j = at(into, q); j < at(into, q + 1); j++) {
					cords.mark(at(incoming, j))
				}
			}
			cords.split()
		}
	}
	const classes = new Int32Array(n).fill(-1)
	for (const [i, s] of state.entries()) {
		classes[s] = at(blocks.setOf, i)
	}
	return classes
}

/**
 * The minimal DFA of the raw one, in canonical form: its live states' classes (liveClasses), numbered in breadth-first
 * order from the initial one's, the order a loop over the growing list of classes reached gives, each class's edges
 * read off its first state's row.
 */
const canonicalize = (dfa: RawDfa): CanonicalDfa => {
	const live = liveStates(dfa)
	if (live[0] === 0) {
		return { states: [] }
	}
	const classes = liveClasses(dfa, live)
	/** Each class's first state: its row and its acceptance are every state's of the class. */
	const representative: Array<number> = []
	for (const [s, c] of classes.entries()) {
		if (c >= 0 && representative[c] === undefined) {
			representative[c] = s
		}
	}
	const { segments, atomOf } = dfa.alphabet
	/**
	 * A class's edges into live classes, in the order of their least code points: each target's segments, walked in
	 * code point order with adjacent ones joined, so a target enters the map at its least code point.
	 */
	const edgesOf = (c: number): Array<{ set: CharSet; target: number }> => {
		const row = entry(dfa.next, entry(representative, c))
		const byTarget = new Map<number, Array<[number, number]>>()
		for (let segment = 0; segment < segments.length; segment++) {
			const [lo, hi] = entry(segments, segment)
			const t = at(classes, at(row, at(atomOf, segment)))
			if (t < 0) {
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
	const initial = at(classes, 0)
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
			accept: dfa.accept[entry(representative, c)] === true,
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
	const next: Array<Int32Array> = []
	let work = 0
	for (let id = 0; id < states.length; id++) {
		const state = entry(states, id)
		work += alphabet.atomCount
		if (work > limits.maxWork) {
			return { kind: "bounded" }
		}
		const row = new Int32Array(alphabet.atomCount)
		for (let atom = 0; atom < alphabet.atomCount; atom++) {
			const target =
				state.kind === "dead"
					? dead
					: transition(at(entry(onA, state.a), atom), at(entry(onB, state.b), atom), dead, intern)
			if (target === undefined) {
				return { kind: "bounded" }
			}
			row[atom] = target
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

/**
 * The places a byte walk of a DFA is at, four for each state: the state itself, and the state one, two or three bytes
 * away, where the walk is inside a code point that leads to it.
 */
const byteSlots = maxUtf8Width(domain)

/** The UTF-8 widths of a set's code points, each once, in width order. */
const widthsOf = (set: CharSet): ReadonlyArray<number> =>
	utf8Classes.flatMap(({ width, set: of }) => (isEmpty(intersection(set, of)) ? [] : [width]))

/** The places one byte past `place` (byteSlots): the next place toward its state, or past each code point out of it. */
const pastByte = (
	place: number,
	out: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<number> => (place % byteSlots === 0 ? entry(out, place / byteSlots) : [place - 1])

/**
 * The most bytes at most `octets` that a count of bytes a member takes reaches, 0 where none does, from whether each
 * count below `member.length` is a member's: each count from `cycle` on recurs every `member.length - cycle` bytes,
 * and none recurs where `cycle` is `member.length`.
 */
const mostWithin = (member: ReadonlyArray<boolean>, cycle: number, octets: number): number => {
	const period = member.length - cycle
	return member.reduce(
		(most, is, k) =>
			!is ? most : Math.max(most, k < cycle ? k : k + period * Math.floor((octets - k) / period)),
		0
	)
}

/** What the walk of a language's byte counts came to: the most bytes a member within the bound takes, or a limit. */
export type WithinOutcome = { readonly kind: "within"; readonly bytes: number } | DfaBounded

/**
 * The most UTF-8 bytes a member of at most `octets` bytes takes, 0 where none is that short: the longest text of a
 * language within a byte bound, which is the bound, or less where the language's characters fill it no closer, as a
 * language of one 4-byte character within one byte holds the empty text alone. The walk reads the DFA one byte at a
 * time, a code point of w bytes taking w steps, so it is the subset construction of the automaton of the members' byte
 * counts over one letter: its k-th subset holds the places k bytes reach (byteSlots), and a member takes k bytes where
 * that subset holds an accepting state. Each subset is the one before it moved one byte, so from the first subset that
 * recurs every later one recurs in order, and the walk stops there or at `octets`, whichever it reaches first, within
 * `limits` as the subset construction is.
 */
export const longestWithin = (
	dfa: CanonicalDfa,
	octets: number,
	limits: DfaLimits
): WithinOutcome => {
	const out = dfa.states.map((state) =>
		[
			...new Set(state.edges.flatMap((e) => widthsOf(e.set).map((w) => e.to * byteSlots + w - 1)))
		].toSorted((a, b) => a - b)
	)
	const reached = new TupleMap<ReadonlyArray<number>, number>()
	const member: Array<boolean> = []
	let places: ReadonlyArray<number> = dfa.states.length === 0 ? [] : [0]
	let work = places.length
	const bounded = (limit: keyof DfaLimits): DfaBounded => ({
		kind: "bounded",
		limit,
		spent: { states: reached.size, work }
	})
	for (let k = 0; ; k++) {
		const first = reached.get(places)
		if (first !== undefined) {
			return { kind: "within", bytes: mostWithin(member, first, octets) }
		}
		if (reached.size >= limits.maxStates) {
			return bounded("maxStates")
		}
		reached.set(places, k)
		member.push(places.some((p) => p % byteSlots === 0 && entry(dfa.states, p / byteSlots).accept))
		if (k === octets) {
			return { kind: "within", bytes: mostWithin(member, member.length, octets) }
		}
		const next = [...new Set(places.flatMap((p) => pastByte(p, out)))].toSorted((a, b) => a - b)
		work += places.length + next.length
		if (work > limits.maxWork) {
			return bounded("maxWork")
		}
		places = next
	}
}
