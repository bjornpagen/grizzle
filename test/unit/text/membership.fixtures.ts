/** What the properties of membership.test.ts read: its spaces, models and helpers. */

import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { analyzeText, type TextRefinement } from "#compiler/text/refinement.ts"
import { pickGen } from "#test/support/pick.ts"
import { jsMatcher } from "#test/support/regex.ts"
import {
	families,
	finiteLanguageOver,
	type Flags,
	flagsGen,
	mostFiniteMembers,
	nestedPattern,
	patternOver,
	stringsOver,
	walkGen,
	walkTape
} from "#test/support/unit/text/generators.ts"
import { patternNfa, searchOf } from "#test/unit/text/emptiness.fixtures.ts"

export const testLoc = SourceLoc("str.regex", ["test"])

const refine = (source: string, flags: Flags): TextRefinement => {
	const result = analyzeText([{ source, flags }], testLoc)
	if (!result.ok) {
		throw new Error(`/${source}/${flags}: ${result.error.message}`)
	}
	return result.value
}

export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length

export const codePointLength = (value: string): number => Arr.fromIterable(value).length

/**
 * A family, a pattern over its alphabet, flags, and strings over its alphabet. One pattern in ten spells a finite
 * language, which the general patterns all but never are.
 */
export const membershipCaseGen: Gen<{
	readonly source: string
	readonly flags: Flags
	readonly strings: ReadonlyArray<string>
}> = (source) => {
	const family = source.draw(element(families))
	return {
		source: source.draw(
			weighted([
				[9, patternOver(family.alphabet)],
				[
					1,
					map(finiteLanguageOver(family.alphabet, mostFiniteMembers), (language) => language.source)
				]
			])
		),
		flags: source.draw(flagsGen),
		strings: source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 24 }))
	}
}

/**
 * The language a generated pattern recognizes may be empty, which analyzeText refuses; a generated pattern may also
 * exceed the compile-space budgets (ResourceBound), most often by its anchors. Both are refusals, not lowerings, so the
 * membership checks skip them; the refusals themselves are pinned in parse.test.ts and compile-space.test.ts. Emptiness is the language's own
 * classification (the parsed IR never), never a refusal's text.
 */
export const refineOrEmpty = (source: string, flags: Flags): TextRefinement | "empty" | "bound" => {
	const result = analyzeText([{ source, flags }], testLoc)
	if (result.ok) {
		return result.value
	}
	if (result.error.reason._tag === "ResourceBound") {
		return "bound"
	}
	const parsed = parsePattern(source, flags)
	if (parsed.ok && parsed.value.kind === "never") {
		return "empty"
	}
	throw new Error(`/${source}/${flags}: ${result.error.message}`)
}

/**
 * A generated case as a person promotes it from a failure report: the pattern, its flags, strings over the family's
 * alphabet, and walk tapes, resolved against the pattern's NFA in the property into members of its own language.
 */
interface PatternSketch {
	readonly source: string
	readonly flags: Flags
	readonly strings: ReadonlyArray<string>
	readonly walks: ReadonlyArray<ReadonlyArray<number>>
}

export type GeneratedFeature = "admitted" | "empty" | "witness"

export const patternSketchGen: Gen<PatternSketch> = (source) => {
	const family = source.draw(element(families))
	return {
		source: source.draw(patternOver(family.alphabet)),
		flags: source.draw(flagsGen),
		strings: source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 24 })),
		walks: source.draw(array(array(pickGen, { min: 0, max: walkTape }), { min: 0, max: 8 }))
	}
}

/** The handwritten family patterns, each feature a pattern's label: its family, its source and its flags. */
export type FamilyFeature = `${string} accepts` | `${string} refuses`

/** Each admitted pattern with its NFA, and the label its features carry. */
const patterns = Arr.flatMap(families, (family) =>
	Arr.flatMap(family.patterns, ([source, flags]) => {
		const r = refineOrEmpty(source, flags)
		assert.notEqual(r, "bound", `${family.name} /${source}/${flags} is admitted or empty`)
		return typeof r === "string"
			? []
			: [{ family, source, flags, r, label: `${family.name} /${source}/${flags}` }]
	})
)

export const admittedPatterns = nonEmpty(patterns, "the families hold admitted patterns")

/** A family pattern, and a string drawn for it: a member its own NFA walks to (a witness) or any other. */
export type FamilyCase = [
	(typeof patterns)[number],
	{ readonly witness: boolean; readonly s: string | undefined }
]

/**
 * Each pattern that is no tautology on the first string it refuses among the empty string, its family's code points
 * alone, in pairs and nine times over, and two code points outside every family's alphabet: the string a witness draws
 * where its turn aims at the pattern's refusal (familyDraw), since a pattern's share of the cases meets a refused
 * string only a few times a run for some.
 */
