import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import {
	regexMaxAnchors,
	regexMaxColors,
	regexMaxDepth,
	regexMaxHeldArcs,
	regexMaxHeldStates,
	regexMaxMatchCells,
	regexMaxMatchStates
} from "#compiler/core/limits.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	type AreAtom,
	type ArePiece,
	branchesOf,
	piecesOf,
	printableIntervals,
	type SetNode
} from "#compiler/scalar/regex/are.ts"
import { domain, type Interval } from "#compiler/scalar/regex/charset.ts"
import { folded, type LiveNode, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { partitionOf } from "#compiler/scalar/regex/partition.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

/** Every code point PostgreSQL's colors partition: the admitted domain with NUL and the surrogates, which no set holds. */
const characters: ReadonlyArray<Interval> = Object.freeze([
	Object.freeze([0, domain.reduce((last, [, hi]) => Math.max(last, hi), 0)] as const)
])

/** A set's printed intervals as one list of bounds, its key among the pattern's sets. */
const boundsOf = (intervals: ReadonlyArray<Interval>): ReadonlyArray<number> =>
	intervals.flatMap(([lo, hi]) => [lo, hi])

/**
 * The colors of a pattern: how many, and how many each set node of its IR spans, read by the node, as the IR's folds
 * table each analysis by its nodes (ir.ts folded).
 */
export interface Colors {
	readonly count: number
	readonly spanned: (node: SetNode) => number
}

/**
 * The colors PostgreSQL's regex compiler gives a pattern: the atoms of the partition its sets cut every code point
 * into, each set as its bracket expression prints it, a code point's character entry included, so a set across the
 * surrogate gap holds the surrogates. NUL and every code point past U+10FFFF are in no set, so they share one color.
 */
export const colorsOf = (ir: LiveNode): Colors => {
	const nodes = new Map<RegexNode, true>()
	folded(nodes, ir, () => true)
	const keys = new TupleMap<ReadonlyArray<number>, number>()
	const printed: Array<ReadonlyArray<Interval>> = []
	/** Each set node of the IR, by the position of its set's printed intervals among the distinct ones. */
	const positions = new Map<RegexNode, number>()
	for (const node of nodes.keys()) {
		if (node.kind !== "set") {
			continue
		}
		const intervals = printableIntervals(node.set)
		const bounds = boundsOf(intervals)
		const known = keys.get(bounds)
		if (known === undefined) {
			keys.set(bounds, printed.length)
			positions.set(node, printed.length)
			printed.push(intervals)
		} else {
			positions.set(node, known)
		}
	}
	const partition = partitionOf(printed, characters)
	return {
		count: partition.atomCount,
		spanned: (node) => {
			const position = positions.get(node)
			if (position === undefined) {
				throw defect("a set node of the pattern's IR, which colorsOf partitioned")
			}
			return entry(partition.setAtoms, position).length
		}
	}
}

/**
 * The arcs `\A` and `\Z` each make: PostgreSQL's parser spells an absolute anchor as two constraint arcs, one for a
 * line's edge and one for the string's (regcomp.c parseqatom, SBEGIN and SEND).
 */
const anchorArcs = 2

/**
 * A fragment of the NFA PostgreSQL's parser builds between two states it is given: the states it adds between them,
 * its arcs, each set's counted once for each color it spans, and its longest path from the one to the other, in arcs,
 * a repetition's loop taken once.
 */
export interface Fragment {
	readonly states: number
	readonly arcs: number
	readonly depth: number
}

/** What a node adds to the branch it stands in: its pieces, and their fragments' states, arcs and depths summed. */
interface Run extends Fragment {
	readonly pieces: number
}

const noRun: Run = { pieces: 0, states: 0, arcs: 0, depth: 0 }

/**
 * What PostgreSQL's parser adds around a construct beside what is inside it (regcomp.c): its new states, its empty
 * arcs, and how many of those empty arcs a path through it crosses.
 *
 * @formatConstant the scaffolding PostgreSQL's regex parser builds around each construct
 */
const scaffold = {
	/** parse: a branch's two states, with an empty arc into the one and out of the other. */
	branch: { states: 2, arcs: 2, path: 2 },
	/** parseqatom: a group's two states, with an empty arc into the one and out of the other. */
	group: { states: 2, arcs: 2, path: 2 },
	/** repeat, `x*`: one state x loops on, with an empty arc into it and out of it. */
	star: { states: 1, arcs: 2, path: 2 },
	/** repeat, `x+`: two states around x, with empty arcs in, out and back. */
	plus: { states: 2, arcs: 3, path: 2 },
	/** newnfa: pre, init, final and post, with pre's three arcs to init and final's three to post. */
	frame: { states: 4, arcs: 6, path: 2 }
} as const

/** A fragment inside scaffolding: its states, arcs and depth and the scaffolding's. */
const around = (
	inside: Fragment,
	wrap: { readonly states: number; readonly arcs: number; readonly path: number }
): Fragment => ({
	states: inside.states + wrap.states,
	arcs: inside.arcs + wrap.arcs,
	depth: inside.depth + wrap.path
})

/**
 * A piece's fragment from its atom's: PostgreSQL's repeat (regcomp.c) writes `x{m,n}` as n copies of x in a chain,
 * each but the first its own copy (dupnfa) behind a new state, with an empty arc from the chain's start to each of the
 * first n - max(m, 1) states after it, and one past the whole when m is 0; `x*` as x looping on one new state between
 * two empty arcs; `x+` as x between two new states, with empty arcs in, out and back; and `x{m,}` as `x+` followed by
 * m - 1 copies.
 */
const repeated = (x: Fragment, min: number, max: number | "unbounded"): Fragment => {
	if (max === "unbounded") {
		return min === 0
			? around(x, scaffold.star)
			: around(
					{ states: min * x.states + min - 1, arcs: min * x.arcs, depth: min * x.depth },
					scaffold.plus
				)
	}
	const fanned = max - Math.max(min, 1) + (min === 0 ? 1 : 0)
	return {
		states: max * x.states + max - 1,
		arcs: max * x.arcs + fanned,
		depth: max * x.depth
	}
}

/** The fragment of a branch from its run: its pieces in a chain, a state between each two, or one empty arc. */
const branchFragment = (run: Run): Fragment =>
	run.pieces === 0
		? { states: 0, arcs: 1, depth: 1 }
		: { states: run.pieces - 1 + run.states, arcs: run.arcs, depth: run.depth }

/**
 * The fragment of branches between two states, as PostgreSQL's parse builds a group's inside or a whole pattern: each
 * branch inside its scaffolding, the deepest setting the depth.
 */
const alternative = (runs: ReadonlyArray<Run>): Fragment =>
	runs
		.map((run) => around(branchFragment(run), scaffold.branch))
		.reduce<Fragment>(
			(sum, b) => ({
				states: sum.states + b.states,
				arcs: sum.arcs + b.arcs,
				depth: Math.max(sum.depth, b.depth)
			}),
			{ states: 0, arcs: 0, depth: 0 }
		)

/**
 * The size of the raw NFA PostgreSQL's parser builds from the ARE of `ir`, the colors `colors` gives its sets, by a
 * fold over the IR (ir.ts folded), so a pattern of any depth and of any written-out size is measured without building
 * it, inside newnfa's frame.
 */
export const rawSize = (ir: LiveNode, colors: Colors): Fragment => {
	const runs = new Map<RegexNode, Run>()
	const atomFragment = (atom: AreAtom, of: (node: LiveNode) => Run): Fragment => {
		switch (atom.kind) {
			case "set":
				return { states: 0, arcs: colors.spanned(atom.node), depth: 1 }
			case "anchor":
				return { states: 0, arcs: anchorArcs, depth: 1 }
			case "group":
				return around(alternative(atom.branches.map(of)), scaffold.group)
		}
	}
	const runOf = (node: LiveNode, of: (child: LiveNode) => Run): Run =>
		piecesOf(node).reduce<Run>((run, piece) => {
			const fragment = repeated(atomFragment(piece.atom, of), piece.min, piece.max)
			return {
				pieces: run.pieces + 1,
				states: run.states + fragment.states,
				arcs: run.arcs + fragment.arcs,
				depth: run.depth + fragment.depth
			}
		}, noRun)
	folded(runs, ir, runOf)
	const inside = alternative(branchesOf(ir).map((branch) => folded(runs, branch, runOf)))
	return around(inside, scaffold.frame)
}

/**
 * An arc of the raw NFA: an empty arc, a set's arcs (`weight` of them, one for each color it spans), a pattern's
 * anchor (its two constraint arcs), or the frame's arcs from pre and into post.
 */
type RawArc =
	| { readonly kind: "empty"; readonly to: number }
	| { readonly kind: "set"; readonly to: number; readonly weight: number }
	| { readonly kind: "anchor"; readonly anchor: "start" | "end"; readonly to: number }
	| { readonly kind: "frame"; readonly to: number; readonly weight: number }

/**
 * The raw NFA PostgreSQL's parser builds: its states' arcs, its init and final states, and the frame's pre and post,
 * which no pass of PostgreSQL's optimizer folds away.
 */
export interface RawNfa {
	readonly pre: number
	readonly post: number
	readonly init: number
	readonly final: number
	readonly arcs: ReadonlyArray<ReadonlyArray<RawArc>>
}

/** The builder's work, on its explicit stack: a fragment to build between two states. */
type Task =
	| {
			readonly kind: "branches"
			readonly from: number
			readonly to: number
			readonly branches: ReadonlyArray<LiveNode>
	  }
	| { readonly kind: "piece"; readonly from: number; readonly to: number; readonly piece: ArePiece }
	| { readonly kind: "atom"; readonly from: number; readonly to: number; readonly atom: AreAtom }

/** The arcs a frame's arc stands for: a rainbow arc and two constraint arcs (regc_nfa.c newnfa). */
const frameArcs = 3

/**
 * The raw NFA PostgreSQL's parser builds from the ARE of `ir`, in the shapes rawSize counts. Its work is a stack of
 * tasks, so a pattern of any depth builds without recursing; the caller builds it only once rawSize is within the
 * compile space, so its states and arcs are bounded.
 */
export const rawNfa = (ir: LiveNode, colors: Colors): RawNfa => {
	const arcs: Array<Array<RawArc>> = []
	const fresh = (): number => {
		arcs.push([])
		return arcs.length - 1
	}
	const add = (from: number, arc: RawArc): void => {
		entry(arcs, from).push(arc)
	}
	const pre = fresh()
	const post = fresh()
	const init = fresh()
	const final = fresh()
	add(pre, { kind: "frame", to: init, weight: frameArcs })
	add(final, { kind: "frame", to: post, weight: frameArcs })
	const tasks: Array<Task> = [{ kind: "branches", from: init, to: final, branches: branchesOf(ir) }]
	/** The chain of `copies` copies of `atom` from `from` to `to`, its states in order, the ends included. */
	const chain = (
		from: number,
		to: number,
		atom: AreAtom,
		copies: number
	): ReadonlyArray<number> => {
		const states = [from]
		for (let i = 1; i < copies; i++) {
			states.push(fresh())
		}
		states.push(to)
		for (let i = 1; i < states.length; i++) {
			tasks.push({ kind: "atom", from: entry(states, i - 1), to: entry(states, i), atom })
		}
		return states
	}
	for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
		switch (task.kind) {
			case "branches":
				for (const branch of task.branches) {
					const left = fresh()
					const right = fresh()
					add(task.from, { kind: "empty", to: left })
					add(right, { kind: "empty", to: task.to })
					const pieces = piecesOf(branch)
					if (pieces.length === 0) {
						add(left, { kind: "empty", to: right })
					}
					let at = left
					for (const [i, piece] of pieces.entries()) {
						const next = i === pieces.length - 1 ? right : fresh()
						tasks.push({ kind: "piece", from: at, to: next, piece })
						at = next
					}
				}
				break
			case "piece": {
				const { from, to, piece } = task
				if (piece.max === "unbounded") {
					if (piece.min === 0) {
						const loop = fresh()
						add(from, { kind: "empty", to: loop })
						add(loop, { kind: "empty", to })
						tasks.push({ kind: "atom", from: loop, to: loop, atom: piece.atom })
						break
					}
					const a = fresh()
					const b = fresh()
					const rest = piece.min === 1 ? to : fresh()
					add(from, { kind: "empty", to: a })
					add(b, { kind: "empty", to: a })
					add(b, { kind: "empty", to: rest })
					tasks.push({ kind: "atom", from: a, to: b, atom: piece.atom })
					if (piece.min > 1) {
						chain(rest, to, piece.atom, piece.min - 1)
					}
					break
				}
				const states = chain(from, to, piece.atom, piece.max)
				const fanned = piece.max - Math.max(piece.min, 1) + (piece.min === 0 ? 1 : 0)
				for (let i = 1; i <= fanned; i++) {
					add(from, { kind: "empty", to: entry(states, i) })
				}
				break
			}
			case "atom": {
				const { from, to, atom } = task
				switch (atom.kind) {
					case "set":
						add(from, { kind: "set", to, weight: colors.spanned(atom.node) })
						break
					case "anchor":
						add(from, { kind: "anchor", anchor: atom.anchor, to })
						break
					case "group": {
						const s = fresh()
						const s2 = fresh()
						add(from, { kind: "empty", to: s })
						add(s2, { kind: "empty", to })
						tasks.push({ kind: "branches", from: s, to: s2, branches: atom.branches })
						break
					}
				}
				break
			}
		}
	}
	return { pre, post, init, final, arcs }
}

