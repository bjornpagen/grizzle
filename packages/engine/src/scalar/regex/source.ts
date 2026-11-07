import { defect } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import type { TextInfo } from "#compiler/ir/scalar.ts"
import { type CharSet, domain } from "#compiler/scalar/regex/charset.ts"
import {
	end,
	folded,
	type LiveNode,
	RegexBuilder,
	type RegexNode,
	seq,
	set,
	start
} from "#compiler/scalar/regex/ir.ts"
import { parsePattern, type RegexFlags } from "#compiler/scalar/regex/parse.ts"

/** ECMAScript's ASCII letters and digits, which a pattern spells as themselves inside a class and out. */
const isAsciiAlnum = (c: number): boolean =>
	(c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

/**
 * One code point in grizzle's pattern grammar, meaning itself inside a class and out: an ASCII letter or digit as
 * itself, any other as the braced escape `\u{...}`, which no following character extends.
 */
const sourceChar = (c: number): string =>
	isAsciiAlnum(c) ? String.fromCodePoint(c) : `\\u{${c.toString(16).toUpperCase()}}`

/** A set as one code point, or a class of its intervals, each a code point, a pair or a range. */
export const sourceSet = (s: CharSet): string => {
	const only = s[0]
	if (s.length === 1 && only !== undefined && only[0] === only[1]) {
		return sourceChar(only[0])
	}
	const items = s.map(([lo, hi]) =>
		lo === hi
			? sourceChar(lo)
			: hi === lo + 1
				? `${sourceChar(lo)}${sourceChar(hi)}`
				: `${sourceChar(lo)}-${sourceChar(hi)}`
	)
	return `[${items.join("")}]`
}

const quantifier = (min: number, max: number | "unbounded"): string => {
	if (max === "unbounded") {
		return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`
	}
	return min === max ? `{${min}}` : `{${min},${max}}`
}

/** The grammar's precedence levels, loosest binding first; a quantifier applies to an atom alone. */
const levels = ["alt", "seq", "quantified", "atom"] as const

interface Printed {
	readonly text: string
	readonly level: (typeof levels)[number]
}

/** A node's text, grouped unless it binds at least as tightly as `level`. */
const group = (p: Printed, level: Printed["level"]): string =>
	levels.indexOf(p.level) < levels.indexOf(level) ? `(?:${p.text})` : p.text

/**
 * A node's source and its precedence, from its children's (`of`): each set printed as `setOf` gives it, every other
 * construct as itself. An assertion prints at sequence precedence, so it is grouped before a quantifier applies
 * to it; an alternation with the empty string as an arm is its other arms made optional, since a printed empty arm
 * would be read as one again.
 */
const printed =
	(setOf: (s: CharSet) => CharSet) =>
	(node: LiveNode, of: (child: LiveNode) => Printed): Printed => {
		switch (node.kind) {
			case "empty":
				return { text: "", level: "seq" }
			case "set":
				return { text: sourceSet(setOf(node.set)), level: "atom" }
			case "start":
				return { text: "^", level: "seq" }
			case "end":
				return { text: "$", level: "seq" }
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

/** The flags a printed source is read under: its sets are explicit classes, so no dot is left for a flag to read. */
export const sourceFlags: RegexFlags = "u"

/**
 * A node's source in grizzle's own grammar under sourceFlags, which its parser reads back, each of its sets printed as
 * `setOf` gives it: what a computed text type states its language by, the image of a translation's or a collapse's
 * operand, so the text analysis admits and keys it as it does a declared str.regex.
 */
export const printSource = (node: LiveNode, setOf: (s: CharSet) => CharSet): string =>
	folded(new Map<RegexNode, Printed>(), node, printed(setOf)).text

/** Whether every match a node makes starts at the value's start, or ends at its end: a sequence it opens or closes. */
export const anchoredAt = (node: LiveNode, side: "start" | "end"): boolean => {
	const edge = node.kind === "seq" ? (side === "start" ? node.items[0] : node.items.at(-1)) : node
	return edge?.kind === side
}

/** Any run of admitted code points, `.*` under the flags "su". */
export const anyText = (): RegexNode => new RegexBuilder().repeat(set(domain), 0, "unbounded")

/**
 * A text type's pattern's language as a node: its pattern's parse, or, for the wildcard, every admitted value, `^.*$`
 * under the flags "su". A type's pattern is one its text analysis admitted with a member, so it parses to a live node.
 * A byte bound str.bytes cuts the type to is no part of the node, whose language holds every value of the type.
 */
export const patternNode = (regex: TextInfo["regex"]): LiveNode => {
	const parsed =
		regex === "wildcard"
			? Result.ok(seq([start, anyText(), end]))
			: parsePattern(regex.source, regex.flags)
	if (!parsed.ok || parsed.value.kind === "never") {
		throw defect("the pattern of a text type, which its text analysis admitted with a member")
	}
	return parsed.value
}
