/**
 * What the properties of xsd.test.ts read: drawn XML Schema patterns, each beside its oracle, the pattern's meaning
 * spelled as an ECMAScript expression under the `v` flag construct by construct from Appendix F's definitions, and
 * drawn words to hold the reader's language to it.
 */

import {
	categoryRuns,
	generalCategories
} from "@bjornpagen/grizzle-text/regex/categories.generated"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	recursive,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Function, Option, String as Str } from "effect"
import { runsOfRunningNode } from "#scripts/gen/unicode/generate.ts"
import { succeeded } from "#test/support/assert.ts"

/** A drawn piece of a pattern: its XML Schema spelling and its oracle's, an ECMAScript `v`-flag spelling of its meaning. */
export interface Drawn {
	readonly xsd: string
	readonly oracle: string
}

/**
 * XML's Char as an ECMAScript class: the alphabet of every complement and of the wildcard, and the characters a normal
 * character may be (XML 1.0 production 2, written here from the specification).
 */
const xmlChars = "[\\u{9}\\u{A}\\u{D}\\u{20}-\\u{D7FF}\\u{E000}-\\u{FFFD}\\u{10000}-\\u{10FFFF}]"

/** A class within XML's characters. */
const within = (cls: string): string => `[${cls}&&${xmlChars}]`

/** XML's characters less a class. */
const outside = (cls: string): string => `[${xmlChars}--${cls}]`

/** One code point as an ECMAScript escape that means itself in a class and out. */
const escaped = (point: number): string => `\\u{${Str.toUpperCase(point.toString(16))}}`

/** The characters a normal character and a word are drawn from: ASCII, the metacharacters XML Schema reads as text,
 * characters outside XML's Char, a supplementary one, a decimal digit of another script, name characters of the
 * two editions, and the two ranges of the block XML Schema's table lists twice (Specials: U+FEFF, and U+FFF0 to U+FFFD)
 * with U+FF01 between them. */
export const pool = [
	"a",
	"b",
	"z",
	"A",
	"0",
	"7",
	"^",
	"$",
	"_",
	":",
	" ",
	"\t",
	"\n",
	"\r",
	"\u0001",
	"￾",
	"é",
	"Ĳ",
	"٣",
	"­",
	"　",
	"😀",
	"\uFEFF",
	"\uFF01",
	"\uFFF0",
	"\uFFFD"
] as const

/** A normal character: any of the pool but a metacharacter, `{` and `}` among them. */
const normalCharacter: Gen<Drawn> = map(
	element([
		"a",
		"b",
		"z",
		"A",
		"0",
		"7",
		"^",
		"$",
		"_",
		":",
		" ",
		"\u0001",
		"￾",
		"é",
		"Ĳ",
		"٣",
		"😀"
	] as const),
	(c): Drawn => {
		const point = Option.getOrThrow(Str.codePointAt(0)(c))
		return { xsd: c, oracle: within(`[${escaped(point)}]`) }
	}
)

/** The single-character escapes and what each names. */
const singleEscapes: Gen<Drawn> = map(
	element([
		["\\n", 0x0a],
		["\\r", 0x0d],
		["\\t", 0x09],
		["\\.", 0x2e],
		["\\-", 0x2d],
		["\\[", 0x5b],
		["\\]", 0x5d],
		["\\^", 0x5e],
		["\\\\", 0x5c],
		["\\{", 0x7b],
		["\\|", 0x7c]
	] as const),
	([xsd, point]): Drawn => ({ xsd, oracle: `[${escaped(point)}]` })
)

/** XML's four space characters, `\s`. */
const spaces = "[\\u{9}\\u{A}\\u{D}\\u{20}]"

/** The characters `\w` excludes: punctuation, separators and others. */
const nonWord = "[\\p{P}\\p{Z}\\p{C}]"

/** The multi-character escapes but `\i` and `\c`, each by Appendix F's definition (F.1.1, [37a]). */
const classEscapes = [
	{ xsd: "\\s", oracle: spaces },
	{ xsd: "\\S", oracle: outside(spaces) },
	{ xsd: "\\d", oracle: within("\\p{Nd}") },
	{ xsd: "\\D", oracle: outside("\\p{Nd}") },
	{ xsd: "\\w", oracle: outside(nonWord) },
	{ xsd: "\\W", oracle: within(nonWord) }
] as const satisfies Arr.NonEmptyReadonlyArray<Drawn>

const multiEscapes: Gen<Drawn> = element(classEscapes)

/**
 * Category escapes and block escapes, positive and negative, four blocks by the Recommendation's table, Specials, the
 * name it lists twice, among them.
 */
