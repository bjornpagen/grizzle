import { defect } from "#compiler/core/invariant.ts"
import { regexMaxPositions } from "#compiler/core/limits.ts"
import { postorder } from "#compiler/ir/dag.ts"
import { type CharSet, isEmpty, union } from "#compiler/scalar/regex/charset.ts"

/**
 * The checked regex IR.
 *
 * ArkRegex supplies no runtime syntax tree, so the compiler parses the admitted source grammar into this IR, which
 * checks declarations and generates SQL; it never validates application values. The IR denotes
 * a language of match spans, not of whole strings: membership asks whether a match exists anywhere in the value, as
 * ECMAScript's RegExp.prototype.test and PostgreSQL's `~` both do. Captures are not outputs, so
 * groups leave no node behind. The flags vanish into the IR too: dot is an explicit CharSet chosen by
 * the `s` flag, so two declarations with equal IR recognize the same values.
 *
 * Nodes are built only through the smart constructors below, which keep the IR normalized by language-preserving
 * rewrites alone: flattening, dropping the empty language and the empty string where they are units, writing an
 * optional body as its alternation with the empty string, merging single-code-point arms into one class, ordering the
 * arms of an alternation, which is commutative for match existence, collapsing repeated assertions and repetitions of
 * zero-width bodies, and writing an unbounded repetition that could loop through an assertion as one whose loop
 * consumes (see repeat). Equal normalized IR is therefore a proof of equal languages, never a cosmetic string rewrite;
 * the converse need not hold, which is what the automaton key in dfa.ts adds.
 *
 * A pattern's IR: a node of a language with a member, or the empty language, which the constructors collapse to the
 * root (a sequence with an empty-language item is the empty language, an alternation drops such an arm, a repetition
 * of one is the empty string or the empty language), so a node's children are never it.
 *
 * Every live node carries its profiles (number): the set of what its paths pass, each path's profile three bits, that
 * it consumes a code point, that it passes `^`, that it passes `$`. Under the admitted flags, u and su, `^` holds only
 * at a value's start and `$` only at its end; the grammar has no other assertion, and every class holds an admitted code
 * point. So a path matches within some value exactly when no code point comes before a `^` it passes and none after a
 * `$`, and a node has a member exactly when one of its paths does. Each constructor computes its node's profiles from
 * its children's and makes a node with none the empty language, so a live node has a member by construction: `^$a` is
 * the empty language, as `[]` is. The profiles are no part of the language's spelling: the canonical text, the order
 * of an alternation's arms and every key read past them.
 *
 * The IR may nest to any depth: every walk of it keeps its frames on the heap, never the call stack. Its analyses fold
 * children first (folded), its canonical text and order read pieces off a stack (canonicalText, compareCanonical), and
 * so do the NFA builder (nfa.ts), the ARE printer (are.ts) and the length bounds (text/bounds.ts).
 */
export type RegexNode = { readonly kind: "never" } | LiveNode

/** The shape of a live node: what its language is spelled by. */
type Shape =
	| { readonly kind: "empty" }
	| { readonly kind: "set"; readonly set: CharSet }
	| { readonly kind: "start" }
	| { readonly kind: "end" }
	| { readonly kind: "seq"; readonly items: ReadonlyArray<LiveNode> }
	| { readonly kind: "alt"; readonly arms: ReadonlyArray<LiveNode> }
	| {
			readonly kind: "repeat"
			readonly body: LiveNode
			readonly min: number
			readonly max: number | "unbounded"
	  }

/**
 * A path's profile is a number of three bits: it consumes a code point (consumes), it passes `^` (passesStart), it
 * passes `$` (passesEnd). The empty string's path has none of them (passesNothing).
 */
const passesNothing = 0b000
const consumes = 0b001
const passesStart = 0b010
const passesEnd = 0b100

/**
 * The profiles a path can have, every combination of its three bits.
 *
 * @formatConstant the combinations of a path profile's three bits
 */
