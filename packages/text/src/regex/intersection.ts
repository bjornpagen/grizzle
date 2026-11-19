import { defined } from "#text/base/invariant.ts"
import * as Result from "#text/base/result.ts"
import { type CharSet, intersection, size } from "#text/regex/charset.ts"
import { type CanonicalDfa, type DfaBounded, type DfaLimits, minimalDfa } from "#text/regex/dfa.ts"
import { alphabetOf, assertsAnywhere, mapSets } from "#text/regex/folds.ts"
import {
	empty,
	end,
	folded,
	type LiveNode,
	never,
	RegexBuilder,
	type RegexNode,
	seq,
	set,
	start
} from "#text/regex/ir.ts"
import { buildNfa } from "#text/regex/nfa.ts"

/**
 * The intersection of two languages of whole texts as one node, exactly: both narrowed to the code points both may hold,
 * then the first read through the second's minimal DFA (`tracked`), its own shape kept, so a domain's facets compose
 * into the one pattern its domain stores. pantry's grammar/domains.ts intersectTwo and tracked (UNIFY's op 3) on the
 * one IR. It is refused, never approximated, where the second's DFA passes `limits`, or where either node tests an
 * assertion, since a language of whole texts tests none.
 */

/** Why an intersection is refused: an assertion in a node, or the bound the second's DFA passed. */
export type IntersectionRefusal = { readonly kind: "assertion" } | DfaBounded

/** A subtree's words read from one state of the automaton, by the state each leads to. */
type Reads = ReadonlyMap<number, RegexNode>

/** `piece` joined to the words already leading to `to`, unless it holds none. */
const joinAt = (
	builder: RegexBuilder,
	into: Map<number, RegexNode>,
	to: number,
	piece: RegexNode
): void => {
	if (piece.kind === "never") {
		return
	}
	const before = into.get(to)
	into.set(to, before === undefined ? piece : builder.alt([before, piece]))
}

/** The words of `first` from a state, each continued by `then`'s words from the state it leads to. */
const composed = (
	builder: RegexBuilder,
	first: Reads,
	then: (state: number) => Reads
): Map<number, RegexNode> => {
	const out = new Map<number, RegexNode>()
	for (const [middle, before] of first) {
		for (const [to, after] of then(middle)) {
			joinAt(builder, out, to, seq([before, after]))
		}
	}
	return out
}

/**
 * What any number of a repetition's iterations do from a state, by Kleene's construction: the states its iterations
 * reach, then, through each of them in turn, the words of one or more iterations from each to each, and the empty word
 * at the state itself.
 */
const closureFrom = (
	builder: RegexBuilder,
	once: (state: number) => Reads,
	state: number
): Reads => {
	const reached = [state]
	for (const from of reached) {
		for (const to of once(from).keys()) {
			if (!reached.includes(to)) {
				reached.push(to)
			}
		}
	}
	/** The words of one iteration from the state at `from` to the state at `to`, none where no iteration leads there. */
	let paths = reached.map((from) => reached.map((to) => once(from).get(to) ?? never))
	const cell = (row: ReadonlyArray<RegexNode>, at: number): RegexNode =>
		defined(row[at], "a path's cell")
	for (const [via] of reached.entries()) {
		const through = defined(paths[via], "a path's row")
		const loop = builder.repeat(cell(through, via), 0, "unbounded")
		paths = paths.map((row) =>
			row.map((words, to) => builder.alt([words, seq([cell(row, via), loop, cell(through, to)])]))
		)
	}
	/** The state itself is the first one reached, so the first row holds the words from it. */
	const fromState = defined(paths[0], "the state's own row")
	const out = new Map<number, RegexNode>([[state, builder.alt([empty, cell(fromState, 0)])]])
	for (const [i, to] of reached.entries()) {
		if (to !== state) {
			joinAt(builder, out, to, cell(fromState, i))
		}
	}
	return out
}

/**
 * The words of `node` the automaton accepts, as one node, exactly: each subtree read from every state of the
 * automaton into the states its words lead to, its children read first (ir.ts folded), so a node of any depth reads
 * without recursing. A set splits by the state's edges; an alternation reads arm by arm; a sequence part after part; a
 * repetition iteration after iteration, counted from its least count and closed by Kleene's construction where it is
 * unbounded; and a subtree every code point of which keeps the automaton where it is stays whole there.
 */
