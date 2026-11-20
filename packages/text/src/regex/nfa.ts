import { defined } from "#text/base/invariant.ts"
import type { CharSet } from "#text/regex/charset.ts"
import { RegexBuilder, type RegexNode } from "#text/regex/ir.ts"
import { entry } from "#text/regex/table.ts"

/**
 * An automaton's form, as buildNfa makes it and a load rebuilds it from the integers a served file carries (matcher.ts
 * ServedMatcher), which its readers run with no regex IR: its subset construction (subset.ts), whole for the compiler's
 * language proofs (dfa.ts) and where texts reach it for membership (match.ts Matcher).
 *
 * A counted repetition is one copy of its body and a counter, never a copy of the body for each count: a state inside
 * repetitions stands for one copy of itself for each value of their counters, its configurations (subset.ts), and an
 * edge's operations (CountOp) move the counters as the edges between the copies would. So the automaton holds as many
 * states as the IR has positions, whatever its counts, and `((a{255}){255}){255}` is a handful of states and three
 * counters where a chain of copies would be 16,581,375 states.
 */

/**
 * An operation of an edge on the counters of the repetitions around its states, each counter the iterations its
 * repetition finished in the copy a configuration stands for, outermost first (subset.ts). An edge applies its
 * operations in order, and one whose guard fails blocks it:
 * - enter: the edge enters the repetition, whose counter goes on top at 0;
 * - again: the edge begins an iteration, so the top counter is below the repetition's copies;
 * - consumed: the edge consumes a code point inside an iteration of the repetition whose counter is `below` counters
 *   under the top, which a repetition that counts only consuming iterations reads (NfaRepeat consuming);
 * - counted: the edge ends an iteration, the top counter one more, and for a repetition that counts only consuming
 *   iterations only where the iteration consumed;
 * - loop: the edge goes back over an unbounded repetition's last copy, its top counter at its copies, then one less;
 * - leave: the edge leaves the repetition, its top counter at least its least count, then taken off.
 */
export type CountOp =
	| { readonly kind: "enter" | "again" | "counted" | "loop" | "leave"; readonly repeat: number }
	| { readonly kind: "consumed"; readonly repeat: number; readonly below: number }

export type NfaEdge =
	| { readonly kind: "eps"; readonly to: number; readonly counts: ReadonlyArray<CountOp> }
	| { readonly kind: "start"; readonly to: number; readonly counts: ReadonlyArray<CountOp> }
	| { readonly kind: "end"; readonly to: number; readonly counts: ReadonlyArray<CountOp> }
	| {
			readonly kind: "set"
			readonly set: CharSet
			readonly to: number
			readonly counts: ReadonlyArray<CountOp>
	  }

/**
 * A counted repetition of an automaton: the copies of its body its counter ranges over, the iterations after which it
 * may be left, whether its last copy loops (an unbounded repetition), and whether it counts an iteration only once the
 * iteration consumes a code point.
 *
 * A repetition `x{m,n}` writes n copies of x, and `x{m,}` max(m, 1) copies and a loop back over the last; it is left
 * after m iterations or more. A body that matches the empty string through no assertion is the exception: an empty
 * iteration can stand anywhere among the others, so `x{m,n}` holds exactly the words of 0 to n consuming iterations,
 * and the repetition counts only those, from 0 (`x{0,n}`'s copies, and one for an unbounded one). Its counter never
 * moves without a code point, so a configuration's counter is never more than the code points its text consumed, and
 * a closure never walks a count of empty iterations, which `(a?){1000000000}` would make it do.
 */
export interface NfaRepeat {
	readonly least: number
	readonly copies: number
	readonly loops: boolean
	readonly consuming: boolean
}

export interface Nfa {
	readonly start: number
	readonly accept: number
	/** Outgoing edges of each state. */
	readonly edges: ReadonlyArray<ReadonlyArray<NfaEdge>>
	/** Each counted repetition, by the number its edges' operations name. */
	readonly repeats: ReadonlyArray<NfaRepeat>
}

/** The edges that move no counter: an edge's operations where it has none. */
const noCounts: ReadonlyArray<CountOp> = Object.freeze([])

