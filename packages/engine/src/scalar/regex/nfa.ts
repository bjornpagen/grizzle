import { copiesOf, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import type { Nfa, NfaEdge } from "#compiler/scalar/regex/match.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

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
