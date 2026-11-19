/**
 * The IR's structure as a pattern reads it, PostgreSQL's ARE among them (regcomp.c parseqatom): a node is an
 * alternation of branches or one branch of quantified atoms (piecesOf), an atom a set, an anchor or a group of branches.
 * The one printer of every dialect (print.ts) and the compile-space measure of PostgreSQL's regex compiler (space.ts)
 * both read it here.
 */
import type { CharSet, Interval } from "#compiler/scalar/regex/charset.ts"
import type { LiveNode } from "#compiler/scalar/regex/ir.ts"

/**
 * The set's intervals with the surrogate gap closed: no PostgreSQL text holds a surrogate, so [.., U+D7FF] and
 * [U+E000, ..] print as one range.
 */
export const printableIntervals = (set: CharSet): ReadonlyArray<Interval> => {
	const out: Array<[number, number]> = []
	for (const [lo, hi] of set) {
		const last = out[out.length - 1]
		if (last?.[1] === 0xd7ff && lo === 0xe000) {
			last[1] = hi
		} else {
			out.push([lo, hi])
		}
	}
	return out
}

/** An anchor of an ARE: `\A`, the value's start, or `\Z`, its end. */
export type AreAnchor = "start" | "end"

/** A set node of the IR: a class of code points it matches one of. */
export type SetNode = Extract<LiveNode, { readonly kind: "set" }>

/**
 * An atom of an ARE as PostgreSQL's parser reads it (regcomp.c parseqatom): a set node, whose set prints as a character
 * or a bracket expression, an anchor, or a non-capturing group of branches, each branch a node read as one (piecesOf).
 */
export type AreAtom =
	| { readonly kind: "set"; readonly node: SetNode }
	| { readonly kind: "anchor"; readonly anchor: AreAnchor }
	| { readonly kind: "group"; readonly branches: ReadonlyArray<LiveNode> }

/** A quantified atom of a branch: the atom and its counts, 1 and 1 where it has no quantifier. */
export interface ArePiece {
	readonly atom: AreAtom
	readonly min: number
	readonly max: number | "unbounded"
}

type Alt = Extract<LiveNode, { readonly kind: "alt" }>

/** Whether a node prints as an alternation of branches: an alternation none of whose arms is the empty string. */
export const isAlternation = (node: LiveNode): node is Alt =>
	node.kind === "alt" && node.arms.every((arm) => arm.kind !== "empty")

/**
 * The branches a node is read as where it is a whole pattern or a group's inside: an alternation's arms, or the node
 * as one branch.
 */
export const branchesOf = (node: LiveNode): ReadonlyArray<LiveNode> =>
	isAlternation(node) ? node.arms : [node]

/** The atom a node is read as where a quantifier applies to it: a set as itself, anything else as a group. */
const atomOf = (node: LiveNode): AreAtom =>
	node.kind === "set" ? { kind: "set", node } : { kind: "group", branches: branchesOf(node) }

const once = (atom: AreAtom): ArePiece => ({ atom, min: 1, max: 1 })

/**
 * The pieces a node adds to the branch it stands in: none for the empty string, its items' for a sequence, a group for
 * an alternation, and an optional atom for an alternation with the empty string, which an ARE writes as `?`.
 */
export const piecesOf = (node: LiveNode): ReadonlyArray<ArePiece> => {
	switch (node.kind) {
		case "empty":
			return []
		case "set":
			return [once({ kind: "set", node })]
		case "start":
		case "end":
			return [once({ kind: "anchor", anchor: node.kind })]
		case "seq":
			return node.items.flatMap(piecesOf)
		case "alt": {
			const arms = node.arms.filter((arm) => arm.kind !== "empty")
			if (arms.length === node.arms.length) {
				return [once({ kind: "group", branches: arms })]
			}
			const [only] = arms
			const atom: AreAtom =
				arms.length === 1 && only !== undefined ? atomOf(only) : { kind: "group", branches: arms }
			return [{ atom, min: 0, max: 1 }]
		}
		case "repeat":
			return [{ atom: atomOf(node.body), min: node.min, max: node.max }]
	}
}