/** The arcs one raw arc stands for: a set's colors, an anchor's two, a frame's three, an empty arc's one. */
const weightOf = (arc: RawArc): number => {
	switch (arc.kind) {
		case "empty":
			return 1
		case "set":
		case "frame":
			return arc.weight
		case "anchor":
			return anchorArcs
	}
}

/** The state a union-find's `into` folds `s` into, following each fold to the state that took it. */
const rootOf = (into: Int32Array, s: number): number => {
	let root = s
	for (let next = entry(into, root); next !== root; next = entry(into, root)) {
		root = next
	}
	return root
}

/** An NFA's arcs, by state, after folding, and the state its init was folded into. */
export interface Folded {
	readonly arcs: ReadonlyArray<ReadonlyArray<RawArc>>
	readonly init: number
}

/**
 * Folds every state but pre and post whose only arc on one side, `side` of it, is empty into the state at that arc's
 * other end, a chain into its last, unless the fold would close a cycle of such states, and answers each state's arcs
 * with every arc following the states it joins, a folded state with none and its folding arc gone.
 */
const foldAliases = (nfa: RawNfa, graph: Folded, side: "out" | "in"): Folded => {
	const { arcs } = graph
	const ins: Array<Array<{ readonly from: number; readonly arc: RawArc }>> = arcs.map(() => [])
	for (const [from, out] of arcs.entries()) {
		for (const arc of out) {
			entry(ins, arc.to).push({ from, arc })
		}
	}
	const into = Int32Array.from(arcs, (_, s) => s)
	const folding = new Uint8Array(arcs.length)
	for (const [s, out] of arcs.entries()) {
		const [only, ...more] = side === "out" ? out : entry(ins, s).map((i) => i.arc)
		const other = side === "out" ? only?.to : entry(ins, s)[0]?.from
		if (
			s !== nfa.pre &&
			s !== nfa.post &&
			only?.kind === "empty" &&
			more.length === 0 &&
			other !== undefined &&
			rootOf(into, other) !== s
		) {
			into[s] = rootOf(into, other)
			folding[s] = 1
		}
	}
	const moved: Array<Array<RawArc>> = arcs.map(() => [])
	for (const [from, out] of arcs.entries()) {
		for (const arc of out) {
			const to = rootOf(into, arc.to)
			const at = rootOf(into, from)
			const folds = (side === "out" ? entry(folding, from) : entry(folding, arc.to)) === 1
			if (!(folds && arc.kind === "empty" && to === at)) {
				entry(moved, at).push({ ...arc, to })
			}
		}
	}
	return { arcs: moved, init: rootOf(into, graph.init) }
}

