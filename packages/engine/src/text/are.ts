import type { CharSet, Interval } from "#compiler/scalar/regex/charset.ts"
import type { LiveNode } from "#compiler/scalar/regex/ir.ts"

const hex = (c: number, width: number): string => c.toString(16).toUpperCase().padStart(width, "0")

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
	return c <= 0xffff ? `\\u${hex(c, 4)}` : `\\U${hex(c, 8)}`
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
 * Precedence: an alternation binds loosest, then a sequence, then a quantified atom, then an atom. A quantifier applies
 * only to an atom, so a quantified body is grouped again.
 */
const precAlt = 0
const precSeq = 1
const precQuantified = 2
const precAtom = 3

interface Printed {
	readonly text: string
	readonly prec: number
}

const group = (p: Printed, minimum: number): string => (p.prec < minimum ? `(?:${p.text})` : p.text)

/**
 * A node's ARE text and its precedence. An assertion prints at sequence precedence, so it is grouped before a
 * quantifier applies to it.
 */
const print = (node: LiveNode): Printed => {
	switch (node.kind) {
		case "empty":
			return { text: "", prec: precSeq }
		case "set":
			return { text: areSet(node.set), prec: precAtom }
		case "start":
			return { text: "\\A", prec: precSeq }
		case "end":
			return { text: "\\Z", prec: precSeq }
		case "seq":
			return { text: node.items.map((item) => group(print(item), precSeq)).join(""), prec: precSeq }
		case "alt": {
			const arms = node.arms.filter((arm) => arm.kind !== "empty")
			if (arms.length === node.arms.length) {
				return { text: arms.map((arm) => group(print(arm), precAlt)).join("|"), prec: precAlt }
			}
			const [only] = arms
			const rest =
				arms.length === 1 && only !== undefined ? print(only) : print({ kind: "alt", arms })
			return { text: `${group(rest, precAtom)}?`, prec: precQuantified }
		}
		case "repeat":
			return {
				text: `${group(print(node.body), precAtom)}${quantifier(node.min, node.max)}`,
				prec: precQuantified
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
 * The output is a pattern string; refinement.ts places it in a typed text literal, `VALUE ~ '<pattern>'::text`.
 *
 * The ARE spelling of a pattern's IR. The empty language has none: the language analysis that refuses it hands over the
 * IR of a language with a member (refinement.ts languageOf).
 */
export const toAre = (node: LiveNode): string => print(node).text
