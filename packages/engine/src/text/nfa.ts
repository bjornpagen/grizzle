import { codePoints } from "#compiler/core/text.ts"
import { type CharSet, has, isAdmittedCodePoint } from "#compiler/text/charset.ts"
import { copiesOf, type RegexNode } from "#compiler/text/ir.ts"
import { entry } from "#compiler/text/table.ts"

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
	 * allocates, so sibling constructions that share `from` or `to` never enter each other's interiors.
	 */
	build(node: RegexNode, from: State, to: State): void {
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
			case "seq": {
				let at = from
				for (const [i, item] of node.items.entries()) {
					const next = i === node.items.length - 1 ? to : this.fresh()
					this.build(item, at, next)
					at = next
				}
				return
			}
			case "alt":
				for (const arm of node.arms) {
					this.build(arm, from, to)
				}
				return
			case "repeat": {
				/**
				 * q0 .. qn are fresh: n copies of the body in a chain, with an exit after each copy at or above the
				 * minimum. An unbounded repetition writes max(min, 1) copies and loops back over the last one.
				 */
				const copies = copiesOf(node)
				const first = this.fresh()
				const q: Array<State> = [first]
				this.edge(from, { kind: "eps", to: first.id })
				/** The last state of the chain, and the one before it. */
				let before = first
				let at = first
				for (let i = 0; i < copies; i++) {
					const next = this.fresh()
					q.push(next)
					this.build(node.body, at, next)
					before = at
					at = next
				}
				for (const exit of q.slice(node.min)) {
					this.edge(exit, { kind: "eps", to: to.id })
				}
				if (node.max === "unbounded") {
					this.edge(at, { kind: "eps", to: before.id })
				}
				return
			}
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
