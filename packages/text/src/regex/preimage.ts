import { postorder } from "#text/base/graph.ts"
import { defect } from "#text/base/invariant.ts"
import * as Result from "#text/base/result.ts"
import {
	type CharSet,
	charSet,
	complement,
	domain,
	has,
	intersection,
	union
} from "#text/regex/charset.ts"
import { assertsAnywhere, lastIn, mapSets } from "#text/regex/folds.ts"
import {
	folded,
	type LiveNode,
	never,
	RegexBuilder,
	type RegexNode,
	seq,
	set
} from "#text/regex/ir.ts"

/**
 * XML Schema's whiteSpace facets read backwards over the regex IR (XML Schema 1.0 Part 2, §4.3.6): the texts a value
 * may be written as, whose `replace`d or `collapse`d form lies in a language, exactly, and the tokens of a list's item
 * type, its words of no whitespace. Each takes a language of whole texts, a node of no assertion, and answers one, so a
 * facet composition reads a domain's written forms as one node and prints it once. pantry's grammar/domains.ts
 * foldReplace, foldCollapse and asToken (UNIFY's op 5), on the one IR and its heap-held walks.
 */

/** The space, U+0020. */
const space = 0x20

/** Tab, line feed and carriage return: the whitespace `replace` turns into the space. */
const breaks: CharSet = charSet([
	[0x09, 0x0a],
	[0x0d, 0x0d]
])

/** XML's whitespace: the space and the breaks. */
const whitespace: CharSet = union([breaks, charSet([[space, space]])])

/** Every code point but whitespace. */
const solid: CharSet = intersection(domain, complement(whitespace))

/** Why a language's collapse pre-image is refused. */
export type CollapseRefusal = { readonly kind: "assertion" } | { readonly kind: "unmerged" }

/**
 * The texts whose `replace`d form lies in `node`'s language: each code point the language holds as the space may be
 * written as any whitespace, and no other may be a break, so a set that holds the space holds the breaks too, and a set
 * that does not holds none of them.
 */
export const replacePreimage = (node: RegexNode): RegexNode =>
	mapSets(node, (s) =>
		set(has(s, space) ? union([s, breaks]) : intersection(s, complement(breaks)))
	)

/**
 * A list item's tokens: the item type's nonempty words of no whitespace, exactly. A set with the whitespace taken out of
 * it reads only the words that hold none; of those, the nonempty ones are the node itself where it has no empty word, a
 * repetition counted from one where only its zero count is empty, and its consuming matches otherwise
 * (RegexBuilder.firstIn over the whole domain).
 */
export const tokenOf = (node: RegexNode): RegexNode => {
	const builder = new RegexBuilder()
	const bare = mapSets(node, (s) => set(intersection(s, complement(whitespace))))
	if (builder.zeroPart(bare).kind === "never") {
		return bare
	}
	if (bare.kind === "repeat" && bare.min === 0 && builder.zeroPart(bare.body).kind === "never") {
		return builder.repeat(bare.body, 1, bare.max)
	}
	return builder.firstIn(bare, domain)
}

/** Where a language's words may hold a space: two together, at either end, or none at all. */
interface Spaces {
	readonly doubled: boolean
	readonly first: boolean
	readonly last: boolean
	readonly nullable: boolean
}

/** Whether a repetition can run twice in a row: more than one iteration. */
const loops = (n: Extract<LiveNode, { readonly kind: "repeat" }>): boolean =>
	n.max === "unbounded" || n.max > 1

/**
 * Where a node's words may hold a space, by Glushkov's first, last and follow sets folded children first: sound, so a
 * false is a proof. Its sets hold no break.
 */
const spacesOf = (node: RegexNode): Spaces =>
	folded(new Map<RegexNode, Spaces>(), node, (n, of) => {
		switch (n.kind) {
			case "set": {
				const s = has(n.set, space)
				return { doubled: false, first: s, last: s, nullable: false }
			}
			case "seq":
				return n.items.reduce<Spaces>(
					(left, item) => {
						const right = of(item)
						return {
							doubled: left.doubled || right.doubled || (left.last && right.first),
							first: left.first || (left.nullable && right.first),
							last: right.last || (right.nullable && left.last),
							nullable: left.nullable && right.nullable
						}
					},
					{ doubled: false, first: false, last: false, nullable: true }
				)
			case "alt": {
				const arms = n.arms.map((arm) => of(arm))
				return {
					doubled: arms.some((a) => a.doubled),
					first: arms.some((a) => a.first),
					last: arms.some((a) => a.last),
					nullable: arms.some((a) => a.nullable)
				}
			}
			case "repeat": {
				const body = of(n.body)
				return {
					doubled: body.doubled || (loops(n) && body.last && body.first),
					first: body.first,
					last: body.last,
					nullable: n.min === 0 || body.nullable
				}
			}
			case "empty":
			case "start":
			case "end":
			case "never":
				return { doubled: false, first: false, last: false, nullable: true }
		}
	})

/**
 * The unbounded repetition a position is one whole iteration of, reached through alternations alone, with its least
 * count: a word may give that iteration up where its least count is 0, and two adjacent iterations may become one where
 * it is at most 1.
 */