const profileCount = 0b1000

/** The set of one profile. A set of profiles is a number whose bit p is set when the set holds profile p. */
const just = (p: number): number => 1 << p

/** The empty set of profiles: exactly the empty language's paths. */
const noProfiles = 0

/**
 * Whether a path of profile `q` can follow one of profile `p` within a match: no code point before a `^` and none after
 * a `$`, the one order the anchors of the u and su flags admit.
 */
const canFollow = (p: number, q: number): boolean =>
	!((p & consumes) !== 0 && (q & passesStart) !== 0) &&
	!((p & passesEnd) !== 0 && (q & consumes) !== 0)

/** The profiles of a path of `a` followed by one of `b`: every pair that can follow, the two profiles' bits joined. */
const followed = (a: number, b: number): number => {
	let out = noProfiles
	for (let p = 0; p < profileCount; p++) {
		if ((a & just(p)) !== 0) {
			for (let q = 0; q < profileCount; q++) {
				if ((b & just(q)) !== 0 && canFollow(p, q)) {
					out |= just(p | q)
				}
			}
		}
	}
	return out
}

/**
 * The profiles of `min` to `max` copies of a body of profiles `body` in sequence. The profiles of k + 1 copies are a
 * function of those of k, so once two counts in a row have the same set, every later count has it too; every set of
 * the eight profiles reaches it by its fourth copy, so a repetition's profiles cost a few steps whatever its counts.
 */
const repeated = (body: number, min: number, max: number | "unbounded"): number => {
	let out = noProfiles
	let copies = just(passesNothing)
	for (let k = 0; ; k++) {
		if (k >= min) {
			out |= copies
		}
		if (k === max) {
			return out
		}
		const next = followed(copies, body)
		if (next === copies) {
			return out | copies
		}
		copies = next
	}
}

/** A node of a language with a member, whose children are such nodes too, with its paths' profiles, never none. */
export type LiveNode = Shape & { readonly profiles: number }

export const empty: LiveNode = Object.freeze({ kind: "empty", profiles: just(passesNothing) })
const never: RegexNode = Object.freeze({ kind: "never" })
export const start: LiveNode = Object.freeze({ kind: "start", profiles: just(passesStart) })
export const end: LiveNode = Object.freeze({ kind: "end", profiles: just(passesEnd) })

/** The set node of a set with a member. */
const liveSet = (s: CharSet): LiveNode =>
	Object.freeze({ kind: "set", set: s, profiles: just(consumes) })

export const set = (s: CharSet): RegexNode => (isEmpty(s) ? never : liveSet(s))

/**
 * The sequence of the items, flattened and normalized: a never item makes it never, and so does an order of anchors no
 * path can pass (a code point before a `^`, or after a `$`, on every path); empty items drop, and an assertion right
 * after the same assertion tests the same position again, so `^^` is `^`.
 */
export const seq = (items: ReadonlyArray<RegexNode>): RegexNode => {
	const flat: Array<LiveNode> = []
	let profiles = just(passesNothing)
	const push = (item: LiveNode): void => {
		if (
			(item.kind === "start" || item.kind === "end") &&
			flat[flat.length - 1]?.kind === item.kind
		) {
			return
		}
		flat.push(item)
	}
	for (const item of items) {
		if (item.kind === "never") {
			return never
		}
		profiles = followed(profiles, item.profiles)
		if (item.kind === "empty") {
			continue
		}
		if (item.kind === "seq") {
			item.items.forEach(push)
		} else {
			push(item)
		}
	}
	if (profiles === noProfiles) {
		return never
	}
	const [only] = flat
	if (only === undefined) {
		return empty
	}
	if (flat.length === 1) {
		return only
	}
	return Object.freeze({ kind: "seq", items: Object.freeze(flat), profiles })
}