/**
 * The raw NFA as PostgreSQL's empty-arc removal (regc_nfa.c fixempties) finds it after its first two passes: every
 * state whose only arc out is empty folded into that arc's target, then every state whose only arc in is empty folded
 * into its source. A state PostgreSQL's passes reach only once a duplicate arc is merged stays unfolded here, which
 * only adds to what is counted from it.
 */
export const withoutAliases = (nfa: RawNfa): Folded =>
	foldAliases(nfa, foldAliases(nfa, { arcs: nfa.arcs, init: nfa.init }, "out"), "in")

/**
 * The arcs empty-arc removal adds to the optimized copy, counted until they pass `cap`: into every state left by a
 * non-empty arc, the non-empty arcs into each other state a path of empty arcs leads from to it, as fixempties pushes
 * them forward, deduplicated, once its first two passes have folded the aliases away (withoutAliases).
 */
const emptyCopies = (arcs: ReadonlyArray<ReadonlyArray<RawArc>>, cap: number): number => {
	const kept = Uint8Array.from(arcs, (out) => (leaves(out) ? 1 : 0))
	const into = new Float64Array(arcs.length)
	for (const out of arcs) {
		for (const arc of out) {
			if (arc.kind !== "empty") {
				into[arc.to] = entry(into, arc.to) + weightOf(arc)
			}
		}
	}
	const mark = new Int32Array(arcs.length).fill(-1)
	let copies = 0
	for (let s = 0; s < arcs.length && copies <= cap; s++) {
		const weight = entry(into, s)
		if (weight === 0) {
			continue
		}
		mark[s] = s
		const stack = [s]
		for (let x = stack.pop(); x !== undefined && copies <= cap; x = stack.pop()) {
			for (const arc of entry(arcs, x)) {
				if (arc.kind !== "empty" || entry(mark, arc.to) === s) {
					continue
				}
				mark[arc.to] = s
				copies += entry(kept, arc.to) === 1 ? weight : 0
				stack.push(arc.to)
			}
		}
	}
	return copies
}

