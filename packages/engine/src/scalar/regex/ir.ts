import { compareText } from "#compiler/core/canonical.ts"
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
 * A pattern's IR: a node of a language, or the empty language, which the constructors collapse to the root (a sequence
 * with an empty-language item is the empty language, an alternation drops such an arm, a repetition of one is the
 * empty string or the empty language), so a node's children are never it.
 */
export type RegexNode = { readonly kind: "never" } | LiveNode

/** A node of a language with a member, whose children are such nodes too. */
export type LiveNode =
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

export const empty: RegexNode = Object.freeze({ kind: "empty" })
const never: RegexNode = Object.freeze({ kind: "never" })
export const start: RegexNode = Object.freeze({ kind: "start" })
export const end: RegexNode = Object.freeze({ kind: "end" })

export const set = (s: CharSet): RegexNode =>
	isEmpty(s) ? never : Object.freeze({ kind: "set", set: s })

/**
 * The sequence of the items, flattened and normalized: a never item makes it never, empty items drop, and an assertion
 * right after the same assertion tests the same position again, so `^^` is `^`.
 */
export const seq = (items: ReadonlyArray<RegexNode>): RegexNode => {
	const flat: Array<LiveNode> = []
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
		if (item.kind === "empty") {
			continue
		}
		if (item.kind === "seq") {
			item.items.forEach(push)
		} else {
			push(item)
		}
	}
	const [only] = flat
	if (only === undefined) {
		return empty
	}
	if (flat.length === 1) {
		return only
	}
	return Object.freeze({ kind: "seq", items: Object.freeze(flat) })
}

/** `table`'s value for `node`, computed by `compute` the first time the table is asked for it. */
const tabled = <A>(table: Map<RegexNode, A>, node: RegexNode, compute: () => A): A => {
	const known = table.get(node)
	if (known !== undefined) {
		return known
	}
	const value = compute()
	table.set(node, value)
	return value
}

/** Above the written-out position budget (8 times regexMaxNodes, 4,096 in production). */
const rewriteBudget = 1 << 14

/** `body*` for a body with no zero-width match, which needs none of repeat's rewrites. */
const star = (body: RegexNode): RegexNode =>
	body.kind === "never" ? empty : Object.freeze({ kind: "repeat", body, min: 0, max: "unbounded" })

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
 * computed once while its builder lives, so it costs the DAG's size, never the size of the tree it unfolds to: a parse
 * builds its pattern with one builder, and each analysis this module exports on its own reads a builder of its call.
 */
export class RegexBuilder {
	readonly #keys = new Map<RegexNode, string>()
	readonly #zeroWidths = new Map<RegexNode, boolean>()
	readonly #zeroPaths = new Map<RegexNode, ZeroPaths>()
	readonly #loops = new Map<RegexNode, boolean>()
	readonly #zeroParts = new Map<RegexNode, RegexNode>()
	readonly #consumings = new Map<RegexNode, RegexNode>()
	readonly #sizes = new Map<RegexNode, number>()
	readonly #assertions = new Map<RegexNode, number>()

