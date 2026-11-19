import {
	type AreAtom,
	isAlternation,
	piecesOf,
	printableIntervals
} from "#compiler/scalar/regex/are.ts"
import type { CharSet, Interval } from "#compiler/scalar/regex/charset.ts"
import { folded, type LiveNode, type RegexNode } from "#compiler/scalar/regex/ir.ts"

/**
 * The one printer of the regex IR, in three dialects: PostgreSQL's ARE (toAre), which a domain's CHECK and a query's
 * `~` read; ECMA-262 under the `u` flag (toEcma), which an OpenAPI document's `pattern` states; and grizzle's own
 * grammar (printSource), which its parser reads back and a computed text type's language is keyed by.
 *
 * Every dialect reads the IR's structure alike (are.ts piecesOf): a node is an alternation of branches or one branch of
 * quantified atoms, an atom a set, an anchor or a non-capturing group `(?:...)` of branches, and an alternation with
 * the empty string an optional atom, so no empty branch is ever printed; and every dialect writes a piece's quantifier
 * alike, greedy and with its bounds. A dialect is what differs (Dialect): how it spells one code point, a class's run of
 * code points, the intervals it prints a set's class as, and its anchors. None forwards source syntax: every construct
 * is respelled from the IR, so nothing in the output depends on a native shorthand, locale class, collation element or
 * newline mode, and `\d`, `\w`, dot and negated classes were already expanded to explicit sets by the parser.
 *
 * The printer folds the IR children first (ir.ts folded), so a pattern of any depth prints without recursing. The
 * translation is total over the IR: every pattern grizzle admits has each dialect's spelling by construction, and the
 * empty language has none, since the language analysis hands over the IR of a language with a member
 * (text/refinement.ts languageOf) and a Compute.matches pattern whose IR is never is refused before it is printed
 * (admit.ts).
 */
interface Dialect {
	/** One code point, spelled so that it means itself both outside and inside a class. */
	readonly char: (c: number) => string
	/** A class's run of more than one code point, lo to hi. */
	readonly run: (lo: number, hi: number) => string
	/** The intervals a set's class is printed as. */
	readonly intervals: (set: CharSet) => ReadonlyArray<Interval>
	/** The dialect's spelling of the value's start and end. */
	readonly anchors: { readonly start: string; readonly end: string }
}

