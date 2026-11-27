import { codePointAt, codePointUnits } from "@bjornpagen/grizzle-text/text"
import { regexSpaceStates } from "#text/regex/ir.ts"
import { configurationsOf, type Nfa } from "#text/regex/nfa.ts"
import { SearchSubsets, type Subset, SubsetNumbers } from "#text/regex/subset.ts"
import { entry } from "#text/regex/table.ts"

/**
 * The most DFA states a matcher keeps for each state of the NFA its cache is sized by (sizedStates). A text that reaches
 * a state the matcher has not met, once it keeps that many, starts the matcher's table over from its initial state, so
 * a matcher holds at most twice those states, however many texts it reads and whatever they spell: a value the host
 * matches is an application's, which may reach as many states of a pattern's search language as it has code points,
 * and the states a pattern's language holds can number exponentially many in its NFA's. It is PostgreSQL's own sizing
 * of the cache of its lazy DFA, which its regex executor recycles past the same count.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's regex executor (rege_dfa.c newdfa)
 * @unit DFA states per NFA state
 * @scope each pattern's matcher, over every text one process matches against it
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/regex/rege_dfa.c#L613
 * @quote size_t nss = cnfa->nstates * 2;
 * @verified 2026-11-20
 */
const keptStatesPerNfaState = 2

/**
 * The NFA states a matcher's cache is sized by: those of the NFA PostgreSQL would build of the pattern, the chain of
 * copies (nfa.ts configurationsOf), where it lies within PostgreSQL's compile space (ir.ts regexSpaceStates), as every
 * pattern grizzle admits does, so the host keeps as many states as PostgreSQL's executor would; and the automaton's
 * own states past it, where PostgreSQL builds no NFA and a chain of copies would be the product of the counts, so a
 * matcher of `((a{255}){255}){255}` keeps its few states' worth however long the text, and never one state for each
 * code point it read.
 */
const sizedStates = (nfa: Nfa): number => {
	const copies = configurationsOf(nfa)
	return copies <= regexSpaceStates ? copies : nfa.edges.length
}

/**
 * A state of a matcher's DFA: its subset, whether a text that ends there is a member, and its target on each atom, the
 * number of the state it leads to, or -1 where no text has read the atom there yet.
 */
interface DfaState {
	readonly subset: Subset
	readonly accepts: boolean
	readonly next: Int32Array
}

/**
 * A pattern's automaton as membership runs it: its NFA's search language determinized where texts reach it (subset.ts
 * SearchSubsets, the construction dfa.ts runs whole), each state and transition built the first time a text reaches it
 * and kept for every later text, so a pattern is compiled once, where its table holds it (patterns.ts, matcher.ts
 * ServedPatterns), and never per call.
 *
 * A text is read code point by code point, allocating nothing: each code point's atom by its segment of the alphabet,
 * and each step a lookup of the state's target, built where it is missing. So a text of n code points costs n steps,
 * and at most n transitions built, each charged its subset construction's work (Step), at most twice the
 * configurations its NFA's states take (nfa.ts configurationsOf), and twice its states where the text read fixes every
 * counter, as an anchored pattern of one way through does: its work is linear in the text whatever the pattern, which
 * no backtracking ever enters, and a counted repetition costs it a counter, never a copy of its body. A code point no admitted text
 * holds, a NUL or a lone surrogate, lies in no segment, and its text belongs to no refinement, since no PostgreSQL text
 * value spells it.
 */
export class Matcher {
	readonly nfa: Nfa
	readonly #subsets: SearchSubsets
	/** The most states the matcher keeps (keptStatesPerNfaState). */
	readonly #capacity: number
	/** Each segment of the alphabet's least and greatest code point, and its atom, in code point order. */
	readonly #segmentLows: Int32Array
	readonly #segmentHighs: Int32Array
	readonly #segmentAtoms: Int32Array
	/** The states kept, the initial one first, and each one's number by its subset (SubsetNumbers). */
	readonly #states: Array<DfaState> = []
	readonly #numbers = new SubsetNumbers()
	#spent: number

