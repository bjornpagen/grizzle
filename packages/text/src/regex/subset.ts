import { TupleMap } from "#text/base/tuple-map.ts"
import { type CharSet, domain } from "#text/regex/charset.ts"
import { follow, type Nfa, type NfaEdge, scopesOf } from "#text/regex/nfa.ts"
import { type CharPartition, partitionOf } from "#text/regex/partition.ts"
import { cell, entry } from "#text/regex/table.ts"

/**
 * The subset construction of an NFA's search language, the one both of its readers run: dfa.ts determinizes it whole,
 * within bounds, for the compiler's language proofs, and match.ts Matcher determinizes it where texts reach it, for
 * membership.
 *
 * A pattern denotes the admitted texts in which a match exists, so the construction folds the search in: the NFA's start
 * state is re-entered at every position, `^` edges are followed only before the first code point, `$` edges only after
 * the last, and reaching the accept state before the end makes every extension a member (the absorbing state, done).
 *
 * Its elements are the NFA's configurations: a state and the counters of the repetitions around it (nfa.ts CountOp),
 * each the copy of the state a chain of copies would hold, numbered as the construction first meets them
 * (Configurations), so a subset is a set of numbers and every walk of it reads a configuration's successors once.
 * Every key the construction reads is an integer of a trie, never a text built of numbers: a configuration's number
 * (Config), the class a prune keeps one configuration of (Configurations pruned), and a subset's number, by the trie of
 * its configurations' numbers (SubsetNumbers).
 */

declare const configBrand: unique symbol

/** A configuration's number, minted where Configurations numbers a state under its counters, and nowhere else. */
export type Config = number & { readonly [configBrand]: true }

/** A number Configurations numbered, as the Config it is. Unchecked: each caller read it from Configurations' own tables. */
const numbered: (n: number) => asserts n is Config = () => undefined

/** The configuration a successor table holds at `i`, none where the edge's guard blocks it (-1). */
export const successorAt = (successors: Int32Array, i: number): Config | undefined => {
	const to = cell(successors, i)
	if (to < 0) {
		return undefined
	}
	numbered(to)
	return to
}

/** A set's bounds in order, each interval's low then high: equal exactly for two sets of the same intervals. */
const setBounds = (set: CharSet): ReadonlyArray<number> => set.flatMap(([lo, hi]) => [lo, hi])

/** A set edge of an NFA state: the position of its set among the distinct sets, and its place among the state's edges. */
interface SetEdge {
	readonly set: number
	readonly edge: number
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
		edges.flatMap((e, edge): ReadonlyArray<SetEdge> =>
			e.kind === "set" ? [{ set: positionOf(e.set), edge }] : []
		)
	)
	return { ...partitionOf(sets, domain), setEdges }
}

/** Which assertion edges a closure may follow. */
export interface Position {
	readonly atStart: boolean
	readonly atEnd: boolean
}

/** Whether a closure follows an edge at `position`: an ε edge always, `^` only at the start, `$` only at the end. */
const follows = (e: NfaEdge, position: Position): boolean =>
	e.kind === "eps" ||
	(e.kind === "start" && position.atStart) ||
	(e.kind === "end" && position.atEnd)

/**
 * The configurations of one state by their counters' values in order, the outermost's first: a node's number is the
 * configuration its path of values spells (-1 for none yet), and its children go on by the next counter's value.
 */
interface CounterTrie {
	number: number
	next: Map<number, CounterTrie> | undefined
}

/** The counters of a configuration outside every repetition. */
const noCounters: ReadonlyArray<number> = Object.freeze([])

/**
 * An NFA's configurations, numbered from 0 in the order they are met: each its state, its counters, and, once read, the
 * configuration each of its state's edges leads to (-1 where the edge's guard blocks it). A configuration is a copy of a
 * state of the chain of copies the counters stand for, so the configurations a closure or a step reaches are exactly
 * the states the copies would.
 */
export class Configurations {
	readonly nfa: Nfa
	#states: Array<number> = []
	#counters: Array<ReadonlyArray<number>> = []
	#successors: Array<Int32Array | undefined> = []
	/** Each state's configurations by their counters, outermost first, a trie of their values (CounterTrie). */
	#numbers: Array<CounterTrie | undefined> = []
	/** Scratch a closure marks its configurations in, by number, each closure under a fresh stamp. */
	#mark = new Int32Array(0)
	#stamp = 0