const isAsciiAlnum = (c: number): boolean =>
	(c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

/**
 * One code point as ECMA-262 and grizzle's grammar both spell it under the `u` flag, meaning itself inside a class and
 * out: an ASCII letter or digit as itself, every other code point as the braced escape `\u{...}`
 * (RegExpUnicodeEscapeSequence, `u{ CodePoint }`), which the `u` flag reads anywhere and no following character
 * extends.
 */
const bracedChar = (c: number): string =>
	isAsciiAlnum(c) ? String.fromCodePoint(c) : `\\u{${c.toString(16).toUpperCase()}}`

/**
 * ARE's fixed-width character-entry escapes, each a prefix and its exact count of hexadecimal digits: `\u` and four for
 * a code point up to U+FFFF, `\U` and eight for any other. PostgreSQL 19rc2's table of Regular Expression
 * Character-Entry Escapes states both widths: "\uwxyz (where wxyz is exactly four hexadecimal digits)" and "\Ustuvwxyz
 * (where stuvwxyz is exactly eight hexadecimal digits)"
 * (https://github.com/postgres/postgres/blob/REL_19_RC2/doc/src/sgml/func/func-matching.sgml#L1616-L1628, verified
 * 2026-11-14).
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

/**
 * One code point as an ARE spells it, meaning itself both outside and inside a bracket expression: ASCII letters, digits
 * and space as themselves, other printable ASCII after a backslash, which in an ARE means the character itself, and
 * every other code point as the fixed-width character-entry escape \uXXXX or \UXXXXXXXX, so no escape can absorb a
 * following literal digit.
 */
const areChar = (c: number): string => {
	if (isAsciiAlnum(c) || c === 0x20) {
		return String.fromCodePoint(c)
	}
	if (c > 0x20 && c < 0x7f) {
		return `\\${String.fromCodePoint(c)}`
	}
	return entry(c, c <= 0xffff ? entryEscapes.basic : entryEscapes.supplementary)
}

/** A class's run as `lo-hi`. */
const rangeOf =
	(char: (c: number) => string) =>
	(lo: number, hi: number): string =>
		`${char(lo)}-${char(hi)}`

/** A class's run as `lo-hi`, or as its two code points where they are adjacent. */
const pairOrRangeOf =
	(char: (c: number) => string) =>
	(lo: number, hi: number): string =>
		hi === lo + 1 ? `${char(lo)}${char(hi)}` : `${char(lo)}-${char(hi)}`

/**
 * PostgreSQL's ARE: each class a bracket expression of code point ranges, which PostgreSQL compares by code point, the
 * surrogate gap closed (are.ts printableIntervals), and `^` and `$` as ARE's absolute `\A` and `\Z`, so the ARE newline
 * mode never matters.
 */
const areDialect: Dialect = {
	char: areChar,
	run: pairOrRangeOf(areChar),
	intervals: printableIntervals,
	anchors: { start: "\\A", end: "\\Z" }
}

/**
 * ECMA-262 read under the `u` flag, as a JSON Schema `pattern` is (JSON Schema 2020-12 §6.4): each class of code point
 * ranges, the surrogate gap closed, and `^` and `$`, which without the `m` flag hold only at the value's start and end.
 */
const ecmaDialect: Dialect = {
	char: bracedChar,
	run: rangeOf(bracedChar),
	intervals: printableIntervals,
	anchors: { start: "^", end: "$" }
}

/**
 * grizzle's own grammar under sourceFlags (source.ts), ECMA-262's syntax, which grizzle's parser reads back: each set as
 * `setOf` gives it, its intervals as they stand, adjacent code points as a pair.
 */
const sourceDialect = (setOf: (s: CharSet) => CharSet): Dialect => ({
	...ecmaDialect,
	run: pairOrRangeOf(bracedChar),
	intervals: setOf
})

/** A set in a dialect: its one code point as itself, else a class of the intervals the dialect prints it as. */
const setText = (dialect: Dialect, set: CharSet): string => {
	const intervals = dialect.intervals(set)
	const only = intervals[0]
	if (intervals.length === 1 && only !== undefined && only[0] === only[1]) {
		return dialect.char(only[0])
	}
	const items = intervals.map(([lo, hi]) => (lo === hi ? dialect.char(lo) : dialect.run(lo, hi)))
	return `[${items.join("")}]`
}

/**
 * A piece's quantifier, as every dialect spells one: none for once, `?`, `*`, `+`, or its counts in braces, which ARE
 * accepts up to 255. The builder makes no repetition of exactly one count or of none and one (ir.ts RegexBuilder.repeat
 * writes them out as their body and an optional), so `?` is an optional's and every counted repetition's braces read
 * back as the repetition.
 */
const quantifier = (min: number, max: number | "unbounded"): string => {
	if (max === "unbounded") {
		return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
	}
	if (min === max) {
		return min === 1 ? "" : `{${min}}`
	}
	return min === 0 && max === 1 ? "?" : `{${min},${max}}`
}

/** A node's text in a dialect, from the texts of the nodes below it (`of`): its branches, `|` between them. */
const printedIn =
	(dialect: Dialect) =>
	(node: LiveNode, of: (child: LiveNode) => string): string => {
		const atomText = (atom: AreAtom): string => {
			switch (atom.kind) {
				case "set":
					return setText(dialect, atom.node.set)
				case "anchor":
					return dialect.anchors[atom.anchor]
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

/** A node's text in a dialect, its children folded first (ir.ts folded). */
const printIn = (dialect: Dialect, node: LiveNode): string =>
	folded(new Map<RegexNode, string>(), node, printedIn(dialect))

/**
 * The ARE spelling of a pattern's IR, the same Boolean membership over admitted text, the one question either engine is
 * asked: a pattern string, which text/refinement.ts places in a typed text literal, `VALUE ~ '<pattern>'::text`.
 */
export const toAre = (node: LiveNode): string => printIn(areDialect, node)

/** Whether every match of a node starts at the value's start: a `^`, or a sequence that begins with one. */
const startsAtStart = (node: LiveNode): boolean =>
	node.kind === "start" || (node.kind === "seq" && node.items[0]?.kind === "start")

/**
 * The ECMA-262 spelling of a pattern's IR under the `u` flag: the same Boolean membership over admitted text, for both
 * ask whether a match exists anywhere in the value (ir.ts). A pattern whose matches do not all start at the value's
 * start is printed from it, `^[^]*?(?:...)`: the same language, for some match exists anywhere exactly when one exists
 * after some prefix, so the document stays exact. The spelling is a workaround: V8 14.6 (Node 26.13.0's) answers `test`
 * wrongly for a pattern that ends in `$` and starts unanchored over a class naming an astral code point,
 * `/[\u{10000}-\u{10FFFF}]$/u.test("\u{1F600}")` false, and a start anchor keeps it from that path. V8 fixed it on main
 * in 7d259d7c (issue 571871980); grizzle's upstream/v8-unicode-end-anchor-astral-class holds the reproduction and Node's
 * backport. Once Node carries the fix, `node repro.js` there exits 0, and the body is printed as it is, without
 * startsAtStart.
 */
export const toEcma = (node: LiveNode): string => {
	const body = printIn(ecmaDialect, node)
	return startsAtStart(node) ? body : `^[^]*?(?:${body})`
}

/**
 * A node's source in grizzle's own grammar under sourceFlags, which its parser reads back, each of its sets printed as
 * `setOf` gives it: what a computed text type states its language by, the image of a translation's or a collapse's
 * operand, so the text analysis admits and keys it as it does a declared str.regex.
 */
export const printSource = (node: LiveNode, setOf: (s: CharSet) => CharSet): string =>
	printIn(sourceDialect(setOf), node)

/** A set as grizzle's grammar spells it: one code point, or a class of its intervals, each a code point, a pair or a range. */
export const sourceSet = (s: CharSet): string =>
	setText(
		sourceDialect((x) => x),
		s
	)
