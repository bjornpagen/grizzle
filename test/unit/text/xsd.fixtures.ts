/**
 * What the properties of xsd.test.ts read: drawn XML Schema patterns, each beside its oracle, the pattern's meaning
 * built construct by construct from Appendix F's definitions, each character class an ECMAScript class under the `v`
 * flag and the regular operators a tree the oracle matches by partial derivatives, and drawn words to hold the
 * reader's language to it.
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
import { compiledPattern } from "#test/support/regex.ts"

/**
 * A drawn class of a pattern, one character's worth: its XML Schema spelling and its oracle's, an ECMAScript `v`-flag
 * class of the characters Appendix F says it means.
 */
export interface Drawn {
	readonly xsd: string
	readonly oracle: string
}

/**
 * A drawn pattern's meaning by Appendix F, construct by construct: a class (its ECMAScript `v`-flag spelling, Drawn's
 * oracle), the concatenation of pieces, the alternation of branches, and a piece repeated between `min` and `max`
 * times, `max` none for no bound. The regular operators are a tree, never one ECMAScript expression, so the oracle
 * matches a word by partial derivatives (oracleMatcher) in time linear in the word: a backtracking engine reading the
 * nested repetitions of alternations that admit the empty word, as `((a|)+|){2,}`, tries exponentially many splits
 * of the word, and V8's held a property's worker past its deadline on a word of five code points.
 */
export type Oracle =
	| { readonly kind: "class"; readonly source: string }
	| { readonly kind: "seq"; readonly items: ReadonlyArray<Oracle> }
	| { readonly kind: "alt"; readonly branches: ReadonlyArray<Oracle> }
	| {
			readonly kind: "repeat"
			readonly of: Oracle
			readonly min: number
			readonly max: number | undefined
	  }