/** A node's children, in order: a sequence's items, an alternation's arms, a repetition's body. */
const childrenOf = (node: RegexNode): ReadonlyArray<LiveNode> => {
	switch (node.kind) {
		case "seq":
			return node.items
		case "alt":
			return node.arms
		case "repeat":
			return [node.body]
		case "empty":
		case "end":
		case "never":
		case "set":
		case "start":
			return []
	}
}

/**
 * `table`'s value for `root`, which `compute` gives each node below it that the table lacks first, every node after
 * its children (ir/dag.ts postorder, whose frames are on the heap), so an analysis reads a node of any depth without
 * recursing. `compute` reads a child's value through `of`. The one site of the fact that the order tables each child
 * before its parent.
 */
export const folded = <N extends RegexNode, A>(
	table: Map<RegexNode, A>,
	root: N,
	compute: (node: N | LiveNode, of: (child: LiveNode) => A) => A
): A => {
	const of = (node: RegexNode): A => {
		const value = table.get(node)
		if (value === undefined) {
			throw defect("a regex node's analysis, which postorder tables before its parent's")
		}
		return value
	}
	for (const node of postorder<N | LiveNode>([root], (n) => (table.has(n) ? [] : childrenOf(n)))) {
		if (!table.has(node)) {
			table.set(node, compute(node, of))
		}
	}
	return of(root)
}

/** The pieces of a list in a node's canonical text: its opening, the nodes separated by commas, and its closing. */
const listed = (open: string, nodes: ReadonlyArray<LiveNode>): ReadonlyArray<string | LiveNode> => {
	const out: Array<string | LiveNode> = [open]
	for (const [i, node] of nodes.entries()) {
		if (i > 0) {
			out.push(",")
		}
		out.push(node)
	}
	out.push("]}")
	return out
}

/** A node's canonical text as its pieces: literal text, and the children whose own canonical text stands there. */
type Pieces = ReadonlyArray<string | LiveNode>

/**
 * A node's canonical text, the JSON text of its shape (JSON.stringify of the node without its profiles), as its pieces,
 * kept in `table`: nodes are immutable, so each node's pieces are written once while the table lives.
 */
const piecesOf = (node: RegexNode, table: Map<RegexNode, Pieces>): Pieces => {
	const known = table.get(node)
	if (known !== undefined) {
		return known
	}
	const pieces = writtenPieces(node)
	table.set(node, pieces)
	return pieces
}

const writtenPieces = (node: RegexNode): Pieces => {
	switch (node.kind) {
		case "seq":
			return listed(`{"kind":"seq","items":[`, node.items)
		case "alt":
			return listed(`{"kind":"alt","arms":[`, node.arms)
		case "repeat":
			return [
				`{"kind":"repeat","body":`,
				node.body,
				`,"min":${node.min},"max":${JSON.stringify(node.max)}}`
			]
		case "set":
			return [`{"kind":"set","set":${JSON.stringify(node.set)}}`]
		case "empty":
		case "end":
		case "never":
		case "start":
			return [`{"kind":"${node.kind}"}`]
	}
}

/**
 * A node's canonical text, the JSON text of its shape, written from its pieces on a stack of the pieces still to write,
 * so a node of any depth is written without recursing.
 */
export const canonicalText = (node: RegexNode): string => {
	const table = new Map<RegexNode, Pieces>()
	const out: Array<string> = []
	const pending: Array<string | RegexNode> = [node]
	for (let piece = pending.pop(); piece !== undefined; piece = pending.pop()) {
		if (typeof piece === "string") {
			out.push(piece)
		} else {
			for (const inner of piecesOf(piece, table).toReversed()) {
				pending.push(inner)
			}
		}
	}
	return out.join("")
}

/**
 * A reading of a node's canonical text, left to right: the pieces still to read, the next one last, and the literal
 * being read with how far into it the reading is.
 */
interface Reading {
	readonly pending: Array<string | RegexNode>
	text: string
	at: number
}