/** Whether a state leaves by an arc that is not empty, so the optimized NFA keeps it. */
const leaves = (out: ReadonlyArray<RawArc>): boolean => out.some((arc) => arc.kind !== "empty")

/**
 * The states the compacted NFA a match reads holds, at most: those the optimized NFA keeps, the states it leaves by an
 * arc that is not empty once the aliases are folded away (withoutAliases), since empty-arc removal leaves a state it
 * left by empty arcs alone with none and cleanup drops it; and once more each kept state init reaches by empty arcs,
 * which pre reaches by one arc once they are removed and makesearch (regcomp.c) may split in two.
 */
export const matchStates = ({ arcs, init }: Folded): number => {
	const reached = new Uint8Array(arcs.length)
	reached[init] = 1
	const stack = [init]
	let entered = 0
	for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
		entered += leaves(entry(arcs, s)) ? 1 : 0
		for (const arc of entry(arcs, s)) {
			if (arc.kind === "empty" && entry(reached, arc.to) === 0) {
				reached[arc.to] = 1
				stack.push(arc.to)
			}
		}
	}
	return arcs.filter(leaves).length + entered
}

/**
 * The states reached from `seeds` by `step`, each with whether the path that reached it passed a set's arcs: a state is
 * reached `consumed` when some path to it passes one. `step` lists a state's neighbors, each with whether the arc
 * between consumes.
 */