/** The iterations a repetition's counter value states: a consuming repetition's holds a flag in its low digit. */
const iterationsOf = (repeat: NfaRepeat, value: number): number =>
	repeat.consuming ? Math.floor(value / 2) : value

/** The counter value of `iterations` iterations, none of the next one consumed. */
const valueOf = (repeat: NfaRepeat, iterations: number): number =>
	repeat.consuming ? iterations * 2 : iterations

/**
 * The counters an edge's operations leave of `counters`, or undefined where one of its guards fails: the same array
 * where the edge moves no counter. A consuming repetition's counter is twice its iterations and 1 once the iteration it
 * is in consumed a code point (iterationsOf).
 */
export const follow = (
	nfa: Nfa,
	counters: ReadonlyArray<number>,
	counts: ReadonlyArray<CountOp>
): ReadonlyArray<number> | undefined => {
	let values = counters
	for (const op of counts) {
		if (op.kind === "enter") {
			values = values.concat(0)
			continue
		}
		const repeat = entry(nfa.repeats, op.repeat)
		const at = values.length - 1 - (op.kind === "consumed" ? op.below : 0)
		const value = entry(values, at)
		const iterations = iterationsOf(repeat, value)
		switch (op.kind) {
			case "again":
				if (iterations >= repeat.copies) {
					return undefined
				}
				break
			case "consumed":
				values = values.with(at, valueOf(repeat, iterations) + 1)
				break
			case "counted":
				if (repeat.consuming && value === valueOf(repeat, iterations)) {
					return undefined
				}
				values = values.with(at, valueOf(repeat, iterations + 1))
				break
			case "loop":
				if (iterations !== repeat.copies) {
					return undefined
				}
				values = values.with(at, valueOf(repeat, iterations - 1))
				break
			case "leave":
				if (iterations < repeat.least) {
					return undefined
				}
				values = values.slice(0, -1)
				break
		}
	}
	return values
}

/**
 * Where a state stands among an automaton's repetitions: the repetitions around it, outermost first, whose counters
 * its configurations hold in that order, and whether it is the innermost one's own state, where an edge that enters
 * the repetition, counts an iteration or loops leads, as against a state of its body.
 */
export interface Scope {
	readonly chain: ReadonlyArray<number>
	readonly own: boolean
}

/**
 * The scope of a state no walk from the start state reaches, the accepting state of the empty language's automaton:
 * no configuration holds it, so it counts none.
 */
const unreached: Scope = Object.freeze({ chain: Object.freeze([]), own: false })

/** Each state's scope, read off the edges' operations by a walk from the start state. */
export const scopesOf = (nfa: Nfa): ReadonlyArray<Scope> => {
	const around: Array<Scope | undefined> = nfa.edges.map(() => undefined)
	around[nfa.start] = { chain: [], own: false }
	const stack: Array<number> = [nfa.start]
	for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
		const { chain } = defined(around[s], "the scope of a state the walk reached")
		for (const e of entry(nfa.edges, s)) {
			if (around[e.to] !== undefined) {
				continue
			}
			const last = e.counts.at(-1)?.kind
			around[e.to] = {
				chain: e.counts.reduce<ReadonlyArray<number>>(
					(outer, op) =>
						op.kind === "enter"
							? outer.concat(op.repeat)
							: op.kind === "leave"
								? outer.slice(0, -1)
								: outer,
					chain
				),
				own: last === "enter" || last === "counted" || last === "loop"
			}
			stack.push(e.to)
		}
	}
	return around.map((scope) => scope ?? unreached)
}

/**
 * How many configurations an automaton's states can take, exactly the states a chain of copies would hold, which
 * PostgreSQL's NFA of the pattern holds: for each state, the product of the values the counter of each repetition
 * around it holds there (scopesOf), its copies and one at the repetition's own state, its copies inside its body, and
 * twice them for a repetition that counts consuming iterations, whose counter holds a flag there (follow). No subset
 * of the subset construction holds more configurations (subset.ts), and it is the automaton's states wherever no
 * repetition is counted.
 */