	/**
	 * A total, deterministic order on nodes, by their canonical text: JSON.stringify(node), built from the children's
	 * keys.
	 */
	#key(node: RegexNode): string {
		return tabled(this.#keys, node, () => {
			switch (node.kind) {
				case "seq":
					return `{"kind":"seq","items":[${node.items.map((item) => this.#key(item)).join(",")}]}`
				case "alt":
					return `{"kind":"alt","arms":[${node.arms.map((arm) => this.#key(arm)).join(",")}]}`
				case "repeat":
					return `{"kind":"repeat","body":${this.#key(node.body)},"min":${node.min},"max":${JSON.stringify(node.max)}}`
				case "empty":
				case "end":
				case "never":
				case "set":
				case "start":
					return JSON.stringify(node)
			}
		})
	}

	/**
	 * The alternation of the arms, flattened, deduplicated and sorted by canonical text: never arms drop, and the arms'
	 * sets merge into one set, which is nonempty because each of them is.
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
			flat.push(Object.freeze({ kind: "set", set: union(sets) }))
		}
		const byKey = new Map<string, LiveNode>()
		for (const arm of flat) {
			byKey.set(this.#key(arm), arm)
		}
		const sorted = [...byKey.entries()]
			.toSorted(([a], [b]) => compareText(a, b))
			.map(([, arm]) => arm)
		const [only] = sorted
		if (only === undefined) {
			return never
		}
		if (sorted.length === 1) {
			return only
		}
		return Object.freeze({ kind: "alt", arms: Object.freeze(sorted) })
	}

	/** Whether every match of the node is zero-width: it consumes no code point, only tests assertions. */
	#zeroWidth(node: RegexNode): boolean {
		return tabled(this.#zeroWidths, node, () => {
			switch (node.kind) {
				case "empty":
				case "never":
				case "start":
				case "end":
					return true
				case "set":
					return false
				case "seq":
					return node.items.every((item) => this.#zeroWidth(item))
				case "alt":
					return node.arms.every((arm) => this.#zeroWidth(arm))
				case "repeat":
					return this.#zeroWidth(node.body)
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
	 *   body out again, and nested loops through assertions compound it, so it applies only to a body within
	 *   `rewriteBudget` written-out positions; a larger one stays a constraint loop, which analyzeText refuses as
	 *   ResourceBound (loopsThroughAnchor), as it would refuse the rewritten pattern for its size.
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
			this.expandedSize(body) <= rewriteBudget
		) {
			return seq([this.repeat(body, min, min), star(this.#consuming(body))])
		}
		return Object.freeze({ kind: "repeat", body, min, max })
	}

	/** Whether a repetition still loops through an assertion: one whose rewrite exceeded `rewriteBudget`. */
	loopsThroughAnchor(node: RegexNode): boolean {
		return tabled(this.#loops, node, () => {
			switch (node.kind) {
				case "seq":
					return node.items.some((item) => this.loopsThroughAnchor(item))
				case "alt":
					return node.arms.some((arm) => this.loopsThroughAnchor(arm))
				case "repeat":
					return (
						(node.max === "unbounded" && this.#zeroPathsOf(node.body).asserted) ||
						this.loopsThroughAnchor(node.body)
					)
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
		return tabled(this.#zeroParts, node, () => {
			switch (node.kind) {
				case "empty":
				case "never":
				case "start":
				case "end":
					return node
				case "set":
					return never
				case "seq":
					return seq(node.items.map((item) => this.zeroPart(item)))
				case "alt":
					return this.alt(node.arms.map((arm) => this.zeroPart(arm)))
				case "repeat": {
					/** Zero-width iterations test their assertions at one position, so any positive number of them is one. */
					const once = this.zeroPart(node.body)
					return node.min === 0 ? this.alt([empty, once]) : once
				}
			}
		})
	}

	/**
	 * The consuming matches of a node: those that consume at least one code point. A sequence's split at the first item
	 * that consumes, the items before it matching zero-width.
	 */
	#consuming(node: RegexNode): RegexNode {
		return tabled(this.#consumings, node, () => {
			switch (node.kind) {
				case "empty":
				case "never":
				case "start":
				case "end":
					return never
				case "set":
					return node
				case "alt":
					return this.alt(node.arms.map((arm) => this.#consuming(arm)))
				case "seq":
					return this.alt(
						node.items.map((item, i) =>
							seq([
								...node.items.slice(0, i).map((before) => this.zeroPart(before)),
								this.#consuming(item),
								...node.items.slice(i + 1)
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
					const { body, min, max } = node
					const rest = (lo: number, hi: number | "unbounded"): RegexNode =>
						hi !== "unbounded" && hi < lo ? never : this.repeat(body, lo, hi)
					const first = seq([
						this.#consuming(body),
						rest(Math.max(min - 1, 0), max === "unbounded" ? max : max - 1)
					])
					const later = seq([
						this.zeroPart(body),
						this.#consuming(body),
						rest(0, max === "unbounded" ? max : max - 2)
					])
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
		return tabled(this.#sizes, node, () => {
			switch (node.kind) {
				case "seq":
					return node.items.reduce((n, item) => n + this.expandedSize(item), 0)
				case "alt":
					return node.arms.reduce(
						(n, arm) => (arm.kind === "empty" ? n : n + this.expandedSize(arm)),
						0
					)
				case "repeat":
					return copiesOf(node) * this.expandedSize(node.body)
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
		return tabled(this.#assertions, node, () => {
			switch (node.kind) {
				case "start":
				case "end":
					return 1
				case "seq":
					return node.items.reduce((n, item) => n + this.expandedAssertions(item), 0)
				case "alt":
					return node.arms.reduce((n, arm) => n + this.expandedAssertions(arm), 0)
				case "repeat":
					return copiesOf(node) * this.expandedAssertions(node.body)
				case "empty":
				case "never":
				case "set":
					return 0
			}
		})
	}

	#zeroPathsOf(node: RegexNode): ZeroPaths {
		return tabled(this.#zeroPaths, node, () => {
			switch (node.kind) {
				case "empty":
					return { plain: true, asserted: false }
				case "start":
				case "end":
					return { plain: false, asserted: true }
				case "never":
				case "set":
					return { plain: false, asserted: false }
				case "seq": {
					const paths = node.items.map((item) => this.#zeroPathsOf(item))
					const passable = paths.every((p) => p.plain || p.asserted)
					return {
						plain: paths.every((p) => p.plain),
						asserted: passable && paths.some((p) => p.asserted)
					}
				}
				case "alt": {
					const paths = node.arms.map((arm) => this.#zeroPathsOf(arm))
					return { plain: paths.some((p) => p.plain), asserted: paths.some((p) => p.asserted) }
				}
				case "repeat": {
					const body = this.#zeroPathsOf(node.body)
					return { plain: node.min === 0 || body.plain, asserted: body.asserted }
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
