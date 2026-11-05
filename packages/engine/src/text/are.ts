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
const printableIntervals = (set: CharSet): ReadonlyArray<Interval> => {
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

const quantifier = (min: number, max: number | "unbounded"): string => {
	if (max === "unbounded") {
		return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
	}
	return min === max ? `{${min}}` : `{${min},${max}}`
}

/**
 * The ARE's precedence levels, loosest binding first: an alternation, a sequence, a quantified atom, an atom. A
 * quantifier applies only to an atom, so a quantified body is grouped again.
 */
const levels = ["alt", "seq", "quantified", "atom"] as const

type Level = (typeof levels)[number]

interface Printed {
	readonly text: string
	readonly level: Level
}

/** A node's text, grouped unless it binds at least as tightly as `level`. */
const group = (p: Printed, level: Level): string =>
	levels.indexOf(p.level) < levels.indexOf(level) ? `(?:${p.text})` : p.text

/**
 * A node's ARE text and its precedence, from its children's (`of`). An assertion prints at sequence precedence, so it
 * is grouped before a quantifier applies to it.
 */
const printed = (node: LiveNode, of: (child: LiveNode) => Printed): Printed => {
	switch (node.kind) {
		case "empty":
			return { text: "", level: "seq" }
		case "set":
			return { text: areSet(node.set), level: "atom" }
		case "start":
			return { text: "\\A", level: "seq" }
		case "end":
			return { text: "\\Z", level: "seq" }
		case "seq":
			return { text: node.items.map((item) => group(of(item), "seq")).join(""), level: "seq" }
		case "alt": {
			const arms = node.arms.filter((arm) => arm.kind !== "empty")
			const alternation = (): Printed => ({
				text: arms.map((arm) => group(of(arm), "alt")).join("|"),
				level: "alt"
			})
			if (arms.length === node.arms.length) {
				return alternation()
			}
			const [only] = arms
			const rest = arms.length === 1 && only !== undefined ? of(only) : alternation()
			return { text: `${group(rest, "atom")}?`, level: "quantified" }
		}
		case "repeat":
			return {
				text: `${group(of(node.body), "atom")}${quantifier(node.min, node.max)}`,
				level: "quantified"
			}
	}
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
 * The output is a pattern string; refinement.ts places it in a typed text literal, `VALUE ~ '<pattern>'::text`. The
 * printer folds the IR children first (scalar/regex/ir.ts folded), so a pattern of any depth prints without recursing.
 *
 * The ARE spelling of a pattern's IR. The empty language has none: the language analysis that refuses it hands over the
 * IR of a language with a member (refinement.ts languageOf).
 */
export const toAre = (node: LiveNode): string =>
	folded(new Map<RegexNode, Printed>(), node, printed).text