/** A drawn pattern, or a piece or group of one: its XML Schema spelling and its oracle, its meaning (Oracle). */
export interface DrawnPattern {
	readonly xsd: string
	readonly oracle: Oracle
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

/** A quantifier: its XML Schema spelling and the counts it repeats its piece between; none, the empty spelling. */
interface Quantifier {
	readonly spelled: string
	readonly min: number
	readonly max: number | undefined
}

/** A quantifier, or none. */
const quantifier: Gen<Quantifier | undefined> = weighted<Quantifier | undefined>([
	[4, constant(undefined)],
	[1, constant({ spelled: "?", min: 0, max: 1 })],
	[1, constant({ spelled: "*", min: 0, max: undefined })],
	[1, constant({ spelled: "+", min: 1, max: undefined })],
	[1, map(int(0, 3), (n) => ({ spelled: `{${n}}`, min: n, max: n }))],
	[1, map(int(0, 2), (n) => ({ spelled: `{${n},}`, min: n, max: undefined }))],
	[
		1,
		(source) => {
			const n = source.draw(int(0, 2))
			const m = n + source.draw(int(0, 2))
			return { spelled: `{${n},${m}}`, min: n, max: m }
		}
	]
])

/** An expression of branches of pieces, a group's its own expression. */
const expression = (atom: Gen<DrawnPattern>): Gen<DrawnPattern> =>
	map(
		array(
			array(
				(source): DrawnPattern => {
					const a = source.draw(atom)
					const q = source.draw(quantifier)
					return q === undefined
						? a
						: {
								xsd: `${a.xsd}${q.spelled}`,
								oracle: { kind: "repeat", of: a.oracle, min: q.min, max: q.max }
							}
				},
				{ min: 0, max: 3 }
			),
			{ min: 1, max: 3 }
		),
		(branches): DrawnPattern => ({
			xsd: Arr.join(
				Arr.map(branches, (b) =>
					Arr.join(
						Arr.map(b, (p) => p.xsd),
						""
					)
				),
				"|"
			),
			oracle: {
				kind: "alt",
				branches: Arr.map(branches, (b) => ({ kind: "seq", items: Arr.map(b, (p) => p.oracle) }))
			}
		})
	)

/** An atom: a leaf, its class its oracle, or a group of an expression nested at most two levels deep. */
const atom: Gen<DrawnPattern> = recursive(
	map(leaf, (l): DrawnPattern => ({ xsd: l.xsd, oracle: { kind: "class", source: l.oracle } })),
	(inner) => map(expression(inner), (e): DrawnPattern => ({ xsd: `(${e.xsd})`, oracle: e.oracle })),
	2
)

/** A drawn pattern; its oracle matches the whole word, as XML Schema anchors every expression. */
export const patternGen: Gen<DrawnPattern> = expression(atom)

/** The ECMAScript `v`-flag spelling of an oracle, anchored at both ends: what a failure shows, never what matches. */
export const oracleText = (oracle: Oracle): string => `^(?:${spelled(oracle)})$`

const spelled = (oracle: Oracle): string => {
	switch (oracle.kind) {
		case "class":
			return oracle.source
		case "seq":
			return Arr.join(
				Arr.map(oracle.items, (i) => `(?:${spelled(i)})`),
				""
			)
		case "alt":
			return Arr.join(Arr.map(oracle.branches, spelled), "|")
		case "repeat":
			return `(?:${spelled(oracle.of)}){${oracle.min},${oracle.max ?? ""}}`
	}
}

/** An oracle node as the matcher reads it: each class compiled once, each node numbered by its place in the tree. */
type Node =
	| { readonly kind: "class"; readonly id: number; readonly test: (c: string) => boolean }
	| { readonly kind: "seq"; readonly id: number; readonly items: ReadonlyArray<Node> }
	| { readonly kind: "alt"; readonly id: number; readonly branches: ReadonlyArray<Node> }
	| {
			readonly kind: "repeat"
			readonly id: number
			readonly of: Node
			readonly min: number
			readonly max: number | undefined
	  }

/** The matcher's nodes of an oracle, numbered in a walk from `next`, with the count it reached. */
const compiled = (oracle: Oracle, next: { n: number }): Node => {
	const id = next.n++
	switch (oracle.kind) {
		case "class": {
			const cls = compiledPattern(`^${oracle.source}$`, "v")
			return { kind: "class", id, test: (c) => cls.test(c) }
		}
		case "seq":
			return { kind: "seq", id, items: Arr.map(oracle.items, (i) => compiled(i, next)) }
		case "alt":
			return { kind: "alt", id, branches: Arr.map(oracle.branches, (b) => compiled(b, next)) }
		case "repeat":
			return { kind: "repeat", id, of: compiled(oracle.of, next), min: oracle.min, max: oracle.max }
	}
}

/** Whether a node matches the empty word. */
const nullable = (node: Node): boolean => {
	switch (node.kind) {
		case "class":
			return false
		case "seq":
			return Arr.every(node.items, nullable)
		case "alt":
			return Arr.some(node.branches, nullable)
		case "repeat":
			return node.min === 0 || nullable(node.of)
	}
}

/**
 * A partial derivative (Antimirov): what is left of a match to read, a concatenation of nodes, each a node of the tree
 * or a repetition of one with fewer counts left. Its key names it by each node's number and a repetition's counts, so
 * two equal derivatives are one state.
 */
type Term = ReadonlyArray<Node>

const keyOf = (term: Term): string =>
	Arr.join(
		Arr.map(term, (n) => (n.kind === "repeat" ? `${n.id}{${n.min},${n.max ?? ""}}` : `${n.id}`)),
		" "
	)

/** The partial derivatives of a node by the code point `c`: the terms left to read after reading it first. */
const nodeDerivatives = (node: Node, c: string): ReadonlyArray<Term> => {
	switch (node.kind) {
		case "class":
			return node.test(c) ? [[]] : []
		case "seq":
			return termDerivatives(node.items, c)
		case "alt":
			return Arr.flatMap(node.branches, (b) => nodeDerivatives(b, c))
		case "repeat": {
			if (node.max === 0) {
				return []
			}
			const max = node.max === undefined ? undefined : node.max - 1
			const rest: Term =
				max === 0 ? [] : [{ ...node, min: nullable(node.of) ? 0 : Math.max(node.min - 1, 0), max }]
			return Arr.map(nodeDerivatives(node.of, c), (t) => Arr.appendAll(t, rest))
		}
	}
}

/** The partial derivatives of a concatenation: its head's, then its tail's where the head may read nothing. */
const termDerivatives = (term: Term, c: string): ReadonlyArray<Term> => {
	const [head, ...rest] = term
	if (head === undefined) {
		return []
	}
	const first = Arr.map(nodeDerivatives(head, c), (t) => Arr.appendAll(t, rest))
	return nullable(head) ? Arr.appendAll(first, termDerivatives(rest, c)) : first
}

/**
 * The oracle's matcher of a drawn pattern: whether a word is in the pattern's language, by Antimirov's partial
 * derivatives over the oracle's tree, each class tested on one code point. The states a word reaches are sets of
 * distinct terms, each a concatenation of the tree's nodes and repetitions with fewer counts left, at most the tree's
 * positions times the counts its repetitions hold; a word of n code points costs n steps over at most that many
 * terms, linear in the word, whatever the pattern nests.
 */
export const oracleMatcher = (oracle: Oracle): ((word: string) => boolean) => {
	const root = compiled(oracle, { n: 0 })
	return (word) => {
		let states: ReadonlyArray<Term> = [[root]]
		for (const c of word) {
			const next = new Map<string, Term>()
			for (const term of states) {
				for (const d of termDerivatives(term, c)) {
					next.set(keyOf(d), d)
				}
			}
			states = Arr.fromIterable(next.values())
		}
		return Arr.some(states, (term) => Arr.every(term, nullable))
	}
}

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