export const refusals = Arr.map(
	Arr.filter(admittedPatterns, (p) => p.r.check.kind !== "tautology"),
	(p): FamilyCase => {
		const points = Arr.map(p.family.alphabet, (c) => String.fromCodePoint(c))
		const pairs = Arr.flatMap(points, (a) => Arr.map(points, (b) => `${a}${b}`))
		const ofPattern = jsMatcher(p.source, p.flags)
		const found = Arr.findFirst(
			[
				"",
				...points,
				...pairs,
				...Arr.map(points, (a) => Str.repeat(9)(a)),
				String.fromCodePoint(0xe000),
				String.fromCodePoint(0x10ffff)
			],
			(x) => !ofPattern(x)
		)
		if (Option.isNone(found)) {
			throw new Error(`${p.label} refuses no planted candidate`)
		}
		return [p, { witness: false, s: found.value }]
	}
)

/**
 * Each pattern on a member of its language: the text a search of its own NFA, its anchors read by walk's rules, finds
 * (emptiness.fixtures.ts searchOf), the string a witness draws where its turn aims at the pattern's acceptance
 * (familyDraw).
 */
export const acceptances = Arr.map(admittedPatterns, (p): FamilyCase => {
	const { member } = searchOf(patternNfa(p.source, p.flags))
	if (member === undefined) {
		throw new Error(`${p.label} is admitted and no way through its NFA matches`)
	}
	return [p, { witness: true, s: member }]
})

export const familyCaseGen: Gen<FamilyCase> = oneOf(
	Arr.map(admittedPatterns, (p): Gen<FamilyCase> => {
		const drawnString = oneOf<FamilyCase[1]>([
			map(stringsOver(element(p.family.alphabet), 8), (s) => ({ witness: false, s })),
			map(walkGen(buildNfa(p.r.members[0].ir)), (s) => ({ witness: true, s }))
		])
		return (source) => [p, source.draw(drawnString)]
	})
)

/** Every handwritten family pattern. */
export const familyPatterns = nonEmpty(
	Arr.flatMap(families, (family) => family.patterns),
	"the families hold patterns"
)

/**
 * The patterns every admitted text matches: the tautology, `^.*$` under the s flag, and the empty pattern, which matches
 * every text at its start, so a host that read a text holding a NUL or a lone surrogate would match it.
 */
export const tautologies = [refine("^.*$", "su"), refine("", "u")] as const

export type KeyFeature =
	| "equal keys"
	| "distinct keys"
	| "distinct keys of patterns one code point apart"

/**
 * A pattern with one of its code points, drawn by position, changed to a drawn code point of the alphabet: a pattern
 * near the first, whose language is the first's or differs at that code point, where a key that drops a set collides.
 * A change inside the pattern's syntax may spell no admitted pattern, which the property passes over.
 */
const oneCodePointChanged =
	(pattern: string, alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) => {
		const points = codePoints(pattern)
		const at = source.draw(int(0, Math.max(points.length - 1, 0)))
		const replacement = source.draw(element(alphabet))
		return codePointsText(Arr.map(points, (point, i) => (i === at ? replacement : point)))
	}

/** A keys case: two patterns over one family's alphabet under one set of flags, strings over it, and walk tapes. */
export interface KeyCase {
	readonly a: string
	readonly b: string
	readonly flags: Flags
	readonly strings: ReadonlyArray<string>
	readonly walks: ReadonlyArray<ReadonlyArray<number>>
}

/** Strings over a family's alphabet, and the tapes of walks over each pattern's own NFA, members of its language. */
const samplesOver =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<Pick<KeyCase, "strings" | "walks">> =>
	(source) => ({
		strings: source.draw(array(stringsOver(element(alphabet), 8), { min: 1, max: 24 })),
		walks: source.draw(array(array(pickGen, { min: 0, max: walkTape }), { min: 0, max: 8 }))
	})

/** A pattern over a family's alphabet, and another drawn apart or as the first with one code point changed. */
export const keyCaseGen: Gen<KeyCase> = (source) => {
	const family = source.draw(element(families))
	const a = source.draw(patternOver(family.alphabet))
	return {
		a,
		b: source.draw(
			weighted<string>([
				[1, patternOver(family.alphabet)],
				[3, oneCodePointChanged(a, family.alphabet)]
			])
		),
		flags: source.draw(flagsGen),
		...source.draw(samplesOver(family.alphabet))
	}
}

/** The pattern grammar's syntax characters, which spell no code point of their own outside a class. */
const syntaxCharacters: ReadonlySet<number> = new Set(codePoints("^$\\.*+?()[]{}|/"))

/**
 * A word of up to four of a family's code points that spell themselves, anchored at either end or not, and the same
 * word with one code point changed to another: two patterns one code point apart whose automata differ in that one
 * edge's set alone, where a key that drops the sets collides. keyCaseGen's change lands on a code point that spells
 * itself in few of its cases.
 */
