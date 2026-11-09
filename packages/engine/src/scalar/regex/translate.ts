import { maxOf } from "#compiler/core/array.ts"
import { defect } from "#compiler/core/invariant.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import type { PatternSource, Patterns, TextBounds } from "#compiler/ir/scalar.ts"
import {
	type CharSet,
	charSet,
	complement,
	domain,
	has,
	intersection,
	isAdmittedCodePoint,
	maxUtf8Width,
	size,
	union,
	utf8Classes,
	utf8Width
} from "#compiler/scalar/regex/charset.ts"
import { end, type LiveNode, type RegexNode, seq, start } from "#compiler/scalar/regex/ir.ts"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import {
	alphabetOf,
	anchoredAt,
	anyText,
	printSource,
	sourceFlags
} from "#compiler/scalar/regex/source.ts"
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

/**
 * A kind of character a text holds: the UTF-8 bytes it takes and the most bytes its image under a map takes. The empty
 * kind, no character, takes none, and fills a text out to its bound in characters.
 */
interface CharKind {
	readonly bytes: number
	readonly image: number
}

/** No character: what a text of fewer characters than its bound holds in their place. */
const noCharacter: CharKind = Object.freeze({ bytes: 0, image: 0 })

/**
 * The kinds of character of `alphabet` in bytes order: the empty kind, then one for each UTF-8 width the alphabet holds
 * a code point of (charset.ts utf8Classes), with the most bytes its image under `map` takes, the width itself for a code
 * point the map leaves and its target's width for one it moves.
 */
const kindsOf = (map: CharMap, alphabet: CharSet): ReadonlyArray<CharKind> => [
	noCharacter,
	...utf8Classes.flatMap(({ width, set }): ReadonlyArray<CharKind> => {
		const held = intersection(alphabet, set)
		const moved = [...map].flatMap(([source, target]) =>
			has(held, source) ? [utf8Width(target)] : []
		)
		const images = moved.length < size(held) ? [width, ...moved] : moved
		return isNonEmpty(images) ? [{ bytes: width, image: maxOf(images, 0) }] : []
	})
]

/**
 * How many characters of each of three kinds admit both a trade among them and its reverse (imageBytes): a code point's
 * widest UTF-8 width, the most bytes two kinds differ by.
 */
const traded = maxUtf8Width(domain)

/** A count of characters of each of some kinds. */
type Counts = ReadonlyArray<readonly [CharKind, number]>

/** Every choice of a count below `traded` for each of `kinds`. */
const fewOf = (kinds: ReadonlyArray<CharKind>): ReadonlyArray<Counts> =>
	kinds.reduce<ReadonlyArray<Counts>>(
		(choices, kind) =>
			choices.flatMap((choice) =>
				Array.from({ length: traded }, (_, count) => [...choice, [kind, count] as const])
			),
		[[]]
	)

/**
 * The most bytes the image takes of a text of each kind of `few` its count, and the rest of the characters `bounds`
 * admits of `low` and `high`, all of them, low taking fewer bytes than high: low's alone or as many of high's as the
 * bytes left admit, its bytes growing linearly in high's count; none where the bytes left do not hold that many of low's.
 */
const pairImage = (
	low: CharKind,
	high: CharKind,
	few: Counts,
	bounds: TextBounds
): ReadonlyArray<number> => {
	const chars = few.reduce((n, [, count]) => n - count, bounds.length)
	const bytes = few.reduce((n, [kind, count]) => n - kind.bytes * count, bounds.bytes)
	const image = few.reduce((n, [kind, count]) => n + kind.image * count, 0)
	if (chars < 0 || bytes < low.bytes * chars) {
		return []
	}
	const highs = Math.min(chars, Math.floor((bytes - low.bytes * chars) / (high.bytes - low.bytes)))
	return [image + low.image * chars + Math.max(0, high.image - low.image) * highs]
}

/**
 * The most UTF-8 bytes the image under `map` takes of a text of at most `bounds.bytes` bytes and `bounds.length`
 * characters, each in the alphabet of every one of `patterns` (source.ts alphabetOf), its parse read from `automata`:
 * so the bound on the bytes of the translation of every value of a text type of those patterns and bounds, at most
 * `bounds.bytes` where the map takes no character to a wider one, and exactly the most such a text's image takes.
 *
 * A text is a count of characters of each kind (kindsOf), the empty kind filling it out to `bounds.length`, its bytes
 * within `bounds.bytes`, and its image takes each count times its kind's image. For kinds i < j < k by bytes, trading
 * k - i characters of j for k - j of i and j - i of k keeps both sums and raises the sum of each count times its kind's
 * bytes squared by (k - j)(j - i)(k - i). Of the texts whose image takes the most, the one of the least such sum cannot
 * make both, since the reverse would take more bytes, or as many by a lesser sum, or else the trade more; so it holds
 * fewer than `traded` characters of one of any three kinds. At most two kinds hold more, so the most is the most over
 * each pair of kinds and each count below `traded` of every other kind (pairImage).
 */
export const imageBytes = (
	patterns: Patterns,
	map: CharMap,
	bounds: TextBounds,
	automata: PatternAutomata
): number => {
	const alphabet = patterns.reduce(
		(a, pattern) => intersection(a, alphabetOf(automata.parse(pattern).node)),
		domain
	)
	const kinds = kindsOf(map, alphabet)
	return maxOf(
		kinds.flatMap((low, i) =>
			kinds.slice(i + 1).flatMap((high) => {
				const others = kinds.filter((kind) => kind !== low && kind !== high)
				return fewOf(others).flatMap((few) => pairImage(low, high, few, bounds))
			})
		),
		0
	)
}