const propertyEscapeList = [
	{ xsd: "\\p{L}", oracle: within("\\p{L}") },
	{ xsd: "\\p{Lu}", oracle: within("\\p{Lu}") },
	{ xsd: "\\P{Lu}", oracle: outside("\\p{Lu}") },
	{ xsd: "\\p{Nd}", oracle: within("\\p{Nd}") },
	{ xsd: "\\p{C}", oracle: within("\\p{C}") },
	{ xsd: "\\p{Zs}", oracle: within("\\p{Zs}") },
	{ xsd: "\\p{IsBasicLatin}", oracle: within("[\\u{0}-\\u{7F}]") },
	{ xsd: "\\P{IsBasicLatin}", oracle: outside("[\\u{0}-\\u{7F}]") },
	{ xsd: "\\p{IsGreek}", oracle: within("[\\u{370}-\\u{3FF}]") },
	{ xsd: "\\p{IsLatin-1Supplement}", oracle: within("[\\u{80}-\\u{FF}]") },
	{ xsd: "\\p{IsSpecials}", oracle: within("[\\u{FEFF}\\u{FFF0}-\\u{FFFD}]") },
	{ xsd: "\\P{IsSpecials}", oracle: outside("[\\u{FEFF}\\u{FFF0}-\\u{FFFD}]") }
] as const satisfies Arr.NonEmptyReadonlyArray<Drawn>

const propertyEscapes: Gen<Drawn> = element(propertyEscapeList)

/** A range of a class, its two ends in order. */
const range: Gen<Drawn> = element([
	{ xsd: "a-z", oracle: "[a-z]" },
	{ xsd: "0-9", oracle: "[0-9]" },
	{ xsd: "A-Z", oracle: "[A-Z]" },
	{ xsd: "\u00E0-\u00FF", oracle: "[\\u{E0}-\\u{FF}]" }
] as const)

/** One member of a class: a character, a range, an escape. */
const classMember: Gen<Drawn> = oneOf([
	map(normalCharacter, (c): Drawn => (c.xsd === "^" ? { xsd: "\\^", oracle: c.oracle } : c)),
	range,
	singleEscapes,
	multiEscapes,
	propertyEscapes
])

/** A group's members, positive or negative, and its subtrahend, if any. */
const classOf = (members: ReadonlyArray<Drawn>, negated: boolean): Drawn => {
	const body = Arr.join(
		Arr.map(members, (m) => m.xsd),
		""
	)
	const union = `[${Arr.join(
		Arr.map(members, (m) => m.oracle),
		""
	)}]`
	return negated
		? { xsd: `^${body}`, oracle: outside(union) }
		: { xsd: body, oracle: within(union) }
}

/** A character class expression: a group, positive or negative, with a subtraction at its end or none. */
const classExpression: Gen<Drawn> = (source) => {
	const outer = classOf(
		source.draw(array(classMember, { min: 1, max: 3 })),
		source.draw(element([false, true]))
	)
	const subtracted = source.draw(element([false, true]))
	if (!subtracted) {
		return { xsd: `[${outer.xsd}]`, oracle: outer.oracle }
	}
	const inner = classOf(
		source.draw(array(classMember, { min: 1, max: 2 })),
		source.draw(element([false, true]))
	)
	return { xsd: `[${outer.xsd}-[${inner.xsd}]]`, oracle: `[${outer.oracle}--${inner.oracle}]` }
}

/** The wildcard: every XML character but a line feed or a carriage return. */
const wildcard: Drawn = { xsd: ".", oracle: outside("[\\u{A}\\u{D}]") }

/** An atom but a group. */
const leaf: Gen<Drawn> = weighted([
	[4, normalCharacter],
	[2, singleEscapes],
	[2, multiEscapes],
	[2, propertyEscapes],
	[3, classExpression],
	[1, constant(wildcard)]
])

/** A quantifier, or none. */
const quantifier: Gen<string> = weighted([
	[4, constant("")],
	[1, constant("?")],
	[1, constant("*")],
	[1, constant("+")],
	[1, map(int(0, 3), (n) => `{${n}}`)],
	[1, map(int(0, 2), (n) => `{${n},}`)],
	[
		1,
		(source) => {
			const n = source.draw(int(0, 2))
			return `{${n},${n + source.draw(int(0, 2))}}`
		}
	]
])

/** An expression of branches of pieces, a group's its own expression. */
const expression = (atom: Gen<Drawn>): Gen<Drawn> =>
	map(
		array(
			array(
				(source): Drawn => {
					const a = source.draw(atom)
					const q = source.draw(quantifier)
					return { xsd: `${a.xsd}${q}`, oracle: `(?:${a.oracle})${q}` }
				},
				{ min: 0, max: 3 }
			),
			{ min: 1, max: 3 }
		),
		(branches): Drawn => ({
			xsd: Arr.join(
				Arr.map(branches, (b) =>
					Arr.join(
						Arr.map(b, (p) => p.xsd),
						""
					)
				),
				"|"
			),
			oracle: Arr.join(
				Arr.map(branches, (b) =>
					Arr.join(
						Arr.map(b, (p) => p.oracle),
						""
					)
				),
				"|"
			)
		})
	)

