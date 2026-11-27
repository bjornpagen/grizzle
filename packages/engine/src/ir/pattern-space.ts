import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import {
	type AreAtom,
	type ArePiece,
	branchesOf,
	piecesOf,
	printableIntervals,
	type SetNode
} from "@bjornpagen/grizzle-text/regex/are"
import { domain, type Interval } from "@bjornpagen/grizzle-text/regex/charset"
import { regexMaxHeldArcs } from "@bjornpagen/grizzle-text/regex/ir"
import { folded, type LiveNode, type RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { regexSpaceStates } from "@bjornpagen/grizzle-text/regex/ir"
import { partitionOf } from "@bjornpagen/grizzle-text/regex/partition"
import { entry } from "@bjornpagen/grizzle-text/regex/table"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"

/**
 * MAX_COLOR, the greatest color number of a regex's color map: a color is a short, and newcolor refuses a color past
 * it as REG_ECOLORS, "too many colors" (regc_color.c).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's regex compiler
 * @unit colors
 * @scope the greatest color number of one regex's color map
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/regex/regguts.h#L165
 * @quote #define MAX_COLOR 32767 /* max color (must fit in 'color' datatype) *\/
 * @verified 2026-11-20
 */
const regexMaxColor = 32_767

/**
 * The most colors a pattern's sets may cut the characters into, the classes of characters every set holds alike
 * (ir/pattern-space.ts colorsOf). A pattern of more is refused as ResourceBound (regexCompileSpace, colors) when its
 * domain or match is compiled, since PostgreSQL refuses it as "too many colors" at the first value it checks.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0's regex compiler
 * @unit colors
 * @scope one str.regex or Text.matches pattern's colors
 * @derivation colors are numbered from 0 to MAX_COLOR, and newcolor refuses another: "if (cm->max == MAX_COLOR)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/regex/regc_color.c#L212, verified 2026-11-20).
 *   While one set is parsed, newsub opens a subcolor for each color the set splits, "sco = newcolor(cm); /* must
 *   create subcolor *\/" (regc_color.c#L401), and okcolors frees the parents the set emptied only once the set is
 *   done, so the colors live at once are at most twice the pattern's; the four pseudocolors specialcolors allocates
 *   after the last set, "nfa->bos[0] = pseudocolor(nfa->cm);" (regc_nfa.c#L1560), come when no subcolor is open, so
 *   twice the colors binds first
 * @from {@link regexMaxColor}
 */
const regexMaxColors = (regexMaxColor + 1) / 2

/**
 * The states of an NFA's first state batch, FIRSTSBSIZE, the fewest any of its batches holds.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's regex compiler
 * @unit NFA states
 * @scope the first state batch of one NFA, each later batch doubling it
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/regex/regguts.h#L353
 * @quote #define FIRSTSBSIZE 32
 * @verified 2026-11-20
 */
const regexFirstStateBatch = 32

/**
 * The states of an NFA's largest state batch, MAXSBSIZE.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's regex compiler
 * @unit NFA states
 * @scope one state batch of one NFA
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/regex/regguts.h#L354
 * @quote #define MAXSBSIZE 1024
 * @verified 2026-11-20
 */
const regexMaxStateBatch = 1_024

/**
 * The most states a pattern's NFAs may hold at once (ir/pattern-space.ts pastCompileSpace): twice the raw NFA
 * PostgreSQL's parser builds from its ARE. A pattern of more is refused as ResourceBound (regexCompileSpace, states).
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0's regex compiler
 * @unit NFA states
 * @scope the states of one pattern's NFAs that PostgreSQL holds at once while compiling it
 * @derivation the states' share of REG_MAX_COMPILE_SPACE, less what batches cost beyond the states they hold: a batch
 *   is allocated only when every slot of the NFA's batches is live, so the two NFAs PostgreSQL holds at once
 *   (regcomp.c nfanode copies the whole raw NFA, "nfa = newnfa(v, v->cm, v->nfa);" at #L2371, while the raw one lives)
 *   hold at most their live entries and one batch each beyond them; a batch's header, its chain link and its count, is
 *   no larger than one entry, and a batch holds at least its first batch's entries, so the headers cost at most one
 *   entry for each of those; newstate and allocarc refuse a new batch only once "nfa->v->spaceused >=
 *   REG_MAX_COMPILE_SPACE" (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/regex/regc_nfa.c#L165,
 *   #L389), so the states within their share and the arcs within theirs keep the space below it, verified 2026-11-14
 * @from {@link regexSpaceStates}, {@link regexFirstStateBatch}, {@link regexMaxStateBatch}
 */
export const regexMaxHeldStates =
	Math.floor((regexSpaceStates * regexFirstStateBatch) / (regexFirstStateBatch + 1)) -
	regexMaxStateBatch -
	regexMaxStateBatch

/**
 * The longest path of the raw NFA PostgreSQL's parser builds from a pattern's ARE, in arcs (ir/pattern-space.ts
 * rawSize). PostgreSQL's parser recurses into nested groups, and its walks of the NFA (regc_nfa.c duptraverse,
 * markreachable, markcanreach) recurse along its paths, each refusing a pattern past max_stack_depth as "regular
 * expression is too complex" (STACK_TOO_DEEP), so a pattern of a longer path is refused as ResourceBound
 * (regexCompileSpace, depth). It holds at max_stack_depth's default (maxStackDepth), which Db.open and grizzle migrate
 * require of the server.
 *
 * @limitKind measured
 * @owner grizzle's text refinement (ir/pattern-space.ts pastCompileSpace)
 * @unit NFA arcs
 * @scope the longest path of one pattern's raw NFA, which PostgreSQL's regex compiler recurses along
 * @evidence a one-off bisection over each shape's count against PostgreSQL, a fresh backend per probe, recorded in
 *   ~/.cache/grizzle-release/RC2CITE/out/idle/regex/regex-edges-2026-11-14T080636.949Z.json by the uncommitted probe
 *   .scratch/regex-edges.ts in RC2CITE's clone; test/pg/text/differential.test.ts "compiles the largest pattern the
 *   limits admit along a drawn shape, at each limit's edge" re-verifies that what the limits admit compiles
 * @observed 2026-11-14 08:06:36 to 08:10:19 UTC, one bisection per shape and every count of the anchors' shapes at
 *   once
 * @environment PostgreSQL 19rc2 as scripts/pg/pin.env builds it, its three patches applied (gcc 15.2.0), on the local
 *   cluster CONTRIBUTING.md sets up, max_stack_depth 2048 kB, its default; cassowary, Ubuntu 26.04 on an AWS Graviton3
 *   (Neoverse-V1, arm64) instance with every logical CPU nproc reports and 247 GiB, Node 26.13.1; grizzle 01cc8dda;
 *   load average 5.0 to 10.3, no other session active on the cluster
 * @workload each pattern's ARE compiled by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`, and again inside an
 *   INSERT in a PL/pgSQL function two PL/pgSQL calls deep, over three shapes: a chain of plain code points in counted
 *   runs, nested optional groups `(?:a(?:a…)?)?`, and nested + groups `(?:(?:a)+b)+b…`; the chain again at
 *   max_stack_depth 1MB
 * @result the longest path compiled and the shortest refused, in arcs: the chain 43,523 and 43,524, two PL/pgSQL calls
 *   deep 43,407 and 43,408, and 21,677 and 21,678 at 1MB, so the edge follows the setting; nested optional groups
 *   38,406 and 38,411, two PL/pgSQL calls deep 38,301 and 38,306; nested + groups 43,520 and 43,527, two calls deep
 *   43,401 and 43,408; every refusal "regular expression is too complex" at under 90,000 states held, far inside the
 *   compile space; every compile near an edge within 6 s
 * @decision 16,000: below half the shallowest edge measured, 38,301 arcs two PL/pgSQL calls deep, leaving more than
 *   1MB of the 2MB stack for a call path deeper than the measured one when a pattern is first compiled; the two calls
 *   cost the shallowest shape 105 arcs
 * @revalidate a PostgreSQL repin; a change of max_stack_depth's default or of the platform's stack frames; a change to
 *   the ARE printer (scalar/regex/are.ts) or to the model of PostgreSQL's raw NFA (ir/pattern-space.ts); a pattern
 *   the suite finds refused as too complex
 */
export const regexMaxDepth = 16_000

/**
 * The states the compacted NFA a match reads holds (ir/pattern-space.ts matchStates). At every match regexec's DFA
 * (rege_dfa.c newdfa) allocates a bit vector of these states for each of twice as many state sets, "d->statesarea =
 * MALLOC_ARRAY(unsigned, (nss + WORK) * wordsper);", which palloc refuses past MaxAllocSize, failing the match, and so
 * every write its domain checks, with "invalid memory alloc request size"; a pattern of more is refused as
 * ResourceBound (regexCompileSpace, matchStates).
 *
 * @limitKind measured
 * @owner grizzle's text refinement (ir/pattern-space.ts pastCompileSpace)
 * @unit NFA states
 * @scope the states of the compacted NFA one pattern's match reads, as its model counts them
 * @evidence a one-off bisection over each shape's count against PostgreSQL, a fresh backend per probe, recorded in
 *   ~/.cache/grizzle-release/RC2CITE/out/idle/regex/regex-edges-2026-11-14T080636.949Z.json by the uncommitted probe
 *   .scratch/regex-edges.ts in RC2CITE's clone; test/pg/text/differential.test.ts "compiles the largest pattern the
 *   limits admit along a drawn shape, at each limit's edge" re-verifies that what the limits admit compiles
 * @observed 2026-11-14 08:06:36 to 08:10:19 UTC, one bisection per shape and every count of the anchors' shapes at
 *   once
 * @environment PostgreSQL 19rc2 as scripts/pg/pin.env builds it, its three patches applied (gcc 15.2.0), on the local
 *   cluster CONTRIBUTING.md sets up, max_stack_depth 2048 kB, its default; cassowary, Ubuntu 26.04 on an AWS Graviton3
 *   (Neoverse-V1, arm64) instance with every logical CPU nproc reports and 247 GiB, Node 26.13.1; grizzle 01cc8dda;
 *   load average 5.0 to 10.3, no other session active on the cluster
 * @workload each pattern's ARE matched by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`: an anchored union of k
 *   words of four letters, digits and underscores, and the same union repeated by +
 * @result the union matched at 21,843 words, 65,535 states as the model counts them, and failed at 21,844 words,
 *   65,538 states, with "invalid memory alloc request size 1073750016", the state sets' bit vectors, (2S + 1) words of
 *   ⌈S/32⌉ four-byte words for PostgreSQL's S = 65,536 states, the first count past MaxAllocSize; the repeated union
 *   matched at 21,843 words and failed at 21,844 alike
 * @decision 64,000: below the 65,536 states at which the bit vectors pass MaxAllocSize, the measured edge, with 1,535
 *   states, about 2%, of headroom; the model counts each state makesearch may split twice
 * @revalidate a PostgreSQL repin; a change of max_stack_depth's default or of the platform's stack frames; a change to
 *   the ARE printer (scalar/regex/are.ts) or to the model of PostgreSQL's raw NFA (ir/pattern-space.ts); a pattern
 *   the suite finds refused as too complex
 */
export const regexMaxMatchStates = 64_000

/**
 * The states of the compacted NFA a match reads times the pattern's colors (ir/pattern-space.ts matchStates,
 * colorsOf). At every match regexec's DFA allocates an entry for each of twice as many state sets as states and each
 * color, "d->incarea = MALLOC_ARRAY(struct arcp, nss * cnfa->ncolors);", which palloc refuses past MaxAllocSize; a
 * pattern of more is refused as ResourceBound (regexCompileSpace, matchCells).
 *
 * @limitKind measured
 * @owner grizzle's text refinement (ir/pattern-space.ts pastCompileSpace)
 * @unit NFA states times colors
 * @scope the states of the compacted NFA one pattern's match reads times its colors, as its model counts them
 * @evidence a one-off bisection over each shape's count against PostgreSQL, a fresh backend per probe, recorded in
 *   ~/.cache/grizzle-release/RC2CITE/out/idle/regex/regex-edges-2026-11-14T080636.949Z.json by the uncommitted probe
 *   .scratch/regex-edges.ts in RC2CITE's clone; test/pg/text/differential.test.ts "compiles the largest pattern the
 *   limits admit along a drawn shape, at each limit's edge" re-verifies that what the limits admit compiles
 * @observed 2026-11-14 08:06:36 to 08:10:19 UTC, one bisection per shape and every count of the anchors' shapes at
 *   once
 * @environment PostgreSQL 19rc2 as scripts/pg/pin.env builds it, its three patches applied (gcc 15.2.0), on the local
 *   cluster CONTRIBUTING.md sets up, max_stack_depth 2048 kB, its default; cassowary, Ubuntu 26.04 on an AWS Graviton3
 *   (Neoverse-V1, arm64) instance with every logical CPU nproc reports and 247 GiB, Node 26.13.1; grizzle 01cc8dda;
 *   load average 5.0 to 10.3, no other session active on the cluster
 * @workload each pattern's ARE matched by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`: an anchored union of k
 *   words of a code point of their own and a common one, and the same union repeated by * before a last code point
 * @result the union matched at 5,787 words, 33,535,677 states times colors as the model counts them, and failed at
 *   5,788, 33,547,260, with "invalid memory alloc request size 1073883136", the entries of 16 bytes, which first pass
 *   MaxAllocSize at 33,554,432 states times colors: PostgreSQL's map held two colors more than the model counts, 5,792
 *   against 5,790 at 5,794 states; the repeated union matched at 5,786 words and failed at 5,787 alike
 * @decision 16,000,000: about half the measured edge, since freeing the colors a set empties can leave a color map up
 *   to twice a pattern's colors (regexMaxColors), and the arrays count the map's colors
 * @revalidate a PostgreSQL repin; a change of max_stack_depth's default or of the platform's stack frames; a change to
 *   the ARE printer (scalar/regex/are.ts) or to the model of PostgreSQL's raw NFA (ir/pattern-space.ts); a pattern
 *   the suite finds refused as too complex
 */
export const regexMaxMatchCells = 16_000_000

/**
 * The anchors PostgreSQL must move (ir/pattern-space.ts movingAnchors): constraint elimination (regc_nfa.c pullback,
 * pushfwd, fixconstraintloops) clones the states around each anchor some consuming path reaches or leaves, and around
 * anchors joined by empty paths it compounds, so a pattern of more is refused as ResourceBound (regexCompileSpace,
 * anchors). An anchor at either end of every path is never moved and never counted.
 *
 * @limitKind measured
 * @owner grizzle's text refinement (ir/pattern-space.ts pastCompileSpace)
 * @unit anchors
 * @scope the anchors of one pattern's raw NFA that constraint elimination moves
 * @evidence a one-off bisection over each shape's count against PostgreSQL, a fresh backend per probe, recorded in
 *   ~/.cache/grizzle-release/RC2CITE/out/idle/regex/regex-edges-2026-11-14T080636.949Z.json by the uncommitted probe
 *   .scratch/regex-edges.ts in RC2CITE's clone; test/pg/text/differential.test.ts "compiles the largest pattern the
 *   limits admit along a drawn shape, at each limit's edge" re-verifies that what the limits admit compiles
 * @observed 2026-11-14 08:06:36 to 08:10:19 UTC, one bisection per shape and every count of the anchors' shapes at
 *   once
 * @environment PostgreSQL 19rc2 as scripts/pg/pin.env builds it, its three patches applied (gcc 15.2.0), on the local
 *   cluster CONTRIBUTING.md sets up, max_stack_depth 2048 kB, its default; cassowary, Ubuntu 26.04 on an AWS Graviton3
 *   (Neoverse-V1, arm64) instance with every logical CPU nproc reports and 247 GiB, Node 26.13.1; grizzle 01cc8dda;
 *   load average 5.0 to 10.3, no other session active on the cluster
 * @workload each pattern's ARE compiled by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`, over two shapes: k
 *   optional `$` before 256 code points of their own and four runs of 255 copies of a class of them, and
 *   `(?:^|.{1,255}|$){k}b`, an anchor on either side of a wide run, each count k from 1 to 64
 * @result the first shape compiled at every k, 64 anchors to move over a raw NFA of 261,848 arcs in 1.4 s; the second,
 *   two anchors to move for each k past the first, compiled 15 in 22 s, 19 in 162 s and 21 in 220 s, inside the
 *   probe's 300 s statement_timeout, and refused 23 after 42 s, 31 after 22 s and 63 after 148 s as "regular
 *   expression is too complex"
 * @decision 8: below half the most anchors the binding shape compiled, 21, whose compile already took minutes; the
 *   arcs an anchor crosses bind nothing measured, so no measure weighs them
 * @revalidate a PostgreSQL repin; a change of max_stack_depth's default or of the platform's stack frames; a change to
 *   the ARE printer (scalar/regex/are.ts) or to the model of PostgreSQL's raw NFA (ir/pattern-space.ts); a pattern
 *   the suite finds refused as too complex
 */
export const regexMaxAnchors = 8

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
				defect("a set node of the pattern's IR, which colorsOf partitioned")
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
 * The raw NFA's size against the first of the limits it meets (colors, depth, states, arcs; pastCompileSpace), or
 * the colors and the size where it meets none: a fold over the IR, which builds nothing.
 */
const rawSpace = (
	ir: LiveNode
):
	| { readonly kind: "past"; readonly measure: RegexSpaceMeasure }
	| { readonly kind: "within"; readonly colors: Colors; readonly raw: Fragment } => {
	const colors = colorsOf(ir)
	if (colors.count > regexMaxColors) {
		return {
			kind: "past",
			measure: { kind: "colors", limit: regexMaxColors, needed: colors.count }
		}
	}
	const raw = rawSize(ir, colors)
	if (raw.depth > regexMaxDepth) {
		return { kind: "past", measure: { kind: "depth", limit: regexMaxDepth, needed: raw.depth } }
	}
	const heldStates = raw.states + raw.states
	if (heldStates > regexMaxHeldStates) {
		return {
			kind: "past",
			measure: { kind: "states", limit: regexMaxHeldStates, needed: heldStates }
		}
	}
	if (raw.arcs + raw.arcs > regexMaxHeldArcs) {
		return { kind: "past", measure: { kind: "arcs", limit: regexMaxHeldArcs } }
	}
	return { kind: "within", colors, raw }
}

/**
 * The first of the limits on the raw NFA's size a pattern's IR passes (colors, depth, states and arcs, in
 * pastCompileSpace's order), none where it passes none: what a repetition past 255 is judged by before its ARE is
 * printed, which spells it as pieces of counts within 255 (print.ts quantified) and so leaves each of the four as it
 * is, since PostgreSQL's chain of n copies is the chains of the pieces' counts, which sum to n, joined by a state
 * each (repeated, branchFragment). It bounds the printed pattern's length by the compile space, so a count no
 * compile space holds is refused before a piece of it is printed.
 */
export const pastRawSpace = (ir: LiveNode): RegexSpaceMeasure | undefined => {
	const sized = rawSpace(ir)
	return sized.kind === "past" ? sized.measure : undefined
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
 *   MAX_COLOR of them (regexMaxColors);
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
	const sized = rawSpace(ir)
	if (sized.kind === "past") {
		return sized.measure
	}
	const { colors, raw } = sized
	const heldRaw = raw.arcs + raw.arcs
	const nfa = rawNfa(ir, colors)
	const unaliased = withoutAliases(nfa)
	const copies = emptyCopies(unaliased.arcs, regexMaxHeldArcs - heldRaw)
	const optimized = raw.arcs + copies
	if (optimized + optimized > regexMaxHeldArcs) {
		return { kind: "arcs", limit: regexMaxHeldArcs }
	}
	const states = matchStates(unaliased)
	if (states > regexMaxMatchStates) {
		return { kind: "matchStates", limit: regexMaxMatchStates, needed: states }
	}
	const cells = states * colors.count
	if (cells > regexMaxMatchCells) {
		return { kind: "matchCells", limit: regexMaxMatchCells, needed: cells }
	}
	const anchors = movingAnchors(nfa)
	if (anchors > regexMaxAnchors) {
		return { kind: "anchors", limit: regexMaxAnchors, needed: anchors }
	}
	return undefined
}