/**
 * Where a reading stands once the literal it reads is spent: inside a literal ("text"), past its last piece ("end"), or
 * at a node, taken off the pieces still to read, whose text comes next.
 */
const settle = (reading: Reading): RegexNode | "text" | "end" => {
	while (reading.at === reading.text.length) {
		const piece = reading.pending.pop()
		if (piece === undefined) {
			return "end"
		}
		if (typeof piece !== "string") {
			return piece
		}
		reading.text = piece
		reading.at = 0
	}
	return "text"
}

/** Goes on reading a node's text: its pieces come next. */
const enter = (reading: Reading, node: RegexNode, table: Map<RegexNode, Pieces>): void => {
	for (const piece of piecesOf(node, table).toReversed()) {
		reading.pending.push(piece)
	}
}

/**
 * The order of two nodes' canonical texts (core/canonical.ts compareText, UTF-16 code-unit order), read from their
 * pieces (kept in `table`) without writing either text: the two readings advance together, a node met at the same
 * place in both is skipped whole, and so is a literal both read whole, and the first code unit that differs decides.
 * It reads only up to that unit, past any subtree the two share, so ordering costs no node's whole text and a node of
 * any depth compares without recursing.
 */
const compareCanonical = (a: RegexNode, b: RegexNode, table: Map<RegexNode, Pieces>): number => {
	const x: Reading = { pending: [a], text: "", at: 0 }
	const y: Reading = { pending: [b], text: "", at: 0 }
	for (;;) {
		const p = settle(x)
		const q = settle(y)
		if (p === "end" || q === "end") {
			return p === q ? 0 : p === "end" ? -1 : 1
		}
		if (p === "text" && q === "text") {
			if (x.at === 0 && y.at === 0 && x.text === y.text) {
				x.at = x.text.length
				y.at = y.text.length
				continue
			}
			const n = Math.min(x.text.length - x.at, y.text.length - y.at)
			for (let i = 0; i < n; i++) {
				const d = x.text.charCodeAt(x.at + i) - y.text.charCodeAt(y.at + i)
				if (d !== 0) {
					return d < 0 ? -1 : 1
				}
			}
			x.at += n
			y.at += n
		} else if (p !== q) {
			if (p !== "text") {
				enter(x, p, table)
			}
			if (q !== "text") {
				enter(y, q, table)
			}
		}
	}
}

/** `body*` for a body with no zero-width match, which needs none of repeat's rewrites. */
const star = (body: RegexNode): RegexNode =>
	body.kind === "never"
		? empty
		: Object.freeze({
				kind: "repeat",
				body,
				min: 0,
				max: "unbounded",
				profiles: repeated(body.profiles, 0, "unbounded")
			})

/** The iterations a repetition's maximum leaves once one more is written out: an unbounded maximum stays unbounded. */
const lessOne = (max: number | "unbounded"): number | "unbounded" =>
	max === "unbounded" ? max : max - 1

/**
 * How many copies of its body a repetition writes out: its maximum, or for an unbounded one max(min, 1) and a loop
 * back over the last copy. The NFA builder (nfa.ts) writes exactly these.
 */
export const copiesOf = (node: Extract<RegexNode, { readonly kind: "repeat" }>): number =>
	node.max === "unbounded" ? Math.max(node.min, 1) : node.max

/**
 * How the node can match without consuming a code point: `plain` through no assertion, `asserted` through at least
 * one. A repetition of a body with an asserted zero-width match is what closes a constraint loop (see repeat).
 */
interface ZeroPaths {
	readonly plain: boolean
	readonly asserted: boolean
}

/**
 * The constructors that read the IR's analyses, alternation and repetition, and the analyses themselves. Nodes are
 * immutable and shared, so the IR is a DAG; the rewrites below share subtrees freely. Each analysis of a node is
 * computed once while its builder lives, folded children first (folded), so it costs the DAG's size, never the size of
 * the tree it unfolds to, and no depth: a parse builds its pattern with one builder, and each analysis this module
 * exports on its own reads a builder of its call.
 */