	/** Each state's counters of repetitions that count consuming iterations, by their places among its counters. */
	readonly #consuming: ReadonlyArray<ReadonlyArray<number>>
	/** Whether any repetition counts consuming iterations, so a prune can drop a configuration. */
	readonly #prunes: boolean
	/**
	 * Each configuration's prune keys, once read: for each counter of its state's that counts consuming iterations, the
	 * class a prune keeps one configuration of, then the iterations, in pairs (#pruneKeysOf).
	 */
	#pruneKeys: Array<Int32Array | undefined> = []
	/** The prune classes by state, then counter, a trie of the counters' values with that counter's iterations dropped. */
	#classes: Array<Array<CounterTrie | undefined> | undefined> = []
	#classCount = 0
	/** Each prune class's fewest iterations among the configurations of the prune under way, under its stamp. */
	#fewest = new Int32Array(0)
	#fewestStamp = new Int32Array(0)
	#pruneStamp = 0

	constructor(nfa: Nfa) {
		this.nfa = nfa
		this.#consuming = scopesOf(nfa).map(({ chain }) =>
			chain.flatMap((r, depth) => (entry(nfa.repeats, r).consuming ? [depth] : []))
		)
		this.#prunes = nfa.repeats.some((r) => r.consuming)
	}

	/**
	 * `configs` without each configuration another of them holds every future of: one at the same state, its counters
	 * alike but that of a repetition that counts consuming iterations, whose iterations are fewer under the same flag.
	 * Such a repetition has no least count (nfa.ts NfaRepeat), so fewer iterations leave every iteration more of them do,
	 * and the subset keeps its language, where its counters would otherwise hold one configuration for each count of
	 * consuming iterations a match under way has read, as the restart of the search at each code point makes. Of
	 * configurations that hold one another's futures the one of fewest iterations stays, so one stays at every state.
	 * Two configurations are of one class where they share a state, a counter that counts consuming iterations, and every
	 * counter's value but that one's iterations; the class is a number of a trie (#classOf), read once a configuration
	 * (#pruneKeysOf), so a prune is two passes of integers over the configurations, in their order.
	 */
	pruned(configs: ReadonlyArray<Config>): ReadonlyArray<Config> {
		if (!this.#prunes) {
			return configs
		}
		const keys = configs.map((c) => this.#pruneKeysOf(c))
		if (this.#fewest.length < this.#classCount) {
			const size = Math.max(this.#classCount, this.#fewest.length * 2)
			this.#fewest = new Int32Array(size)
			const stamps = new Int32Array(size)
			stamps.set(this.#fewestStamp)
			this.#fewestStamp = stamps
		}
		this.#pruneStamp += 1
		const stamp = this.#pruneStamp
		for (const k of keys) {
			for (let i = 0; i < k.length; i += 2) {
				const cls = cell(k, i)
				const iterations = cell(k, i + 1)
				if (cell(this.#fewestStamp, cls) !== stamp || iterations < cell(this.#fewest, cls)) {
					this.#fewestStamp[cls] = stamp
					this.#fewest[cls] = iterations
				}
			}
		}
		return configs.filter((_, j) => {
			const k = entry(keys, j)
			for (let i = 0; i < k.length; i += 2) {
				if (cell(this.#fewest, cell(k, i)) !== cell(k, i + 1)) {
					return false
				}
			}
			return true
		})
	}

	/** A configuration's prune keys (#pruneKeys), read the first time a prune meets it. */
	#pruneKeysOf(config: Config): Int32Array {
		const known = this.#pruneKeys[config]
		if (known !== undefined) {
			return known
		}
		const state = this.state(config)
		const counters = this.counters(config)
		const depths = entry(this.#consuming, state)
		const keys = new Int32Array(depths.length * 2)
		for (const [i, depth] of depths.entries()) {
			const value = entry(counters, depth)
			keys[2 * i] = this.#classOf(state, depth, counters, value % 2)
			keys[2 * i + 1] = Math.floor(value / 2)
		}
		this.#pruneKeys[config] = keys
		return keys
	}

	/** The prune class of a state's configuration under `counters`, the counter at `depth` holding its flag alone. */
	#classOf(state: number, depth: number, counters: ReadonlyArray<number>, flag: number): number {
		const byDepth = this.#classes[state] ?? []
		this.#classes[state] = byDepth
		let node = byDepth[depth] ?? { number: -1, next: undefined }
		byDepth[depth] = node
		for (const [i, value] of counters.entries()) {
			const key = i === depth ? flag : value
			node.next ??= new Map()
			let child = node.next.get(key)
			if (child === undefined) {
				child = { number: -1, next: undefined }
				node.next.set(key, child)
			}
			node = child
		}
		if (node.number < 0) {
			node.number = this.#classCount
			this.#classCount += 1
		}
		return node.number
	}

	/** How many configurations are numbered. */
	get size(): number {
		return this.#states.length
	}

	/** The number of the configuration of `state` under `counters`, numbered here where it is new. */
	number(state: number, counters: ReadonlyArray<number>): Config {
		let node = this.#numbers[state]
		if (node === undefined) {
			node = { number: -1, next: undefined }
			this.#numbers[state] = node
		}
		for (const value of counters) {
			node.next ??= new Map()
			let child = node.next.get(value)
			if (child === undefined) {
				child = { number: -1, next: undefined }
				node.next.set(value, child)
			}
			node = child
		}
		const known = node.number
		if (known >= 0) {
			numbered(known)
			return known
		}
		const number = this.#states.length
		node.number = number
		this.#states.push(state)
		this.#counters.push(counters)
		this.#successors.push(undefined)
		numbered(number)
		return number
	}

	/** The configuration of a state outside every repetition: the start state's and the accept state's. */
	plain(state: number): Config {
		return this.number(state, noCounters)
	}

	state(config: Config): number {
		return entry(this.#states, config)
	}

	counters(config: Config): ReadonlyArray<number> {
		return entry(this.#counters, config)
	}

	/** The configuration each edge of the configuration's state leads to, or -1 where the edge's guard blocks it. */
	successors(config: Config): Int32Array {
		const known = this.#successors[config]
		if (known !== undefined) {
			return known
		}
		const counters = this.counters(config)
		const edges = entry(this.nfa.edges, this.state(config))
		const out = new Int32Array(edges.length)
		for (const [i, e] of edges.entries()) {
			const moved = follow(this.nfa, counters, e.counts)
			out[i] = moved === undefined ? -1 : this.number(e.to, moved)
		}
		this.#successors[config] = out
		return out
	}

	/**
	 * The configurations reachable from `seeds` over ε edges and the assertions that hold at the position, each once, in
	 * the order a depth-first walk takes them.
	 */
	closure(seeds: Iterable<Config>, position: Position): Array<Config> {
		const stamp = this.#stamp++
		const out: Array<Config> = []
		const stack: Array<Config> = []
		const visit = (c: Config): void => {
			if (c >= this.#mark.length) {
				const grown = new Int32Array(Math.max(c + 1, this.#mark.length * 2)).fill(-1)
				grown.set(this.#mark)
				this.#mark = grown
			}
			if (this.#mark[c] !== stamp) {
				this.#mark[c] = stamp
				stack.push(c)
			}
		}
		for (const c of seeds) {
			visit(c)
		}
		for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
			out.push(c)
			const edges = entry(this.nfa.edges, this.state(c))
			const successors = this.successors(c)
			for (const [i, e] of edges.entries()) {
				const to = successorAt(successors, i)
				if (to !== undefined && follows(e, position)) {
					visit(to)
				}
			}
		}
		return out
	}

	/** Forgets every configuration: numbering starts over from 0, so a number read before means nothing after. */
	forget(): void {
		this.#states = []
		this.#counters = []
		this.#successors = []
		this.#numbers = []
		this.#pruneKeys = []
		this.#classes = []
		this.#classCount = 0
	}
}

/**
 * A state of the subset construction: the search's accepting sink, which every later input keeps once a match was
 * found, or a set of configurations with whether it is the initial one, whose closure at the end of the text reads the
 * start context.
 */
export type Subset =
	| { readonly kind: "done" }
	| { readonly kind: "set"; readonly configs: ReadonlyArray<Config>; readonly initial: boolean }

const done: Subset = { kind: "done" }

/** A subset's place in a reader's numbering (SubsetNumbers slot): its number, -1 before the reader numbers it. */
export interface SubsetSlot {
	number: number
}

/**
 * The numbers a reader gives the subsets it keeps, its states: two subsets of the same configurations, both initial or
 * neither, are one state. A subset's slot is found by its configurations' numbers in increasing order, a path of a trie
 * whose roots are the initial subsets' and the rest's, the sink's apart, so no key is built of its numbers.
 */
export class SubsetNumbers {
	#done: SubsetSlot = { number: -1 }
	#roots: { readonly initial: CounterTrie; readonly later: CounterTrie } = SubsetNumbers.#fresh()

	static #fresh(): { readonly initial: CounterTrie; readonly later: CounterTrie } {
		return { initial: { number: -1, next: undefined }, later: { number: -1, next: undefined } }
	}

	/** The slot of `subset`, made where it is new, its number -1 until the reader numbers it. */
	slot(subset: Subset): SubsetSlot {
		if (subset.kind === "done") {
			return this.#done
		}
		let node = subset.initial ? this.#roots.initial : this.#roots.later
		for (const config of Int32Array.from(subset.configs).toSorted()) {
			node.next ??= new Map()
			let child = node.next.get(config)
			if (child === undefined) {
				child = { number: -1, next: undefined }
				node.next.set(config, child)
			}
			node = child
		}
		return node
	}

	/** Forgets every subset's number, which a reader that renumbers its configurations reads anew. */
	clear(): void {
		this.#done = { number: -1 }
		this.#roots = SubsetNumbers.#fresh()
	}
}

/**
 * A subset the construction reached and the work it was charged, in configuration visits: a transition's, its source
 * subset's configurations, which it reads, and the configurations its closure reaches; the initial subset's, its
 * closure's configurations. A transition out of the sink reads nothing and is free.
 */
export interface Step {
	readonly to: Subset
	readonly work: number
}

/** The step out of the sink: the sink, and free. */
const sinkStep: Step = Object.freeze({ to: done, work: 0 })

/**
 * Every atom's step out of one subset (SearchSubsets targets): `steps`, each distinct, in the order of the atom each
 * first comes at, and `stepOf`, each atom's index among them.
 */
export interface Targets {
	readonly steps: ReadonlyArray<Step>
	readonly stepOf: Int32Array
}

/**
 * Where a search begins: the initial subset, the start state's closure before the first code point, and its work; and
 * the restart closure, the start state's past it, the configurations an atom no set edge of a subset holds reaches, as
 * a subset and as its configurations.
 */
interface Begun {
	readonly initial: Step
	readonly restartConfigs: ReadonlyArray<Config>
	readonly restart: Subset
}

/**
 * The subset construction over one NFA: its alphabet, its initial subset, and each subset's target on an atom, which a
 * reader interns as its own states. It keeps only what every transition reads, the configurations met (Configurations)
 * and the restart closure where an unanchored search begins again, so a transition costs about the work it is charged
 * (Step).
 */
export class SearchSubsets {
	readonly nfa: Nfa
	readonly alphabet: Alphabet
	readonly #configs: Configurations
	/** For each distinct set, whether it holds each atom (1) or not (0). */
	readonly #holds: ReadonlyArray<Uint8Array>
	/** Where the search begins, over the configurations numbered now (Begun). */
	#begun: Begun

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
		this.#configs = new Configurations(nfa)
		this.#begun = this.#begin()
	}

	/** The initial subset, the start state's closure before the first code point, and its work. */
	get initial(): Step {
		return this.#begun.initial
	}

	/** Where the search begins over the configurations numbered now: the initial subset and the restart closure. */
	#begin(): Begun {
		const start = this.#configs.plain(this.nfa.start)
		const initial = this.#configs.closure([start], { atStart: true, atEnd: false })
		const restartConfigs = this.#configs.pruned(
			this.#configs.closure([start], { atStart: false, atEnd: false })
		)
		return {
			initial: { to: this.#settle(this.#configs.pruned(initial), true), work: initial.length },
			restartConfigs,
			restart: this.#settle(restartConfigs, false)
		}
	}

	/** The configurations numbered so far, which a reader that keeps its subsets lets grow. */
	get configurations(): number {
		return this.#configs.size
	}

	/** The subset `configs` reach: the sink once they hold the NFA's accepting state. */
	#settle(configs: ReadonlyArray<Config>, initial: boolean): Subset {
		return configs.some((c) => this.#configs.state(c) === this.nfa.accept)
			? done
			: { kind: "set", configs, initial }
	}

	/**
	 * The subset `from` reaches on `atom`: the closure past a code point of the targets of its set edges that hold the
	 * atom (reach); and the sink from the sink. What membership reads, one atom at a time, where a text reaches it
	 * (match.ts Matcher).
	 */
	target(from: Subset, atom: number): Step {
		if (from.kind === "done") {
			return sinkStep
		}
		const targets: Array<Config> = []
		for (const c of from.configs) {
			const successors = this.#configs.successors(c)
			for (const edge of entry(this.alphabet.setEdges, this.#configs.state(c))) {
				const to = successorAt(successors, edge.edge)
				if (to !== undefined && entry(entry(this.#holds, edge.set), atom) === 1) {
					targets.push(to)
				}
			}
		}
		return this.#reach(from.configs, targets)
	}

	/**
	 * Every atom's target from `from`, each the Step target reaches on it: what the whole construction reads (dfa.ts
	 * determinize). The subset's set edges are walked once, each edge's target entered under every atom its set holds,
	 * and the atoms of one list of targets share one Step, its closure taken once, in the order of the atom it first
	 * comes at, so the configurations are numbered as target's walk of every atom in turn numbers them.
	 *
	 * target walks every set edge of the subset for each atom and closes over each atom's targets: O(k·(e + c)) for k
	 * atoms, e set edges of the subset's configurations and closures of c configurations, where most atoms of a pattern's
	 * alphabet hold no edge of a state and lead it to its restart closure. This is O(Σ atoms of the edges' sets + d·c) for
	 * the d distinct lists of targets, the restart's among them (dfa.ts determinize, its measurement).
	 */
	targets(from: Subset): Targets {
		const { atomCount, setAtoms, setEdges } = this.alphabet
		const stepOf = new Int32Array(atomCount)
		if (from.kind === "done") {
			return { steps: [sinkStep], stepOf }
		}
		/**
		 * The atoms by the set edges that hold them, refined one edge at a time (partition.ts partitionOf's refinement):
		 * each atom's group, a group's targets its parent's and the target of the edge that opened it, group 0 every
		 * atom's before the first edge, of no target. Two atoms of one group are held by the same edges, so they reach the
		 * same targets in the same order.
		 */
		const groupOf = new Int32Array(atomCount)
		const parent: Array<number> = [-1]
		const opener: Array<Config | undefined> = [undefined]
		const openedIn: Array<number> = [-1]
		const openedAs: Array<number> = [-1]
		let round = 0
		for (const c of from.configs) {
			const successors = this.#configs.successors(c)
			for (const edge of entry(setEdges, this.#configs.state(c))) {
				const to = successorAt(successors, edge.edge)
				if (to !== undefined) {
					for (const atom of entry(setAtoms, edge.set)) {
						const group = cell(groupOf, atom)
						if (openedIn[group] !== round) {
							openedIn[group] = round
							openedAs[group] = parent.length
							parent.push(group)
							opener.push(to)
							openedIn.push(-1)
							openedAs.push(-1)
						}
						groupOf[atom] = entry(openedAs, group)
					}
					round += 1
				}
			}
		}
		/** Each group's step, by its index among `steps`; -1 before an atom of it is met. */
		const stepOfGroup = new Int32Array(parent.length).fill(-1)
		const steps: Array<Step> = []
		for (let atom = 0; atom < atomCount; atom++) {
			const group = cell(groupOf, atom)
			const known = cell(stepOfGroup, group)
			if (known >= 0) {
				stepOf[atom] = known
			} else {
				const targets: Array<Config> = []
				for (let g = group; g > 0; g = entry(parent, g)) {
					const to = entry(opener, g)
					if (to !== undefined) {
						targets.push(to)
					}
				}
				stepOfGroup[group] = steps.length
				stepOf[atom] = steps.length
				steps.push(this.#reach(from.configs, targets.toReversed()))
			}
		}
		return { steps, stepOf }
	}

	/**
	 * The Step out of the configurations `from` to the closure past a code point of `targets`, the start state among
	 * them, where the search begins again; the restart closure where there is no target.
	 */
	#reach(from: ReadonlyArray<Config>, targets: ReadonlyArray<Config>): Step {
		if (targets.length === 0) {
			const { restart, restartConfigs } = this.#begun
			return { to: restart, work: from.length + restartConfigs.length }
		}
		const reached = this.#configs.closure([this.#configs.plain(this.nfa.start), ...targets], {
			atStart: false,
			atEnd: false
		})
		return {
			to: this.#settle(this.#configs.pruned(reached), false),
			work: from.length + reached.length
		}
	}

	/** Whether a text whose code points led to `subset` is a member: its closure at the end holds the accept state. */
	acceptsAtEnd(subset: Subset): boolean {
		return (
			subset.kind === "done" ||
			this.#configs
				.closure(subset.configs, { atStart: subset.initial, atEnd: true })
				.some((c) => this.#configs.state(c) === this.nfa.accept)
		)
	}

	/**
	 * Forgets every configuration but those of `kept`, which a reader that drops its subsets keeps, renumbered: the
	 * initial subset and the restart closure are computed again, and `kept` comes back over the new numbers. A subset
	 * read before means nothing after.
	 */
	forget(kept: Subset): Subset {
		const carried =
			kept.kind === "done"
				? []
				: kept.configs.map((c) => [this.#configs.state(c), this.#configs.counters(c)] as const)
		this.#configs.forget()
		this.#begun = this.#begin()
		return kept.kind === "done"
			? done
			: {
					kind: "set",
					configs: carried.map(([state, counters]) => this.#configs.number(state, counters)),
					initial: kept.initial
				}
	}
}
