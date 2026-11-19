import { TupleMap } from "#text/base/tuple-map.ts"
import { type CharSet, domain } from "#text/regex/charset.ts"
import { closure, type Nfa } from "#text/regex/nfa.ts"
import { type CharPartition, partitionOf } from "#text/regex/partition.ts"
import { entry } from "#text/regex/table.ts"

/**
 * The subset construction of an NFA's search language, the one both of its readers run: dfa.ts determinizes it whole,
 * within bounds, for the compiler's language proofs, and match.ts Matcher determinizes it where texts reach it, for
 * membership.
 *
 * A pattern denotes the admitted texts in which a match exists, so the construction folds the search in: the NFA's start
 * state is re-entered at every position, `^` edges are followed only before the first code point, `$` edges only after
 * the last, and reaching the accept state before the end makes every extension a member (the absorbing state, done).
 */

/** A set's bounds in order, each interval's low then high: equal exactly for two sets of the same intervals. */
const setBounds = (set: CharSet): ReadonlyArray<number> => set.flatMap(([lo, hi]) => [lo, hi])

/** A set edge of an NFA state: the position of its set among the distinct sets, and its target. */
interface SetEdge {
	readonly set: number
	readonly to: number
}

/**
 * The alphabet of a subset construction. Its segments are the maximal intervals of the admitted domain that no NFA
 * set's boundary cuts, in code point order; its atoms are the classes of segments every NFA set holds alike, numbered
 * in the order their first segments come, so an atom's least code point grows with its number. Each distinct set of
 * the NFA's edges holds whole atoms, which `setAtoms` lists, and `setEdges` holds each state's set edges.
 */
export interface Alphabet extends CharPartition {
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
export type Subset =
	| { readonly kind: "done" }
	| { readonly kind: "set"; readonly states: ReadonlyArray<number>; readonly initial: boolean }

const done: Subset = { kind: "done" }

/** The key a subset is interned under: two subsets of one key are one state. */
export const subsetKey = (subset: Subset): string =>
	subset.kind === "done"
		? "done"
		: `${subset.initial ? "i" : "n"}${[...subset.states].toSorted((a, b) => a - b).join(",")}`

/**
 * A subset the construction reached and the work it was charged, in NFA-state visits: a transition's, its source
 * subset's states, which it reads, and the states its closure reaches; the initial subset's, its closure's states. A
 * transition out of the sink reads nothing and is free.
 */
export interface Step {
	readonly to: Subset
	readonly work: number
}

/**
 * The subset construction over one NFA: its alphabet, its initial subset, and each subset's target on an atom, which a
 * reader interns as its own states. It keeps only what every transition reads, the restart closure where an unanchored
 * search begins again and the scratch its closures mark, so a transition costs about the work it is charged (Step).
 */
export class SearchSubsets {
	readonly nfa: Nfa
	readonly alphabet: Alphabet
	/** The initial subset, the start state's closure before the first code point. */
	readonly initial: Step
	/** For each distinct set, whether it holds each atom (1) or not (0). */
	readonly #holds: ReadonlyArray<Uint8Array>
	/** The states an atom no set edge of a subset holds reaches: the start state's closure past the first code point. */
	readonly #restartStates: ReadonlyArray<number>
	readonly #restart: Subset
	readonly #mark: Int32Array
	#stamp = 0

	constructor(nfa: Nfa) {
		this.nfa = nfa
		this.alphabet = alphabetOf(nfa)
		const { atomCount, setAtoms } = this.alphabet
		this.#holds = setAtoms.map((atoms) => {
			const holds = new Uint8Array(atomCount)
			for (const a of atoms) {
				holds[a] = 1
			}
			return holds
		})
		this.#mark = new Int32Array(nfa.edges.length).fill(-1)
		const initial = closure(
			nfa,
			[nfa.start],
			{ atStart: true, atEnd: false },
			this.#mark,
			this.#stamp++
		)
		this.initial = { to: this.#settle(initial, true), work: initial.length }
		this.#restartStates = closure(
			nfa,
			[nfa.start],
			{ atStart: false, atEnd: false },
			this.#mark,
			this.#stamp++
		)
		this.#restart = this.#settle(this.#restartStates, false)
	}

	/** The subset `states` reach: the sink once they hold the NFA's accepting state. */
	#settle(states: ReadonlyArray<number>, initial: boolean): Subset {
		return states.includes(this.nfa.accept) ? done : { kind: "set", states, initial }
	}

	/**
	 * The subset `from` reaches on `atom`: the closure past a code point of the targets of its set edges that hold the
	 * atom, the start state among them, where the search begins again; the restart closure where none holds it; and the
	 * sink from the sink.
	 */
	target(from: Subset, atom: number): Step {
		if (from.kind === "done") {
			return { to: done, work: 0 }
		}
		const targets: Array<number> = []
		for (const s of from.states) {
			for (const edge of entry(this.alphabet.setEdges, s)) {
				if (entry(entry(this.#holds, edge.set), atom) === 1) {
					targets.push(edge.to)
				}
			}
		}
		if (targets.length === 0) {
			return { to: this.#restart, work: from.states.length + this.#restartStates.length }
		}
		const reached = closure(
			this.nfa,
			[this.nfa.start, ...targets],
			{ atStart: false, atEnd: false },
			this.#mark,
			this.#stamp++
		)
		return { to: this.#settle(reached, false), work: from.states.length + reached.length }
	}

	/** Whether a text whose code points led to `subset` is a member: its closure at the end holds the accept state. */
	acceptsAtEnd(subset: Subset): boolean {
		return (
			subset.kind === "done" ||
			closure(
				this.nfa,
				subset.states,
				{ atStart: subset.initial, atEnd: true },
				this.#mark,
				this.#stamp++
			).includes(this.nfa.accept)
		)
	}
}
