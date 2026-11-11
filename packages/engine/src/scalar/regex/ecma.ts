import {
	type AreAtom,
	piecesOf,
	printableIntervals,
	quantifier
} from "#compiler/scalar/regex/are.ts"
import type { CharSet } from "#compiler/scalar/regex/charset.ts"
import { folded, type LiveNode, type RegexNode } from "#compiler/scalar/regex/ir.ts"

const isAsciiAlnum = (c: number): boolean =>
	(c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

/**
 * One code point, spelled so that it means itself both outside and inside a class under the `u` flag: an ASCII letter
 * or digit as itself, every other code point as ECMA-262's `\u{...}` escape (RegExpUnicodeEscapeSequence, `u{
 * CodePoint }`), which the `u` flag reads anywhere and no following character extends.
 */
const ecmaChar = (c: number): string =>
	isAsciiAlnum(c) ? String.fromCodePoint(c) : `\\u{${c.toString(16).toUpperCase()}}`

/** A set as one code point or a class of its intervals, the surrogate gap closed (are.ts printableIntervals). */
const ecmaSet = (set: CharSet): string => {
	const only = set[0]
	if (set.length === 1 && only !== undefined && only[0] === only[1]) {
		return ecmaChar(only[0])
	}
	const items = printableIntervals(set).map(([lo, hi]) =>
		lo === hi ? ecmaChar(lo) : `${ecmaChar(lo)}-${ecmaChar(hi)}`
	)
	return `[${items.join("")}]`
}

/** A node's ECMA-262 text, from the texts of the nodes below it (`of`): its branches, `|` between them. */
const printed = (node: LiveNode, of: (child: LiveNode) => string): string => {
	const atomText = (atom: AreAtom): string => {
		switch (atom.kind) {
			case "set":
				return ecmaSet(atom.node.set)
			case "anchor":
				return atom.anchor === "start" ? "^" : "$"
			case "group":
				return `(?:${atom.branches.map(of).join("|")})`
		}
	}
	const branchText = (branch: LiveNode): string =>
		piecesOf(branch)
			.map((piece) => `${atomText(piece.atom)}${quantifier(piece.min, piece.max)}`)
			.join("")
	return node.kind === "alt" && node.arms.every((arm) => arm.kind !== "empty")
		? node.arms.map(of).join("|")
		: branchText(node)
}

/**
 * Translation of the regex IR to an ECMA-262 pattern read under the `u` flag, as a JSON Schema `pattern` is (JSON Schema
 * 2020-12 §6.4): the same Boolean membership over admitted text, for both ask whether a match exists anywhere in the
 * value (scalar/regex/ir.ts). It never forwards source syntax: every construct is respelled from the IR, as the ARE
 * printer respells it (are.ts toAre), whose pieces it reads.
 *
 * - Every class is an explicit class of code point ranges; dot, `\d`, `\w` and negated classes were already expanded to
 *   explicit sets by the parser, and the `s` flag chose dot's set.
 * - `^` and `$` without the `m` flag hold only at the value's start and end, the IR's anchors.
 * - Groups are non-capturing `(?:...)`; an alternation with an empty arm is an optional group.
 * - Quantifiers are greedy and keep their bounds.
 * - Characters: ASCII letters and digits print as themselves; every other code point as `\u{...}`.
 *
 * The translation is total over the IR, so every pattern grizzle admits has its ECMA-262 spelling by construction; the
 * empty language has none, and no admitted text type holds it (text/refinement.ts languageOf). The printer folds the IR
 * children first (ir.ts folded), so a pattern of any depth prints without recursing.
 */
export const toEcma = (node: LiveNode): string =>
	folded(new Map<RegexNode, string>(), node, printed)
