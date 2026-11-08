import { defect } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import type { PatternSource } from "#compiler/ir/scalar.ts"
import {
	type CharSet,
	charSet,
	complement,
	domain,
	has,
	isAdmittedCodePoint,
	union
} from "#compiler/scalar/regex/charset.ts"
import { end, type LiveNode, type RegexNode, seq, start } from "#compiler/scalar/regex/ir.ts"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { anchoredAt, anyText, printSource, sourceFlags } from "#compiler/scalar/regex/source.ts"
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

/** The flags every image is read under: its sets are explicit classes, so no dot is left for a flag to read. */
export const imageFlags: RegexFlags = sourceFlags

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
		return printSource(n, (set) => imageOfSet(set, map))
	}
	const within = print(node)
	return {
		exact: sameSet(imageOfSet(domain, map), domain) ? within : print(whole(node)),
		within
	}
}

/**
 * The image of one pattern's language under a map (imageSources), its parse read from `patterns`: a member of a text
 * type's conjunction (ir/scalar.ts textPatterns), whose image holds the image of every value of the conjunction.
 */
export const imageOf = (
	pattern: PatternSource,
	map: CharMap,
	patterns: PatternAutomata
): { readonly exact: string; readonly within: string } =>
	imageSources(patterns.parse(pattern).node, map)