const reachedConsuming = (
	count: number,
	seeds: ReadonlyArray<number>,
	step: (state: number) => ReadonlyArray<{ readonly to: number; readonly consumes: boolean }>
): Uint8Array => {
	const plain = new Uint8Array(count)
	const consumed = new Uint8Array(count)
	const stack: Array<{ readonly state: number; readonly consumed: boolean }> = []
	const visit = (state: number, through: boolean): void => {
		const seen = through ? consumed : plain
		if (entry(seen, state) === 0) {
			seen[state] = 1
			stack.push({ state, consumed: through })
		}
	}
	for (const seed of seeds) {
		visit(seed, false)
	}
	for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
		for (const next of step(at.state)) {
			visit(next.to, at.consumed || next.consumes)
		}
	}
	return consumed
}

/**
 * The pattern's anchors PostgreSQL's constraint elimination must move: a `\A` some path from init reaches past a set's
 * arcs, and a `\Z` from which some path to final passes one. PostgreSQL leaves an anchor every path reaches from the
 * start without consuming, or leaves for the end so, where it is, since nothing it would cross can consume.
 */
const movingAnchors = (nfa: RawNfa): number => {
	const count = nfa.arcs.length
	const inner = (arc: RawArc): boolean => arc.kind !== "frame"
	const forward = reachedConsuming(count, [nfa.init], (state) =>
		entry(nfa.arcs, state)
			.filter(inner)
			.map((arc) => ({ to: arc.to, consumes: arc.kind === "set" }))
	)
	const back: Array<Array<{ readonly to: number; readonly consumes: boolean }>> = nfa.arcs.map(
		() => []
	)
	for (const [from, out] of nfa.arcs.entries()) {
		for (const arc of out.filter(inner)) {
			entry(back, arc.to).push({ to: from, consumes: arc.kind === "set" })
		}
	}
	const backward = reachedConsuming(count, [nfa.final], (state) => entry(back, state))
	let moving = 0
	for (const [from, out] of nfa.arcs.entries()) {
		for (const arc of out) {
			if (arc.kind === "anchor") {
				const crosses =
					arc.anchor === "start" ? entry(forward, from) === 1 : entry(backward, arc.to) === 1
				moving += crosses ? 1 : 0
			}
		}
	}
	return moving
}