const tracked = (node: RegexNode, dfa: CanonicalDfa): RegexNode => {
	const builder = new RegexBuilder()
	/** The code points that keep each state where it is: its edge to itself, one at most in a canonical DFA. */
	const loops: ReadonlyArray<CharSet> = dfa.states.map(
		(s, state) => s.edges.find((e) => e.to === state)?.set ?? []
	)
	const alphabets = new Map<RegexNode, CharSet>()
	const keepsWhere = (n: RegexNode, state: number): boolean => {
		const own = alphabets.get(n) ?? alphabetOf(n)
		alphabets.set(n, own)
		return size(intersection(own, defined(loops[state], "a state's loop"))) === size(own)
	}
	const none: Reads = new Map()
	const readsAt = (
		n: RegexNode,
		s: CanonicalDfa["states"][number],
		state: number,
		of: (child: LiveNode) => ReadonlyArray<Reads>
	): Reads => {
		if (n.kind === "never") {
			return none
		}
		if (keepsWhere(n, state)) {
			return new Map([[state, n]])
		}
		switch (n.kind) {
			case "set": {
				const out = new Map<number, RegexNode>()
				for (const e of s.edges) {
					joinAt(builder, out, e.to, set(intersection(n.set, e.set)))
				}
				return out
			}
			case "alt": {
				const out = new Map<number, RegexNode>()
				for (const arm of n.arms) {
					for (const [to, piece] of of(arm)[state] ?? none) {
						joinAt(builder, out, to, piece)
					}
				}
				return out
			}
			case "seq":
				return n.items.reduce<Reads>(
					(reached, item) => composed(builder, reached, (from) => of(item)[from] ?? none),
					new Map([[state, empty]])
				)
			case "repeat": {
				const body = of(n.body)
				const once = (from: number): Reads => body[from] ?? none
				let reached: Reads = new Map([[state, empty]])
				for (let k = 0; k < n.min; k++) {
					reached = composed(builder, reached, once)
				}
				if (n.max === "unbounded") {
					return composed(builder, reached, (from) => closureFrom(builder, once, from))
				}
				const out = new Map(reached)
				for (let k = n.min; k < n.max; k++) {
					reached = composed(builder, reached, once)
					for (const [to, piece] of reached) {
						joinAt(builder, out, to, piece)
					}
				}
				return out
			}
			case "empty":
			case "start":
			case "end":
				return new Map([[state, n]])
		}
	}
	const tables = folded(new Map<RegexNode, ReadonlyArray<Reads>>(), node, (n, of) =>
		dfa.states.map((s, state) => readsAt(n, s, state, of))
	)
	const fromStart = tables[0] ?? none
	return builder.alt(
		[...fromStart].flatMap(([state, words]) => (dfa.states[state]?.accept === true ? [words] : []))
	)
}

/** Two nodes narrowed to the code points both may hold, until neither alphabet shrinks. */
const narrowed = (left: RegexNode, right: RegexNode): readonly [RegexNode, RegexNode] => {
	let pair: readonly [RegexNode, RegexNode] = [left, right]
	for (;;) {
		const [l, r] = pair
		const mine = alphabetOf(l)
		const theirs = alphabetOf(r)
		const common = intersection(mine, theirs)
		if (size(common) === size(mine) && size(common) === size(theirs)) {
			return pair
		}
		const narrow = (n: RegexNode): RegexNode => mapSets(n, (s) => set(intersection(s, common)))
		pair = [narrow(l), narrow(r)]
	}
}

/**
 * The intersection of two languages of whole texts as one node, exactly, or its refusal: an assertion in either, or the
 * bound the second's minimal DFA passed.
 */
export const intersect = (
	left: RegexNode,
	right: RegexNode,
	limits: DfaLimits
): Result.Result<RegexNode, IntersectionRefusal> => {
	if (assertsAnywhere(left) || assertsAnywhere(right)) {
		return Result.err({ kind: "assertion" })
	}
	const [mine, theirs] = narrowed(left, right)
	if (mine.kind === "never" || theirs.kind === "never") {
		return Result.ok(never)
	}
	const outcome = minimalDfa(buildNfa(seq([start, theirs, end])), limits)
	return outcome.kind === "minimal" ? Result.ok(tracked(mine, outcome.dfa)) : Result.err(outcome)
}