interface Run {
	readonly min: number
}

/** One code point position of a node, Glushkov's: whether its set holds the space, and the run it iterates, if any. */
interface Position {
	readonly space: boolean
	readonly run: Run | undefined
}

/** A node read where its position's run is `run`: one occurrence, which Glushkov's sets number apart. */
interface Occurrence {
	readonly node: LiveNode
	readonly run: Run | undefined
}

/** Glushkov's sets of an occurrence, its follow pairs read for one question: whether two spaces may not merge. */
interface Glushkov {
	readonly first: ReadonlyArray<Position>
	readonly last: ReadonlyArray<Position>
	readonly nullable: boolean
	readonly unmerged: boolean
}

/**
 * Whether two space positions a word may hold one after the other may fail to merge into one: neither is a whole
 * iteration its run may give up, and they are no two iterations of one run of least count at most 1.
 */
const unmergeable = (from: Position, to: Position): boolean =>
	from.space &&
	to.space &&
	!(from.run !== undefined && from.run === to.run && from.run.min <= 1) &&
	from.run?.min !== 0 &&
	to.run?.min !== 0

/** Whether a word may hold some position of `last` just before one of `first` that may not merge with it. */
const joinsUnmerged = (last: ReadonlyArray<Position>, first: ReadonlyArray<Position>): boolean =>
	last.some((from) => first.some((to) => unmergeable(from, to)))

/**
 * Whether merging every two spaces that stand together keeps each word of a node in its language, by Glushkov's
 * sets over its positions, each with its run: sound, so a true is a proof. Two space positions merge safely where both
 * are whole iterations of one unbounded repetition of least count at most 1, or either is one of a repetition of
 * least count 0. Each occurrence is read once, after its children, on the heap.
 */
const mergeSafe = (node: LiveNode): boolean => {
	const occurrences = new Map<LiveNode, Map<Run | undefined, Occurrence>>()
	const occurrence = (n: LiveNode, run: Run | undefined): Occurrence => {
		const byRun = occurrences.get(n) ?? new Map<Run | undefined, Occurrence>()
		occurrences.set(n, byRun)
		const known = byRun.get(run)
		if (known !== undefined) {
			return known
		}
		const made: Occurrence = { node: n, run }
		byRun.set(run, made)
		return made
	}
	const runs = new Map<Occurrence, Run>()
	/** The run an unbounded repetition's occurrence is, one per occurrence, so two copies of one node are two runs. */
	const runOf = (
		o: Occurrence,
		n: Extract<LiveNode, { readonly kind: "repeat" }>
	): Run | undefined => {
		if (n.max !== "unbounded") {
			return undefined
		}
		const known = runs.get(o) ?? { min: n.min }
		runs.set(o, known)
		return known
	}
	const inputs = (o: Occurrence): ReadonlyArray<Occurrence> => {
		const n = o.node
		switch (n.kind) {
			case "seq":
				return n.items.map((item) => occurrence(item, undefined))
			case "alt":
				return n.arms.map((arm) => occurrence(arm, o.run))
			case "repeat":
				return [occurrence(n.body, runOf(o, n))]
			case "set":
			case "empty":
			case "start":
			case "end":
				return []
		}
	}
	const sets = new Map<Occurrence, Glushkov>()
	const of = (o: Occurrence): Glushkov => {
		const known = sets.get(o)
		if (known === undefined) {
			defect("an occurrence's Glushkov sets, which postorder tables before its parent's")
		}
		return known
	}
	const root = occurrence(node, undefined)
	for (const o of postorder([root], inputs)) {
		const n = o.node
		const children = inputs(o).map(of)
		switch (n.kind) {
			case "set": {
				const position: Position = { space: has(n.set, space), run: o.run }
				sets.set(o, { first: [position], last: [position], nullable: false, unmerged: false })
				break
			}
			case "seq": {
				sets.set(
					o,
					children.reduce<Glushkov>(
						(left, right) => ({
							first: left.nullable ? [...left.first, ...right.first] : left.first,
							last: right.nullable ? [...left.last, ...right.last] : right.last,
							nullable: left.nullable && right.nullable,
							unmerged: left.unmerged || right.unmerged || joinsUnmerged(left.last, right.first)
						}),
						{ first: [], last: [], nullable: true, unmerged: false }
					)
				)
				break
			}
			case "alt":
				sets.set(o, {
					first: children.flatMap((c) => c.first),
					last: children.flatMap((c) => c.last),
					nullable: children.some((c) => c.nullable),
					unmerged: children.some((c) => c.unmerged)
				})
				break
			case "repeat": {
				const [body] = children
				if (body === undefined) {
					defect("a repetition's body")
				}
				sets.set(o, {
					first: body.first,
					last: body.last,
					nullable: n.min === 0 || body.nullable,
					unmerged: body.unmerged || (loops(n) && joinsUnmerged(body.last, body.first))
				})
				break
			}
			case "empty":
			case "start":
			case "end":
				sets.set(o, { first: [], last: [], nullable: true, unmerged: false })
				break
		}
	}
	return !of(root).unmerged
}

