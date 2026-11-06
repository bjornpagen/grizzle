import { defect } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import type { TextInfo } from "#compiler/ir/scalar.ts"
import {
	type CharSet,
	charSet,
	complement,
	domain,
	has,
	isAdmittedCodePoint,
	union
} from "#compiler/scalar/regex/charset.ts"
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
import { entry } from "#compiler/scalar/regex/table.ts"

/**
 * PostgreSQL's translate(x, from, to) as Compute.translate states it: its character map, its value over a text, and the
 * image of a text type's language under it.
 *
 * PostgreSQL reads translate by characters, code points in a UTF-8 database: each character of x that occurs in from is
 * replaced by the character of to at the position of its first occurrence in from, or deleted where to is shorter, and
 * every other character is copied (src/backend/utils/adt/oracle_compat.c translate). Compute.translate admits only a map
 * that deletes nothing and reads every character of from once: from and to of one length, from holding each code point
 * once. A repeated character of from could only ever map to its first counterpart, so a repeat is refused rather than
 * read silently. A map of one length replaces each character by one character, so a text's image has its length in code
 * points, and its UTF-8 length changes by the widths of the characters it replaces.
 *
 * A CharMap maps each code point of from to the code point of to at its position: every other code point is itself.
 */
export type CharMap = ReadonlyMap<number, number>

/** The map Compute.translate's from and to state, or the refusal of a pair it does not admit, in words. */
export const charMapOf = (from: string, to: string): Result.Result<CharMap, string> => {
	const sources = codePoints(from)
	const targets = codePoints(to)
	if (sources.length !== targets.length) {
		return Result.err(
			`from and to of one length in characters, which replaces each character of from by one of to and deletes none: from holds ${sources.length} and to ${targets.length}`
		)
	}
	const map = new Map<number, number>()
	for (const [i, source] of sources.entries()) {
		const target = targets[i]
		if (target === undefined || !isAdmittedCodePoint(source) || !isAdmittedCodePoint(target)) {
			return Result.err(
				"from and to of text characters: no NUL and no unpaired surrogate, which no text holds"
			)
		}
		if (map.has(source)) {
			return Result.err(
				`from holding each character once: ${JSON.stringify(codePointsText([source]))} is repeated, and PostgreSQL maps a repeated character by its first occurrence alone`
			)
		}
		map.set(source, target)
	}
	return Result.ok(map)
}

/**
 * PostgreSQL's translate(text, from, to) over any three texts, by code points: a character of text that occurs in from
 * becomes the character of to at the position of its first occurrence there, or nothing where to has no character at
 * that position, and every other character stays.
 */
export const translated = (text: string, from: string, to: string): string => {
	const sources = codePoints(from)
	const targets = codePoints(to)
	const first = new Map<number, number>()
	for (const [i, source] of sources.entries()) {
		if (!first.has(source)) {
			first.set(source, i)
		}
	}
	const out: Array<number> = []
	for (const c of codePoints(text)) {
		const at = first.get(c)
		const target = at === undefined ? c : targets[at]
		if (target !== undefined) {
			out.push(target)
		}
	}
	return codePointsText(out)
}

/** The image of a set of code points under a map: its code points the map leaves, and the image of each it moves. */
const imageOfSet = (s: CharSet, map: CharMap): CharSet => {
	const moved = charSet([...map.keys()].map((c) => [c, c] as const))
	const kept = complement(union([complement(s), moved]))
	const images = [...map].flatMap(([source, target]) =>
		has(s, source) ? [[target, target] as const] : []
	)
	return union([kept, charSet(images)])
}

/** Whether two sets are one: a CharSet's interval list is its identity. */
const sameSet = (a: CharSet, b: CharSet): boolean =>
	a.length === b.length &&
	a.every(([lo, hi], i) => {
		const [blo, bhi] = entry(b, i)
		return blo === lo && bhi === hi
	})

/** Whether every member of a language a node matches starts at the value's start, and ends at its end. */
const anchoredAt = (node: LiveNode, side: "start" | "end"): boolean => {
	const edge = node.kind === "seq" ? (side === "start" ? node.items[0] : node.items.at(-1)) : node
	return edge?.kind === side
}

/**
 * The language of a pattern as a whole-value match: a match anywhere is a match after any prefix and before any
 * suffix, so a side the pattern does not anchor reads `^.*` or `.*$` there, with dot every admitted code point. The two
 * spell one language; the second states what each prefix and suffix is, which the map then rewrites too.
 */
const whole = (node: LiveNode): RegexNode => {
	const any = anyText()
	return seq([
		...(anchoredAt(node, "start") ? [] : [start, any]),
		node,
		...(anchoredAt(node, "end") ? [] : [any, end])
	])
}

/** Any run of admitted code points, `.*` under the flags "su". */
const anyText = (): RegexNode => new RegexBuilder().repeat(set(domain), 0, "unbounded")

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
const sourceSet = (s: CharSet): string => {
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
 * A node's source under the map and its precedence, from its children's (`of`): each set printed as its image, every
 * other construct as itself. An assertion prints at sequence precedence, so it is grouped before a quantifier applies
 * to it; an alternation with the empty string as an arm is its other arms made optional, since a printed empty arm
 * would be read as one again.
 */
const printed =
	(map: CharMap) =>
	(node: LiveNode, of: (child: LiveNode) => Printed): Printed => {
		switch (node.kind) {
			case "empty":
				return { text: "", level: "seq" }
			case "set":
				return { text: sourceSet(imageOfSet(node.set, map)), level: "atom" }
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

/** The flags every image is read under: its sets are explicit classes, so no dot is left for a flag to read. */
export const imageFlags: RegexFlags = "u"

/**
 * The image of a pattern's language under a map, as two sources in grizzle's grammar under imageFlags, the exact one
 * first. The image of a language is the image of its whole-value form (whole): every class and code point of it
 * rewritten as its image, so a value of the image is exactly the image of a value of the language, its prefix and
 * suffix included, and a language whose lengths are bounded keeps its bounds. Where the map moves no code point out of
 * the admitted domain's image, every prefix and suffix is already its own image, and the pattern itself is exact.
 *
 * The second source rewrites the pattern alone, so it holds every value of the image and may hold more, at a side the
 * pattern leaves unanchored; its structure is the pattern's own, so it fits every measure the pattern fits, which the
 * exact one, longer by its prefix and suffix, may not.
 */
const imageSources = (
	node: LiveNode,
	map: CharMap
): { readonly exact: string; readonly within: string } => {
	const print = (n: RegexNode): string => {
		if (n.kind === "never") {
			throw defect("the whole-value form of a language with a member, which has one too")
		}
		return folded(new Map<RegexNode, Printed>(), n, printed(map)).text
	}
	const within = print(node)
	return {
		exact: sameSet(imageOfSet(domain, map), domain) ? within : print(whole(node)),
		within
	}
}

/**
 * The image of a text type's language under a map (imageSources): of its pattern's parse, or, for the wildcard, of
 * every admitted value, `^.*$` under the flags "su". A type's pattern is one its text analysis admitted, so it parses.
 */
export const imageOf = (
	regex: TextInfo["regex"],
	map: CharMap
): { readonly exact: string; readonly within: string } => {
	const parsed =
		regex === "wildcard"
			? Result.ok(seq([start, anyText(), end]))
			: parsePattern(regex.source, regex.flags)
	if (!parsed.ok || parsed.value.kind === "never") {
		throw defect("the pattern of a text type, which its text analysis admitted with a member")
	}
	return imageSources(parsed.value, map)
}