/** An atom: a leaf, or a group of an expression nested at most two levels deep. */
const atom: Gen<Drawn> = recursive(
	leaf,
	(inner) =>
		map(expression(inner), (e): Drawn => ({ xsd: `(${e.xsd})`, oracle: `(?:${e.oracle})` })),
	2
)

/** A drawn pattern, its oracle anchored at both ends, as XML Schema anchors every expression. */
export const patternGen: Gen<Drawn> = map(expression(atom), (e) => ({
	xsd: e.xsd,
	oracle: `^(?:${e.oracle})$`
}))

/** Words over the pool, up to six characters. */
export const wordsGen: Gen<ReadonlyArray<string>> = array(
	map(array(element(pool), { min: 0, max: 6 }), (cs) => Arr.join(cs, "")),
	{ min: 8, max: 16 }
)

export type XsdFeature =
	| "a class subtraction"
	| "a negative group"
	| "a category escape"
	| "a block escape"
	| "the wildcard"
	| "a nested group"
	| "a word the pattern holds"
	| "a character outside XML's Char"

/** A construct outside Appendix F's grammar, alone or after a character: its pattern, its offset and its reason. */
export type RefusedConstruct = readonly [
	source: string,
	offset: number,
	reason: "MalformedDescription" | "UnsupportedOperation"
]

/** One construct of each kind outside the grammar, where it is refused and why. */
const refusedConstructs: Arr.NonEmptyReadonlyArray<RefusedConstruct> = [
	["a)", 1, "MalformedDescription"],
	["a)(b", 1, "MalformedDescription"],
	["(?:a)", 0, "UnsupportedOperation"],
	["(a", 0, "MalformedDescription"],
	["\\1", 0, "UnsupportedOperation"],
	["a**", 2, "MalformedDescription"],
	["*a", 0, "MalformedDescription"],
	["a{2,1}", 1, "MalformedDescription"],
	["a{9007199254740994,9007199254740993}", 1, "MalformedDescription"],
	["a{", 1, "MalformedDescription"],
	["[z-a]", 1, "MalformedDescription"],
	["[a", 0, "MalformedDescription"],
	["[a-z", 0, "MalformedDescription"],
	["(?i)yes", 0, "UnsupportedOperation"],
	["\\p{Foo}", 0, "UnsupportedOperation"],
	["\\p{IsNoSuchBlock}", 0, "UnsupportedOperation"]
]

/**
 * A construct outside the grammar, alone or as the arm after a branch of letters, so whatever stands before it is a
 * whole branch: where it is refused and why.
 */
export interface Refused {
	readonly source: string
	readonly offset: number
	readonly reason: RefusedConstruct[2]
}

export const refusedGen: Gen<Refused> = (source) => {
	const letters = Arr.join(
		source.draw(array(element(["a", "b", "c"] as const), { min: 0, max: 2 })),
		""
	)
	const prefix = letters === "" ? "" : `${letters}|`
	const [construct, at, reason] = source.draw(element(refusedConstructs))
	return { source: `${prefix}${construct}`, offset: prefix.length + at, reason }
}

export type RefusalFeature = "a malformed construct" | "a construct outside the grammar"

/** A code point drawn from anywhere in the code space, the BMP's names and Latin first, every plane past them. */
export const codePointGen: Gen<number> = weighted([
	[3, int(0x20, 0x3ff)],
	[2, int(0x400, 0xffff)],
	[1, int(0x10000, 0x10ffff)]
])

export type NameFeature = "a name start" | "a name character alone" | "no name character"

/** The reader's `\i` and `\c`, each read once. */
export const initialName = Matcher.of(buildNfa(succeeded(xsdPattern("\\i"), "\\i")))
export const nameCharacter = Matcher.of(buildNfa(succeeded(xsdPattern("\\c"), "\\c")))

/** A class escape: a multi-character escape, or a category or block escape, positive or negative. */
export const escapeGen: Gen<Drawn> = element([...classEscapes, ...propertyEscapeList])

export type EscapeFeature = "a character the escape holds" | "a character the escape does not hold"

export type CategoryFeature = "an assigned code point" | "an unassigned code point"

/** The category the committed table's runs give a code point. */
export const committedCategory = (point: number): string => {
	let at = 0
	for (const run of Str.split(",")(categoryRuns)) {
		const letter = Option.getOrThrow(Str.charCodeAt(0)(run))
		at += Number.parseInt(Str.slice(1)(run), 36)
		if (point < at) {
			return Arr.getUnsafe(generalCategories, letter >= 0x61 ? letter - 0x61 : letter - 0x41 + 26)
		}
	}
	return "Cn"
}

/** The generator's runs over the running Node, read once, as the committed table's ought to be. */
const runsOver = Function.memoize((_: typeof generalCategories): string => runsOfRunningNode())
export const generatedRuns = (): string => runsOver(generalCategories)