export class RegexBuilder {
	readonly #pieces = new Map<RegexNode, Pieces>()
	readonly #zeroWidths = new Map<RegexNode, boolean>()
	readonly #zeroPaths = new Map<RegexNode, ZeroPaths>()
	readonly #loops = new Map<RegexNode, boolean>()
	readonly #zeroParts = new Map<RegexNode, RegexNode>()
	readonly #consumings = new Map<RegexNode, RegexNode>()
	readonly #sizes = new Map<RegexNode, number>()
	readonly #assertions = new Map<RegexNode, number>()

	/**
	 * The alternation of the arms, flattened, deduplicated and sorted by canonical text (compareCanonical): never arms
	 * drop, and the arms' sets merge into one set, which is nonempty because each of them is. Its profiles are its arms'.
	 */
	alt(arms: ReadonlyArray<RegexNode>): RegexNode {
		const flat: Array<LiveNode> = []
		const sets: Array<CharSet> = []
		const visit = (arm: RegexNode): void => {
			if (arm.kind === "never") {
				return
			}
			if (arm.kind === "alt") {
				arm.arms.forEach(visit)
			} else if (arm.kind === "set") {
				sets.push(arm.set)
			} else {
				flat.push(arm)
			}
		}
		arms.forEach(visit)
		if (sets.length > 0) {
			flat.push(liveSet(union(sets)))
		}
		const compare = (a: LiveNode, b: LiveNode): number => compareCanonical(a, b, this.#pieces)
		const sorted: Array<LiveNode> = []
		for (const arm of flat.toSorted(compare)) {
			const previous = sorted.at(-1)
			if (previous === undefined || compare(previous, arm) !== 0) {
				sorted.push(arm)
			}
		}
		const [only] = sorted
		if (only === undefined) {
			return never
		}
		if (sorted.length === 1) {
			return only
		}
		const profiles = sorted.reduce((all, arm) => all | arm.profiles, noProfiles)
		return Object.freeze({ kind: "alt", arms: Object.freeze(sorted), profiles })
	}

	/** Whether every match of the node is zero-width: it consumes no code point, only tests assertions. */
	#zeroWidth(node: RegexNode): boolean {
		return folded(this.#zeroWidths, node, (n, of) => {
			switch (n.kind) {
				case "empty":
				case "never":
				case "start":
				case "end":
					return true
				case "set":
					return false
				case "seq":
					return n.items.every((item) => of(item))
				case "alt":
					return n.arms.every((arm) => of(arm))
				case "repeat":
					return of(n.body)
			}
		})
	}

	/**
	 * The repetition of a body, normalized:
	 * - An optional body is the alternation of the empty string and the body: `x?`, `x{0,1}` and `(?:x|)` are one node,
	 *   so every measure of the IR, and the budgets that read them, judge the one ARE all three print as.
	 * - A zero-width body tests its assertions at one position however often it repeats, so one copy is the same
	 *   language, and an optional copy when the minimum is zero: `(?:^){255}` is `^` and `(?:^)*` is `(?:^)?`. Without
	 *   this, a repeated assertion writes out copies that recognize nothing more, and a loop of assertions is a
	 *   constraint loop, which PostgreSQL's regex compiler breaks by cloning every successor state.
	 * - An unbounded repetition of a body that can match zero-width through an assertion, such as `(?:a|$)*`, closes a
	 *   constraint loop: a cycle of empty and constraint arcs, which PostgreSQL's regex compiler breaks by cloning
	 *   successor states, exponentially in the assertions on the cycle (regc_nfa.c fixconstraintloops;
	 *   `(?:(?:.|$|){0,6})+b` is already too complex for it). A zero-width iteration leaves the position where it was
	 *   and only adds tests, so it can be dropped from any sequence of iterations that keeps at least the minimum count:
	 *   B{m,} is B{m} followed by any number of consuming iterations, which has no such cycle. The rewrite writes the
	 *   body out again, and nested loops through assertions compound it, so it applies only to a body within the
	 *   compile-space measure's regexMaxPositions written-out positions; a larger one stays a constraint loop, which
	 *   analyzeText refuses as ResourceBound (loopsThroughAnchor), as the measure would refuse the rewritten pattern.
	 * - A repetition none of whose counts has a path is the empty language: `(?:^a){2}` is never.
	 */
	repeat(body: RegexNode, min: number, max: number | "unbounded"): RegexNode {
		if (max === 0) {
			return empty
		}
		if (body.kind === "empty") {
			return empty
		}
		if (body.kind === "never") {
			return min === 0 ? empty : never
		}
		if (min === 1 && max === 1) {
			return body
		}
		if (min === 0 && max === 1) {
			return this.alt([empty, body])
		}
		if (this.#zeroWidth(body)) {
			return min === 0 ? this.alt([empty, body]) : body
		}
		if (
			max === "unbounded" &&
			this.#zeroPathsOf(body).asserted &&
			this.expandedSize(body) <= regexMaxPositions.value
		) {
			return seq([this.repeat(body, min, min), star(this.#consuming(body))])
		}
		const profiles = repeated(body.profiles, min, max)
		return profiles === noProfiles
			? never
			: Object.freeze({ kind: "repeat", body, min, max, profiles })
	}

	/**
	 * Whether a repetition still loops through an assertion: one whose body the rewrite left alone, its written-out
	 * positions past the compile-space measure's regexMaxPositions (core/limits.ts), so the measure refuses its pattern
	 * as it would the rewritten one.
	 */
	loopsThroughAnchor(node: RegexNode): boolean {
		return folded(this.#loops, node, (n, of) => {
			switch (n.kind) {
				case "seq":
					return n.items.some((item) => of(item))
				case "alt":
					return n.arms.some((arm) => of(arm))
				case "repeat":
					return (n.max === "unbounded" && this.#zeroPathsOf(n.body).asserted) || of(n.body)
				case "empty":
				case "never":
				case "set":
				case "start":
				case "end":
					return false
			}
		})
	}

	/** The zero-width matches of a node: what it matches without consuming a code point, as a zero-width node. */
	zeroPart(node: RegexNode): RegexNode {
		return folded(this.#zeroParts, node, (n, of) => {
			switch (n.kind) {
				case "empty":
				case "never":
				case "start":
				case "end":
					return n
				case "set":
					return never
				case "seq":
					return seq(n.items.map((item) => of(item)))
				case "alt":
					return this.alt(n.arms.map((arm) => of(arm)))
				case "repeat": {
					/** Zero-width iterations test their assertions at one position, so any positive number of them is one. */
					const once = of(n.body)
					return n.min === 0 ? this.alt([empty, once]) : once
				}
			}
		})
	}

	/**
	 * The consuming matches of a node: those that consume at least one code point. A sequence's split at the first item
	 * that consumes, the items before it matching zero-width.
	 */
	#consuming(node: RegexNode): RegexNode {
		return folded(this.#consumings, node, (n, of) => {
			switch (n.kind) {
				case "empty":
				case "never":
				case "start":
				case "end":
					return never
				case "set":
					return n
				case "alt":
					return this.alt(n.arms.map((arm) => of(arm)))
				case "seq":
					return this.alt(
						n.items.map((item, i) =>
							seq([
								...n.items.slice(0, i).map((before) => this.zeroPart(before)),
								of(item),
								...n.items.slice(i + 1)
							])
						)
					)
				case "repeat": {
					/**
					 * Split at the first iteration that consumes. Either it is the first, or one or more zero-width
					 * iterations precede it; those test their assertions at one position, so they are one zero-width
					 * match, and however many there were, the count of the remaining iterations can be anything up to
					 * max - 2 while the whole stays within min..max.
					 */
					const { body, min, max } = n
					const rest = (lo: number, hi: number | "unbounded"): RegexNode =>
						hi !== "unbounded" && hi < lo ? never : this.repeat(body, lo, hi)
					const first = seq([of(body), rest(Math.max(min - 1, 0), lessOne(max))])
					const later = seq([this.zeroPart(body), of(body), rest(0, lessOne(lessOne(max)))])
					return this.alt([first, later])
				}
			}
		})
	}

	/**
	 * The number of NFA positions once every counted repetition is written out, the size of the automaton both the
	 * host simulator and PostgreSQL's regex compiler build before optimizing it. Every node is at least one position,
	 * an assertion or the empty string included: a repeated body is always written out, so a body that consumes
	 * nothing still costs its copies. An unbounded repetition costs its body once more than its minimum. The empty arm
	 * of an alternation costs nothing: the ARE writes such an alternation as an optional group, an empty arc beside its
	 * body.
	 */
	expandedSize(node: RegexNode): number {
		return folded(this.#sizes, node, (n, of) => {
			switch (n.kind) {
				case "seq":
					return n.items.reduce((total, item) => total + of(item), 0)
				case "alt":
					return n.arms.reduce((total, arm) => (arm.kind === "empty" ? total : total + of(arm)), 0)
				case "repeat":
					return copiesOf(n) * of(n.body)
				case "empty":
				case "never":
				case "set":
				case "start":
				case "end":
					return 1
			}
		})
	}

	/**
	 * The number of assertion positions once counted repetitions are written out. PostgreSQL eliminates each `\A` and
	 * `\Z` constraint by pulling it back towards the start or pushing it forward towards the end, cloning the states it
	 * crosses, so its compile space grows with this count times the automaton's size.
	 */
	expandedAssertions(node: RegexNode): number {
		return folded(this.#assertions, node, (n, of) => {
			switch (n.kind) {
				case "start":
				case "end":
					return 1
				case "seq":
					return n.items.reduce((total, item) => total + of(item), 0)
				case "alt":
					return n.arms.reduce((total, arm) => total + of(arm), 0)
				case "repeat":
					return copiesOf(n) * of(n.body)
				case "empty":
				case "never":
				case "set":
					return 0
			}
		})
	}

	#zeroPathsOf(node: RegexNode): ZeroPaths {
		return folded(this.#zeroPaths, node, (n, of) => {
			switch (n.kind) {
				case "empty":
					return { plain: true, asserted: false }
				case "start":
				case "end":
					return { plain: false, asserted: true }
				case "never":
				case "set":
					return { plain: false, asserted: false }
				case "seq": {
					const paths = n.items.map((item) => of(item))
					const passable = paths.every((p) => p.plain || p.asserted)
					return {
						plain: paths.every((p) => p.plain),
						asserted: passable && paths.some((p) => p.asserted)
					}
				}
				case "alt": {
					const paths = n.arms.map((arm) => of(arm))
					return { plain: paths.some((p) => p.plain), asserted: paths.some((p) => p.asserted) }
				}
				case "repeat": {
					const body = of(n.body)
					return { plain: n.min === 0 || body.plain, asserted: body.asserted }
				}
			}
		})
	}
}

/** Whether a repetition of the IR still loops through an assertion (RegexBuilder.loopsThroughAnchor). */
export const loopsThroughAnchor = (node: RegexNode): boolean =>
	new RegexBuilder().loopsThroughAnchor(node)

/** The NFA positions of a node once its counted repetitions are written out (RegexBuilder.expandedSize). */
export const expandedSize = (node: RegexNode): number => new RegexBuilder().expandedSize(node)

/** The assertion positions of a node once its counted repetitions are written out (RegexBuilder.expandedAssertions). */
export const expandedAssertions = (node: RegexNode): number =>
	new RegexBuilder().expandedAssertions(node)
