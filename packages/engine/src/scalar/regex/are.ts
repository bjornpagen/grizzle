import type { CharSet, Interval } from "#compiler/scalar/regex/charset.ts"
import { folded, type LiveNode, type RegexNode } from "#compiler/scalar/regex/ir.ts"

/**
 * ARE's fixed-width character-entry escapes, each a prefix and its exact count of hexadecimal digits: `\u` and four for
 * a code point up to U+FFFF, `\U` and eight for any other. PostgreSQL 19rc1's table of Regular Expression
 * Character-Entry Escapes states both widths: "\uwxyz (where wxyz is exactly four hexadecimal digits)" and "\Ustuvwxyz
 * (where stuvwxyz is exactly eight hexadecimal digits)"
 * (https://github.com/postgres/postgres/blob/REL_19_RC1/doc/src/sgml/func/func-matching.sgml#L1616-L1628, verified
 * 2026-11-05).
 *
 * @formatConstant the hexadecimal digits of ARE's \u and \U character-entry escapes
 */
const entryEscapes = {
	basic: { prefix: "\\u", digits: 4 },
	supplementary: { prefix: "\\U", digits: 8 }
} as const

type EntryEscape = (typeof entryEscapes)[keyof typeof entryEscapes]

/** A code point as the character-entry escape `escape`: its prefix and the code point in exactly its digits. */
const entry = (c: number, escape: EntryEscape): string =>
	`${escape.prefix}${c.toString(16).toUpperCase().padStart(escape.digits, "0")}`

const isAsciiAlnum = (c: number): boolean =>
	(c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

/** One code point, spelled so that it means itself both outside and inside a bracket expression. */
const areChar = (c: number): string => {
	if (isAsciiAlnum(c) || c === 0x20) {
		return String.fromCodePoint(c)
	}
	if (c > 0x20 && c < 0x7f) {
		return `\\${String.fromCodePoint(c)}`
	}
	return entry(c, c <= 0xffff ? entryEscapes.basic : entryEscapes.supplementary)
}

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

const areSet = (set: CharSet): string => {
	const only = set[0]
	if (set.length === 1 && only !== undefined && only[0] === only[1]) {
		return areChar(only[0])
	}
	const items = printableIntervals(set).map(([lo, hi]) => {
		if (lo === hi) {
			return areChar(lo)
		}
		if (hi === lo + 1) {
			return `${areChar(lo)}${areChar(hi)}`
		}
		return `${areChar(lo)}-${areChar(hi)}`
	})
	return `[${items.join("")}]`
}

/** An anchor of an ARE: `\A`, the value's start, or `\Z`, its end. */
export type AreAnchor = "start" | "end"

/**
 * An atom of an ARE as PostgreSQL's parser reads it (regcomp.c parseqatom): a set, which prints as a character or a
 * bracket expression, an anchor, or a non-capturing group of branches, each branch a node read as one (piecesOf).
 */
export type AreAtom =
	| { readonly kind: "set"; readonly set: CharSet }
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
const isAlternation = (node: LiveNode): node is Alt =>
	node.kind === "alt" && node.arms.every((arm) => arm.kind !== "empty")

/**
 * The branches a node is read as where it is a whole pattern or a group's inside: an alternation's arms, or the node
 * as one branch.
 */
export const branchesOf = (node: LiveNode): ReadonlyArray<LiveNode> =>
	isAlternation(node) ? node.arms : [node]

/** The atom a node is read as where a quantifier applies to it: a set as itself, anything else as a group. */
const atomOf = (node: LiveNode): AreAtom =>
	node.kind === "set"
		? { kind: "set", set: node.set }
		: { kind: "group", branches: branchesOf(node) }

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
			return [once({ kind: "set", set: node.set })]
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

const quantifier = (min: number, max: number | "unbounded"): string => {
	if (max === "unbounded") {
		return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
	}
	if (min === max) {
		return min === 1 ? "" : `{${min}}`
	}
	return min === 0 && max === 1 ? "?" : `{${min},${max}}`
}

/** A node's ARE text, from the texts of the nodes below it (`of`): its branches, `|` between them. */
const printed = (node: LiveNode, of: (child: LiveNode) => string): string => {
	const atomText = (atom: AreAtom): string => {
		switch (atom.kind) {
			case "set":
				return areSet(atom.set)
			case "anchor":
				return atom.anchor === "start" ? "\\A" : "\\Z"
			case "group":
				return `(?:${atom.branches.map(of).join("|")})`
		}
	}
	const branchText = (branch: LiveNode): string =>
		piecesOf(branch)
			.map((piece) => `${atomText(piece.atom)}${quantifier(piece.min, piece.max)}`)
			.join("")
	return isAlternation(node) ? node.arms.map(of).join("|") : branchText(node)
}

/**
 * Translation of the regex IR to a PostgreSQL ARE.
 *
 * The translation preserves Boolean membership over admitted text, the only question either engine is asked.
 * It never forwards source syntax: every construct is respelled from the IR, so nothing in the output
 * depends on a native shorthand, locale class, collation element or newline mode.
 *
 * - Every class is an explicit bracket expression of code point ranges. PostgreSQL compares bracket ranges by code
 *   point, and `\d`, `\w`, dot and negated classes were already expanded to explicit sets by the parser.
 * - `^` and `$` become ARE's absolute `\A` and `\Z`, so the ARE newline mode never matters.
 * - Groups become non-capturing `(?:...)`; an alternation with an empty arm becomes an optional group, so no empty
 *   branch is ever emitted.
 * - Quantifiers are greedy and keep their 0..255 bounds, which ARE accepts.
 * - Characters: ASCII letters, digits and space print literally; other printable ASCII prints after a backslash, which
 *   in an ARE means the character itself, inside or outside brackets; everything else prints as the fixed-width
 *   character-entry escape \uXXXX or \UXXXXXXXX, so no escape can absorb a following literal digit.
 *
 * The output is a pattern string; text/refinement.ts places it in a typed text literal, `VALUE ~ '<pattern>'::text`. The
 * printer folds the IR children first (scalar/regex/ir.ts folded), so a pattern of any depth prints without recursing.
 *
 * The ARE spelling of a pattern's IR. The empty language has none: the language analysis that refuses it hands over the
 * IR of a language with a member (text/refinement.ts languageOf), and a Compute.matches pattern whose IR is never is
 * refused before it is printed (admit.ts).
 */
export const toAre = (node: LiveNode): string => folded(new Map<RegexNode, string>(), node, printed)