export const oneLiteralChangedGen: Gen<KeyCase> = (source) => {
	const family = source.draw(element(families))
	const letters = nonEmpty(
		Arr.filter(family.alphabet, (c) => !syntaxCharacters.has(c)),
		`${family.name} holds a code point that spells itself`
	)
	const word = source.draw(array(int(0, letters.length - 1), { min: 1, max: 4 }))
	const at = source.draw(int(0, word.length - 1))
	const step = source.draw(int(1, letters.length - 1))
	const start = source.draw(element(["", "^"]))
	const end = source.draw(element(["", "$"]))
	const spell = (places: ReadonlyArray<number>): string =>
		`${start}${codePointsText(Arr.map(places, (place) => Arr.getUnsafe(letters, place)))}${end}`
	return {
		a: spell(word),
		b: spell(Arr.map(word, (place, i) => (i === at ? (place + step) % letters.length : place))),
		flags: source.draw(flagsGen),
		...source.draw(samplesOver(family.alphabet))
	}
}

/** Whether two patterns are spelled alike but for one code point. */
export const oneApart = (a: string, b: string): boolean => {
	const [x, y] = [codePoints(a), codePoints(b)]
	return x.length === y.length && Arr.filter(x, (c, i) => c !== y[i]).length === 1
}

/** A spelling of a finite language as the alternation of its members, each code point its braced escape. */
const memberSpelling = (members: ReadonlyArray<string>): string =>
	`^(?:${Arr.join(
		Arr.map(members, (m) =>
			Arr.join(
				Arr.map(codePoints(m), (c) => `\\u{${c.toString(16)}}`),
				""
			)
		),
		"|"
	)})$`

/**
 * The most members a drawn language holds: a search budget, no claim. Every case analyzes the alternation of every
 * member, whose subset construction grows with them, and a language past the analysis bounds is keyed by its IR or
 * refused, which the property passes over, so a larger language costs a case and finds nothing a smaller one does
 * not.
 */
export const spelledMembers = 48

/**
 * A finite language of at most spelledMembers members over a family's alphabet, its pattern's flags, and its members
 * in a drawn order under flags of their own: two spellings of one language, which share no syntax but its anchors.
 */
export const twoSpellings: Gen<{
	readonly language: { readonly source: string; readonly flags: Flags }
	readonly members: { readonly source: string; readonly flags: Flags }
	readonly count: number
	readonly withEmpty: boolean
}> = (source) => {
	const { alphabet } = source.draw(element(families))
	const language = source.draw(finiteLanguageOver(alphabet, spelledMembers))
	const order = source.draw(
		shuffled(language.members, { min: language.members.length, max: language.members.length })
	)
	return {
		language: { source: language.source, flags: source.draw(flagsGen) },
		members: { source: memberSpelling(order), flags: source.draw(flagsGen) },
		count: language.members.length,
		withEmpty: language.members.includes("")
	}
}

export type SpellingFeature =
	| "one member"
	| "several members"
	| "the empty text a member"
	| "a spelling past the analysis bounds"

/** Whether a key is a language's IR, which keys a pattern past the subset construction's bounds (refinement.ts keyOf). */
export const keyedByIr = (key: string): boolean => Str.startsWith("ir:")(key)

/**
 * A case of the work property: an admitted pattern a backtracking matcher would take exponentially many steps over,
 * whether written by hand or drawn as nested quantifiers (generators.ts nestedPattern) before a `b` no run of its texts
 * holds, and the code point its texts end in.
 */
export interface WorkCase {
	readonly source: string
	readonly drawn: boolean
	readonly last: string
}

export type WorkFeature =
	| "a written pattern a backtracker takes exponentially many steps over"
	| "a drawn pattern of nested quantifiers"
	| "a text it matches"
	| "a text it refuses"
	| "a text of over a thousand code points"

/**
 * Patterns a backtracking matcher reads a run of `a`s and a last code point over by exponentially many paths: each `a`
 * matched by either arm of an alternation or either level of a nested repetition, and the last code point refusing every
 * path but none, so a backtracker tries them all.
 */
const catastrophicPatterns: Arr.NonEmptyReadonlyArray<string> = [
	"^(?:a|a)*$",
	"^(?:a*)*$",
	"^(?:a+)+b",
	"^(?:a|aa)*c$",
	"(?:a?){8}a{8}x"
]

export const workCaseGen: Gen<WorkCase> = (source) => {
	const drawn = source.draw(element([false, true]))
	return {
		source: drawn ? `${source.draw(nestedPattern)}b` : source.draw(element(catastrophicPatterns)),
		drawn,
		last: source.draw(element(["", "a", "b", "c", "x"]))
	}
}

/**
 * The lengths of a case's runs of `a`, doubling from one past a thousand, so a matcher whose work outgrows a linear
 * bound passes it at a short run, before its work is too large to wait for.
 */
export const runLengths: Arr.NonEmptyReadonlyArray<number> = [
	1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048
]
