import { defined } from "#text/base/invariant.ts"
import * as Result from "#text/base/result.ts"
import { type CharSet, intersection, size } from "#text/regex/charset.ts"
import { type CanonicalDfa, type DfaBounded, type DfaLimits, minimalDfa } from "#text/regex/dfa.ts"
import { alphabetOf, assertsAnywhere, mapSets } from "#text/regex/folds.ts"
import { included } from "#text/regex/inclusion.ts"
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
 * The intersection of two languages of whole texts as one node, exactly: both narrowed to the code points both may hold;
 * where one then includes the other, the included one, as it stands (inclusion.ts included), the one of fewer
 * positions where each includes the other, the first on a tie; otherwise one read through the other's minimal DFA
 * (`tracked`), its own shape kept, through the DFA of fewer states, so a fixed sequence of sets such as
 * `[0-9]{4}-[0-9]{2}` is a chain of states that cuts the other to its columns, and a domain's facets compose into the
 * one pattern its domain stores, no larger than its facets make it. pantry's grammar/domains.ts intersectTwo and
 * tracked (UNIFY's op 3) on the one IR. It is refused, never approximated, where neither DFA is built within `limits`,
 * or where either node tests an assertion, since a language of whole texts tests none.
 */

/** Why an intersection is refused: an assertion in a node, or the bound the second's DFA passed where the first's
 * did too. */
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
 * repetition iteration after iteration up to its least count, then its rest from each state those reach: the
 * repetition of the rest whole where every code point keeps the automaton there, as pantry's tracked did, so a run of
 * iterations stays one run that a later fold reads as one (preimage.ts mergeSafe), else closed by Kleene's construction
 * where it is unbounded and counted up to its most where not; and a subtree every code point of which keeps the
 * automaton where it is stays whole there.
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
				const more = n.max === "unbounded" ? n.max : n.max - n.min
				/** The iterations past the least count from `from`: the repetition of them whole where every code
				 * point keeps the automaton there, else Kleene's closure or each count up to the most. */
				const rest = (from: number): Reads => {
					if (keepsWhere(n, from)) {
						return new Map([[from, builder.repeat(n.body, 0, more)]])
					}
					if (more === "unbounded") {
						return closureFrom(builder, once, from)
					}
					let at: Reads = new Map([[from, empty]])
					const out = new Map(at)
					for (let k = 0; k < more; k++) {
						at = composed(builder, at, once)
						for (const [to, piece] of at) {
							joinAt(builder, out, to, piece)
						}
					}
					return out
				}
				return composed(builder, reached, rest)
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
	const ofMine = minimalDfa(buildNfa(seq([start, mine, end])), limits)
	const ofTheirs = minimalDfa(buildNfa(seq([start, theirs, end])), limits)
	if (ofMine.kind === "bounded") {
		return ofTheirs.kind === "bounded"
			? Result.err(ofTheirs)
			: Result.ok(tracked(mine, ofTheirs.dfa))
	}
	if (ofTheirs.kind === "bounded") {
		return Result.ok(tracked(theirs, ofMine.dfa))
	}
	const mineInTheirs = included(ofMine.dfa, ofTheirs.dfa, limits).kind === "included"
	const theirsInMine = included(ofTheirs.dfa, ofMine.dfa, limits).kind === "included"
	if (mineInTheirs && theirsInMine) {
		const builder = new RegexBuilder()
		return Result.ok(builder.expandedSize(theirs) < builder.expandedSize(mine) ? theirs : mine)
	}
	if (mineInTheirs || theirsInMine) {
		return Result.ok(mineInTheirs ? mine : theirs)
	}
	return Result.ok(
		ofMine.dfa.states.length < ofTheirs.dfa.states.length
			? tracked(theirs, ofMine.dfa)
			: tracked(mine, ofTheirs.dfa)
	)
}