	private constructor(nfa: Nfa) {
		this.nfa = nfa
		this.#subsets = new SearchSubsets(nfa)
		this.#capacity = keptStatesPerNfaState * sizedStates(nfa)
		const { segments, atomOf } = this.#subsets.alphabet
		this.#segmentLows = Int32Array.from(segments, ([lo]) => lo)
		this.#segmentHighs = Int32Array.from(segments, ([, hi]) => hi)
		this.#segmentAtoms = atomOf
		this.#spent = this.#subsets.initial.work
		this.#numbered(this.#subsets.initial.to)
	}

	/** The matcher of an NFA, which holds no state but its initial one until a text reaches more. */
	static of(nfa: Nfa): Matcher {
		return new Matcher(nfa)
	}

	/**
	 * The work the matcher's subset construction was charged over every text it read, in NFA-state visits (Step): the
	 * initial subset's, and each transition's it built.
	 */
	get spent(): number {
		return this.#spent
	}

	/**
	 * What the matcher holds now: the DFA states it keeps and the configurations their subsets and the transitions built
	 * since its table last started over number, each bounded by the pattern whatever the texts it read (sizedStates).
	 */
	get held(): { readonly states: number; readonly configurations: number } {
		return { states: this.#states.length, configurations: this.#subsets.configurations }
	}

	/**
	 * Whether an admitted text value belongs to the pattern's language. A string that is not admitted text (it holds NUL
	 * or a lone surrogate) belongs to no refinement, because no PostgreSQL text value spells it.
	 */
	matches(value: string): boolean {
		let state = 0
		for (let i = 0; i < value.length;) {
			const point = codePointAt(value, i)
			const atom = this.#atomOf(point)
			if (atom === undefined) {
				return false
			}
			state = this.#step(state, atom)
			i += codePointUnits(point)
		}
		return entry(this.#states, state).accepts
	}

	/** The atom of a code point, by the segment that holds it; none for a code point no admitted text holds. */
	#atomOf(point: number): number | undefined {
		let lo = 0
		let hi = this.#segmentLows.length - 1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (point < entry(this.#segmentLows, mid)) {
				hi = mid - 1
			} else if (point > entry(this.#segmentHighs, mid)) {
				lo = mid + 1
			} else {
				return entry(this.#segmentAtoms, mid)
			}
		}
		return undefined
	}

	/**
	 * The state `state` leads to on `atom`: its kept target, or the target its subset construction reaches, charged its
	 * work and numbered. A row of a state the table forgot (#numbered) is no row of the table's, and goes with the state.
	 */
	#step(state: number, atom: number): number {
		const from = entry(this.#states, state)
		const known = entry(from.next, atom)
		if (known >= 0) {
			return known
		}
		const step = this.#subsets.target(from.subset, atom)
		this.#spent += step.work
		const target = this.#numbered(step.to)
		from.next[atom] = target
		return target
	}

	/**
	 * The number of a subset's state, a new one numbered where the table holds none of it. A table that keeps its
	 * capacity forgets every state first, and the configurations their subsets held (subset.ts SearchSubsets forget), and
	 * keeps its initial one, numbered 0 again, so a text starts there whatever texts came before it, and the
	 * configurations a counted repetition's counters reach never pile up past the states that hold them.
	 */
	#numbered(subset: Subset): number {
		const slot = this.#numbers.slot(subset)
		if (slot.number >= 0) {
			return slot.number
		}
		if (this.#states.length >= this.#capacity) {
			this.#states.length = 0
			this.#numbers.clear()
			const carried = this.#subsets.forget(subset)
			this.#numbered(this.#subsets.initial.to)
			return this.#numbered(carried)
		}
		const number = this.#states.length
		slot.number = number
		this.#states.push({
			subset,
			accepts: this.#subsets.acceptsAtEnd(subset),
			next: new Int32Array(this.#subsets.alphabet.atomCount).fill(-1)
		})
		return number
	}
}