/**
 * PostgreSQL's regex compile space, as grizzle measures a pattern against it before PostgreSQL ever compiles it.
 *
 * PostgreSQL compiles a domain's pattern at the first value it checks, not when the domain is made, and refuses one
 * past its compiler's limits as "regular expression is too complex" or "too many colors", so every write the domain
 * checks would fail. Its compiler has three such limits, each read here off the ARE grizzle prints (are.ts), as
 * PostgreSQL's parser reads it:
 *
 * - colors: the classes of characters the pattern's sets hold alike (regc_color.c), each a `color`, a short, at most
 *   MAX_COLOR of them (core/limits.ts regexMaxColors);
 * - compile space: the states and arcs its NFAs hold at once, against REG_MAX_COMPILE_SPACE (regexMaxHeldStates,
 *   regexMaxHeldArcs). The parser builds the raw NFA, and nfanode optimizes a copy of all of it while the raw one
 *   lives, so both are held; empty-arc removal (regc_nfa.c fixempties) adds to an optimized NFA an arc for each
 *   non-empty arc into a state times each state an empty path leads it to; and makesearch, on the raw NFA once
 *   optimized alone, may clone as many states and arcs again. So the states held are twice the raw NFA's, and the arcs
 *   twice the optimized one's. A set's arcs are one for each color it spans;
 * - stack depth: the compiler's walks of the NFA recurse along its paths, so the longest path is how deep they go,
 *   which PostgreSQL bounds by max_stack_depth (regexMaxDepth).
 *
 * And one at every match: regexec's DFA (rege_dfa.c newdfa) allocates, for each match, a bit vector of the states for
 * each of twice as many state sets as the compacted NFA has states, and an entry for each of those sets and each
 * color, every array within MaxAllocSize, past which the match fails with "invalid memory alloc request size", every
 * write the domain checks with it. The states the compacted NFA holds (matchStates) and those times the colors bound
 * them (regexMaxMatchStates, regexMaxMatchCells).
 *
 * The sizes count every state and arc the parser makes, none it frees or never makes twice, so they bound what it
 * holds from above. Beside them, the anchors PostgreSQL must move: constraint elimination (regc_nfa.c pullback,
 * pushfwd) moves every `\A` and `\Z` that some consuming path reaches or leaves, cloning the states it crosses, and
 * leaves one at either end of every path where it is (regexMaxAnchors).
 *
 * The first of these limits a pattern's IR passes, in their fixed order (colors, depth, states, arcs, the match's
 * states and cells, anchors), so one pattern has one refusal; none where it passes none. The raw NFA is built only once its size is
 * within the compile space.
 */
export const pastCompileSpace = (ir: LiveNode): RegexSpaceMeasure | undefined => {
	const colors = colorsOf(ir)
	if (colors.count > regexMaxColors.value) {
		return { kind: "colors", limit: regexMaxColors.value, needed: colors.count }
	}
	const raw = rawSize(ir, colors)
	if (raw.depth > regexMaxDepth.value) {
		return { kind: "depth", limit: regexMaxDepth.value, needed: raw.depth }
	}
	const heldStates = raw.states + raw.states
	if (heldStates > regexMaxHeldStates.value) {
		return { kind: "states", limit: regexMaxHeldStates.value, needed: heldStates }
	}
	const heldRaw = raw.arcs + raw.arcs
	if (heldRaw > regexMaxHeldArcs.value) {
		return { kind: "arcs", limit: regexMaxHeldArcs.value }
	}
	const nfa = rawNfa(ir, colors)
	const unaliased = withoutAliases(nfa)
	const copies = emptyCopies(unaliased.arcs, regexMaxHeldArcs.value - heldRaw)
	const optimized = raw.arcs + copies
	if (optimized + optimized > regexMaxHeldArcs.value) {
		return { kind: "arcs", limit: regexMaxHeldArcs.value }
	}
	const states = matchStates(unaliased)
	if (states > regexMaxMatchStates.value) {
		return { kind: "matchStates", limit: regexMaxMatchStates.value, needed: states }
	}
	const cells = states * colors.count
	if (cells > regexMaxMatchCells.value) {
		return { kind: "matchCells", limit: regexMaxMatchCells.value, needed: cells }
	}
	const anchors = movingAnchors(nfa)
	if (anchors > regexMaxAnchors.value) {
		return { kind: "anchors", limit: regexMaxAnchors.value, needed: anchors }
	}
	return undefined
}
