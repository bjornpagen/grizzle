import { codePoints } from "#compiler/core/text.ts"
import { type CharSet, has, isAdmittedCodePoint } from "#compiler/scalar/regex/charset.ts"
import { copiesOf, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

type NfaEdge =
	| { readonly kind: "eps"; readonly to: number }
	| { readonly kind: "start"; readonly to: number }
	| { readonly kind: "end"; readonly to: number }
	| { readonly kind: "set"; readonly set: CharSet; readonly to: number }

export interface Nfa {
	readonly start: number
	readonly accept: number
	/** Outgoing edges of each state. */
	readonly edges: ReadonlyArray<ReadonlyArray<NfaEdge>>
}

/** A state the builder allocated: its number and its outgoing edges, which the builder fills. */
interface State {
	readonly id: number
	readonly edges: Array<NfaEdge>
}

type Seq = Extract<RegexNode, { readonly kind: "seq" }>
type Repeat = Extract<RegexNode, { readonly kind: "repeat" }>

/**
 * The builder's work, on its explicit stack: the paths of a node between two states, or a sequence or repetition
 * going on from the part it has built. A sequence's `item` is the next item, which starts at `at`; a repetition's
 * `chain` holds its states q0 .. qk once k copies are built.
 */
type Task =
	| { readonly kind: "build"; readonly node: RegexNode; readonly from: State; readonly to: State }
	| {
			readonly kind: "item"
			readonly node: Seq
			readonly item: number
			readonly at: State
			readonly to: State
	  }
	| {
			readonly kind: "copy"
			readonly node: Repeat
			readonly chain: Array<State>
			readonly to: State
	  }

class Builder {
	readonly states: Array<State> = []

	fresh(): State {
		const state: State = { id: this.states.length, edges: [] }
		this.states.push(state)
		return state
	}

	edge(from: State, edge: NfaEdge): void {
		from.edges.push(edge)
	}

	/**
	 * Adds the paths of `node` from `from` to `to`. It adds edges only out of `from`, into `to`, and among states it
	 * allocates, so sibling constructions that share `from` or `to` never enter each other's interiors. Its work is a
	 * stack of tasks, so a node of any depth builds without recursing; a sequence and a repetition allocate the state
	 * after each part just before they build that part, and every part is built whole before the next begins, so the
	 * states and edges come in the order a recursive construction makes them.
	 */
	build(node: RegexNode, from: State, to: State): void {
		const tasks: Array<Task> = [{ kind: "build", node, from, to }]
		for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
			switch (task.kind) {
				case "build":
					this.#start(task.node, task.from, task.to, tasks)
					break
				case "item":
					this.#item(task.node, task.item, task.at, task.to, tasks)
					break
				case "copy":
					this.#copy(task.node, task.chain, task.to, tasks)
					break
			}
		}
	}

	/** Begins the paths of `node` from `from` to `to`: a leaf's edge, or the tasks its parts need. */
	#start(node: RegexNode, from: State, to: State, tasks: Array<Task>): void {
		switch (node.kind) {
			case "empty":
				this.edge(from, { kind: "eps", to: to.id })
				return
			case "never":
				return
			case "set":
				this.edge(from, { kind: "set", set: node.set, to: to.id })
				return
			case "start":
				this.edge(from, { kind: "start", to: to.id })
				return
			case "end":
				this.edge(from, { kind: "end", to: to.id })
				return
			case "seq":
				tasks.push({ kind: "item", node, item: 0, at: from, to })
				return
			case "alt":
				for (const arm of node.arms.toReversed()) {
					tasks.push({ kind: "build", node: arm, from, to })
				}
				return
			case "repeat": {
				/**
				 * q0 .. qn are fresh: n copies of the body in a chain, with an exit after each copy at or above the
				 * minimum. An unbounded repetition writes max(min, 1) copies and loops back over the last one.
				 */
				const first = this.fresh()
				this.edge(from, { kind: "eps", to: first.id })
				tasks.push({ kind: "copy", node, chain: [first], to })
				return
			}
		}
	}

	/** Builds a sequence's item from `at`, into a fresh state or, for the last item, into `to`, and then the rest. */
	#item(node: Seq, item: number, at: State, to: State, tasks: Array<Task>): void {
		const last = item === node.items.length - 1
		const next = last ? to : this.fresh()
		if (!last) {
			tasks.push({ kind: "item", node, item: item + 1, at: next, to })
		}
		tasks.push({ kind: "build", node: entry(node.items, item), from: at, to: next })
	}

	/** Builds a repetition's next copy at the end of its chain, or, once every copy is built, its exits and loop. */
	#copy(node: Repeat, chain: Array<State>, to: State, tasks: Array<Task>): void {
		const built = chain.length - 1
		const copies = copiesOf(node)
		const at = entry(chain, built)
		if (built < copies) {
			const next = this.fresh()
			chain.push(next)
			tasks.push({ kind: "copy", node, chain, to })
			tasks.push({ kind: "build", node: node.body, from: at, to: next })
			return
		}
		for (const exit of chain.slice(node.min)) {
			this.edge(exit, { kind: "eps", to: to.id })
		}
		if (node.max === "unbounded") {
			this.edge(at, { kind: "eps", to: entry(chain, built - 1).id })
		}
	}
}