/** A node read where it is, or is not, one whole iteration of a run of least count at most 1 (spacesToRuns). */
interface Placed {
	readonly node: LiveNode
	readonly inRun: boolean
}

/**
 * Each space a node admits turned into a run of whitespace, the image of its language under collapse's inverse inside a
 * value: a set that holds the space and is one whole iteration of a repetition, reached through alternations alone,
 * admits any whitespace code point in the space's place, each then an iteration of its own; any other admits a run of
 * whitespace there. So no run is repeated inside a repetition, which a backtracking reader would read in exponential
 * time. A repetition whose iterations of such a set may stand together merges them only where its least count is at
 * most 1 and it is unbounded (mergeSafe), so where it iterates once the run is its iterations. Each placement is read
 * once, after its children, on the heap.
 */
const spacesToRuns = (node: LiveNode): RegexNode => {
	const builder = new RegexBuilder()
	const runOfWhitespace = builder.repeat(set(whitespace), 1, "unbounded")
	const placements = new Map<LiveNode, Map<boolean, Placed>>()
	const placed = (n: LiveNode, inRun: boolean): Placed => {
		const byRun = placements.get(n) ?? new Map<boolean, Placed>()
		placements.set(n, byRun)
		const known = byRun.get(inRun)
		if (known !== undefined) {
			return known
		}
		const made: Placed = { node: n, inRun }
		byRun.set(inRun, made)
		return made
	}
	const inputs = (p: Placed): ReadonlyArray<Placed> => {
		const n = p.node
		switch (n.kind) {
			case "seq":
				return n.items.map((item) => placed(item, false))
			case "alt":
				return n.arms.map((arm) => placed(arm, p.inRun))
			case "repeat":
				return [placed(n.body, true)]
			case "set":
			case "empty":
			case "start":
			case "end":
				return []
		}
	}
	const written = new Map<Placed, RegexNode>()
	const of = (p: Placed): RegexNode => {
		const known = written.get(p)
		if (known === undefined) {
			defect("a placement's runs, which postorder writes before its parent's")
		}
		return known
	}
	const root = placed(node, false)
	for (const p of postorder([root], inputs)) {
		const n = p.node
		const children = inputs(p).map(of)
		switch (n.kind) {
			case "set": {
				if (!has(n.set, space)) {
					written.set(p, n)
				} else if (p.inRun) {
					written.set(p, set(union([n.set, whitespace])))
				} else {
					const rest = set(intersection(n.set, complement(whitespace)))
					written.set(p, builder.alt([runOfWhitespace, rest]))
				}
				break
			}
			case "seq":
				written.set(p, seq(children))
				break
			case "alt":
				written.set(p, builder.alt(children))
				break
			case "repeat": {
				const [body] = children
				if (body === undefined) {
					defect("a repetition's body")
				}
				written.set(p, builder.repeat(body, n.min, n.max))
				break
			}
			case "empty":
			case "start":
			case "end":
				written.set(p, n)
				break
		}
	}
	return of(root)
}

/**
 * The texts whose `collapse`d form lies in `node`'s language, a language of whole texts, exactly: whitespace at either
 * end, a run of it wherever a word holds a space, and no break elsewhere. Where no word of the language begins or ends
 * with a space or holds two together, that is the whole fold. Where one may begin or end with one, a written form's
 * core must also begin and end with a code point of no whitespace, since collapse removes every space at an edge, so a
 * word that holds one there is never what a collapse yields: the core is the runs narrowed to its words whose first and
 * last code points are no whitespace (RegexBuilder.firstIn, folds.ts lastIn). Where two spaces may stand together,
 * merging them must keep the word in the language, which mergeSafe proves of the node, or the pre-image is refused
 * (`unmerged`); a node that tests an assertion is no language of whole texts and is refused (`assertion`). A written
 * form of whitespace alone collapses to the empty text.
 */
export const collapsePreimage = (node: RegexNode): Result.Result<RegexNode, CollapseRefusal> => {
	if (assertsAnywhere(node)) {
		return Result.err({ kind: "assertion" })
	}
	const collapsedNode = mapSets(node, (s) => set(intersection(s, complement(breaks))))
	if (collapsedNode.kind === "never") {
		return Result.ok(never)
	}
	const spaces = spacesOf(collapsedNode)
	if (spaces.doubled && !mergeSafe(collapsedNode)) {
		return Result.err({ kind: "unmerged" })
	}
	const builder = new RegexBuilder()
	const anyWhitespace = builder.repeat(set(whitespace), 0, "unbounded")
	const runs = spacesToRuns(collapsedNode)
	if (!spaces.first && !spaces.last) {
		return Result.ok(seq([anyWhitespace, runs, anyWhitespace]))
	}
	const core = builder.firstIn(lastIn(runs, solid), solid)
	return Result.ok(
		builder.alt([
			seq([anyWhitespace, core, anyWhitespace]),
			spaces.nullable ? anyWhitespace : never
		])
	)
}