export const configurationsOf = (nfa: Nfa): number =>
	scopesOf(nfa).reduce<number>(
		(total, { chain, own }) =>
			total +
			chain.reduce((product, r, depth) => {
				const repeat = entry(nfa.repeats, r)
				return depth === chain.length - 1 && own
					? product * (repeat.copies + 1)
					: product * repeat.copies * (repeat.consuming ? 2 : 1)
			}, 1),
		0
	)

/** A state the builder allocated: its number and its outgoing edges, which the builder fills. */
interface State {
	readonly id: number
	readonly edges: Array<NfaEdge>
}

/**
 * One end of a construction: its state, and the operations an edge applies leaving it (a construction's `from`) or
 * entering it (its `to`): an iteration's again where it leaves a repetition's state into its body, and its counted
 * where it comes back.
 */
interface End {
	readonly state: State
	readonly counts: ReadonlyArray<CountOp>
}

/** The repetitions around a construction, innermost first: each one's number and whether it counts consuming iterations. */
type Around =
	| { readonly repeat: number; readonly consuming: boolean; readonly outer: Around }
	| undefined

type Seq = Extract<RegexNode, { readonly kind: "seq" }>

/**
 * The builder's work, on its explicit stack: the paths of a node between two ends inside the repetitions of `scope`,
 * or a sequence going on from the part it has built, whose `item` is the next item, which starts at `at`.
 */
type Task =
	| {
			readonly kind: "build"
			readonly node: RegexNode
			readonly from: End
			readonly to: End
			readonly scope: Around
	  }
	| {
			readonly kind: "item"
			readonly node: Seq
			readonly item: number
			readonly at: End
			readonly to: End
			readonly scope: Around
	  }

/** An end of a construction at a state the builder allocated inside it, which no edge's operations name. */
const inner = (state: State): End => ({ state, counts: noCounts })

class Builder {
	readonly states: Array<State> = []
	readonly repeats: Array<NfaRepeat> = []
	readonly #ir = new RegexBuilder()

	fresh(): State {
		const state: State = { id: this.states.length, edges: [] }
		this.states.push(state)
		return state
	}

	/**
	 * An edge from `from` to `to`: its operations are those leaving `from`, its own (`own`), and those entering `to`, in
	 * that order.
	 */
	edge(
		from: End,
		to: End,
		own: ReadonlyArray<CountOp>,
		make: (to: number, counts: ReadonlyArray<CountOp>) => NfaEdge
	): void {
		const counts =
			from.counts.length === 0 && own.length === 0 && to.counts.length === 0
				? noCounts
				: Object.freeze([...from.counts, ...own, ...to.counts])
		from.state.edges.push(make(to.state.id, counts))
	}