/**
 * A pure Thompson NFA over the regex IR, and membership by simulation.
 *
 * The host evaluates regex membership only where the compiler must decide a constant: a literal written in a
 * description against its field's refinement (ContractLiteral) and the finite and tautology proofs of
 * dfa.ts. It never validates application values, which PostgreSQL alone does, and it never builds a
 * JavaScript RegExp.
 *
 * Membership is ECMAScript's RegExp.prototype.test without the `g`, `y` and `m` flags: whether a match exists starting
 * at any position. `^` holds only at offset 0 and `$` only at the end of the value. The simulation adds
 * the start state at every position and accepts as soon as the accept state is reached, which is exactly the existence
 * question; match preference, which differs between ECMAScript and PostgreSQL, never enters.
 */
export const buildNfa = (node: RegexNode): Nfa => {
	const builder = new Builder()
	const start = builder.fresh()
	const accept = builder.fresh()
	builder.build(node, start, accept)
	return { start: start.id, accept: accept.id, edges: builder.states.map((s) => s.edges) }
}

/** Which assertion edges a closure may follow. */
interface Position {
	readonly atStart: boolean
	readonly atEnd: boolean
}

/** Whether a closure follows an edge at `position`: an ε edge always, `^` only at the start, `$` only at the end. */
const follows = (e: NfaEdge, position: Position): boolean =>
	e.kind === "eps" ||
	(e.kind === "start" && position.atStart) ||
	(e.kind === "end" && position.atEnd)

/** The states a state's set edges admitting code point `c` lead to. */
const stepsOn = (nfa: Nfa, s: number, c: number): ReadonlyArray<number> =>
	entry(nfa.edges, s).flatMap((e) => (e.kind === "set" && has(e.set, c) ? [e.to] : []))

/**
 * The states reachable from `seeds` over ε edges and the assertions that hold at the position. `mark` is scratch space
 * of the NFA's size; `stamp` is fresh for each call.
 */
export const closure = (
	nfa: Nfa,
	seeds: Iterable<number>,
	position: Position,
	mark: Int32Array,
	stamp: number
): Array<number> => {
	const out: Array<number> = []
	const stack: Array<number> = []
	const visit = (s: number): void => {
		if (mark[s] !== stamp) {
			mark[s] = stamp
			stack.push(s)
		}
	}
	for (const s of seeds) {
		visit(s)
	}
	for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
		out.push(s)
		for (const e of entry(nfa.edges, s)) {
			if (follows(e, position)) {
				visit(e.to)
			}
		}
	}
	return out
}

/**
 * The states reachable from `s` over ε and assertion edges, `s` included, counted up to `limit` + 1. `mark` is scratch
 * space of the NFA's size, holding `s` for each state this count has reached.
 */
const reachCount = (nfa: Nfa, s: number, mark: Int32Array, limit: number): number => {
	const stack = [s]
	mark[s] = s
	const visit = (to: number): void => {
		if (mark[to] !== s) {
			mark[to] = s
			stack.push(to)
		}
	}
	let count = 0
	for (let x = stack.pop(); x !== undefined && count <= limit; x = stack.pop()) {
		count += 1
		for (const e of entry(nfa.edges, x)) {
			if (e.kind !== "set") {
				visit(e.to)
			}
		}
	}
	return count
}

/**
 * The number of (state, state) pairs joined by a path of ε and assertion edges, counting each state with itself,
 * or `cap + 1` as soon as the count passes `cap`. PostgreSQL's regex compiler removes empty arcs by copying, into every
 * state, the arcs of each state its empty arcs reach (regc_nfa.c fixempties), so its compile space grows with this
 * count: a chain of k optional copies, such as `(?:a?){k}`, costs about k²/2.
 */
export const closurePairs = (nfa: Nfa, cap: number): number => {
	const mark = new Int32Array(nfa.edges.length).fill(-1)
	let total = 0
	for (let s = 0; s < nfa.edges.length && total <= cap; s++) {
		total += reachCount(nfa, s, mark, cap - total)
	}
	return total
}

/** The code points of an admitted text value, or undefined when it is not one (NUL or a lone surrogate). */
const admittedCodePoints = (value: string): ReadonlyArray<number> | undefined => {
	const points = codePoints(value)
	return points.every((c) => isAdmittedCodePoint(c)) ? points : undefined
}

/** Whether a match exists in the code point sequence. */
const matchesCodePoints = (nfa: Nfa, cps: ReadonlyArray<number>): boolean => {
	const mark = new Int32Array(nfa.edges.length).fill(-1)
	let stamp = 0
	const n = cps.length
	let current = closure(nfa, [nfa.start], { atStart: true, atEnd: n === 0 }, mark, stamp++)
	if (current.includes(nfa.accept)) {
		return true
	}
	for (const [i, c] of cps.entries()) {
		const next = [...current.flatMap((s) => stepsOn(nfa, s, c)), nfa.start]
		current = closure(nfa, next, { atStart: false, atEnd: i + 1 === n }, mark, stamp++)
		if (current.includes(nfa.accept)) {
			return true
		}
	}
	return false
}

/**
 * Whether an admitted text value belongs to the pattern's language. A string that is not admitted text (it holds NUL
 * or a lone surrogate) belongs to no refinement, because no PostgreSQL text value spells it.
 */
export const matches = (nfa: Nfa, value: string): boolean => {
	const cps = admittedCodePoints(value)
	return cps !== undefined && matchesCodePoints(nfa, cps)
}