	/**
	 * Adds the paths of `node` from `from` to `to`. It adds edges only out of `from`, into `to`, and among states it
	 * allocates, so sibling constructions that share `from` or `to` never enter each other's interiors. Its work is a
	 * stack of tasks, so a node of any depth builds without recursing; a sequence allocates the state after each part
	 * just before it builds that part, and every part is built whole before the next begins, so the states and edges
	 * come in the order a recursive construction makes them.
	 */
	build(node: RegexNode, from: End, to: End): void {
		const tasks: Array<Task> = [{ kind: "build", node, from, to, scope: undefined }]
		for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
			switch (task.kind) {
				case "build":
					this.#start(task.node, task.from, task.to, task.scope, tasks)
					break
				case "item":
					this.#item(task.node, task.item, task.at, task.to, task.scope, tasks)
					break
			}
		}
	}

	/** Begins the paths of `node` from `from` to `to`: a leaf's edge, or the tasks its parts need. */
	#start(node: RegexNode, from: End, to: End, scope: Around, tasks: Array<Task>): void {
		switch (node.kind) {
			case "empty":
				this.edge(from, to, noCounts, (t, counts) => ({ kind: "eps", to: t, counts }))
				return
			case "never":
				return
			case "set":
				this.edge(from, to, consumedIn(scope), (t, counts) => ({
					kind: "set",
					set: node.set,
					to: t,
					counts
				}))
				return
			case "start":
				this.edge(from, to, noCounts, (t, counts) => ({ kind: "start", to: t, counts }))
				return
			case "end":
				this.edge(from, to, noCounts, (t, counts) => ({ kind: "end", to: t, counts }))
				return
			case "seq":
				tasks.push({ kind: "item", node, item: 0, at: from, to, scope })
				return
			case "alt":
				for (const arm of node.arms.toReversed()) {
					tasks.push({ kind: "build", node: arm, from, to, scope })
				}
				return
			case "repeat": {
				/**
				 * One fresh state, the copies' chain: entered with its counter at 0, its body built once from it back to it,
				 * an iteration beginning only below the copies and counting one where it comes back, left at the least count
				 * or more, and an unbounded one looping back from its last copy (NfaRepeat).
				 */
				const consuming = this.#ir.matchesEmpty(node.body)
				const least = consuming ? 0 : node.min
				const loops = node.max === "unbounded"
				const repeat = this.repeats.length
				this.repeats.push(
					Object.freeze({
						least,
						copies: node.max === "unbounded" ? Math.max(least, 1) : node.max,
						loops,
						consuming
					})
				)
				const chain = this.fresh()
				const op = (kind: "enter" | "again" | "counted" | "loop" | "leave"): End => ({
					state: chain,
					counts: Object.freeze([{ kind, repeat }])
				})
				this.edge(from, op("enter"), noCounts, (t, counts) => ({ kind: "eps", to: t, counts }))
				this.edge(op("leave"), to, noCounts, (t, counts) => ({ kind: "eps", to: t, counts }))
				if (loops) {
					this.edge(op("loop"), inner(chain), noCounts, (t, counts) => ({
						kind: "eps",
						to: t,
						counts
					}))
				}
				tasks.push({
					kind: "build",
					node: node.body,
					from: op("again"),
					to: op("counted"),
					scope: { repeat, consuming, outer: scope }
				})
				return
			}
		}
	}

	/** Builds a sequence's item from `at`, into a fresh state or, for the last item, into `to`, and then the rest. */
	#item(node: Seq, item: number, at: End, to: End, scope: Around, tasks: Array<Task>): void {
		const last = item === node.items.length - 1
		const next = last ? to : inner(this.fresh())
		if (!last) {
			tasks.push({ kind: "item", node, item: item + 1, at: next, to, scope })
		}
		tasks.push({ kind: "build", node: entry(node.items, item), from: at, to: next, scope })
	}
}

/** The consumed operations a set edge inside `scope` applies: one for each repetition that counts consuming iterations. */
const consumedIn = (scope: Around): ReadonlyArray<CountOp> => {
	const out: Array<CountOp> = []
	let below = 0
	for (let s = scope; s !== undefined; s = s.outer) {
		if (s.consuming) {
			out.push({ kind: "consumed", repeat: s.repeat, below })
		}
		below += 1
	}
	return out.length === 0 ? noCounts : Object.freeze(out)
}

/**
 * A pure Thompson NFA over the regex IR, with a counter for each counted repetition (CountOp), whose search language
 * its readers determinize (subset.ts).
 *
 * The host evaluates regex membership where the compiler decides a constant (a literal written in a description against
 * its field's refinement, ContractLiteral, and the finite and tautology proofs of dfa.ts) and where it evaluates a row:
 * a value's domain and a Text.matches, in a write's fill and its witness, a preview and rowEvaluator (match.ts
 * Matcher). It never builds a JavaScript RegExp.
 *
 * Membership is ECMAScript's RegExp.prototype.test without the `g`, `y` and `m` flags: whether a match exists starting
 * at any position. `^` holds only at offset 0 and `$` only at the end of the value. The search re-enters the start state
 * at every position and accepts as soon as the accept state is reached, which is exactly the existence question; match
 * preference, which differs between ECMAScript and PostgreSQL, never enters.
 */
export const buildNfa = (node: RegexNode): Nfa => {
	const builder = new Builder()
	const start = builder.fresh()
	const accept = builder.fresh()
	builder.build(node, inner(start), inner(accept))
	return {
		start: start.id,
		accept: accept.id,
		edges: builder.states.map((s) => s.edges),
		repeats: builder.repeats
	}
}
