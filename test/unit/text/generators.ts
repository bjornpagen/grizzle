import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { Array as Arr, Option, pipe, String as Str } from "effect"
import { codePointsText } from "#compiler/core/text.ts"
import type { CharSet } from "#compiler/scalar/regex/charset.ts"
import type { Nfa } from "#compiler/scalar/regex/match.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

import { regex } from "arkregex"
/**
 * Generators for the regex differential tests: admitted patterns written in every spelling the grammar
 * accepts, and strings over alphabets chosen to probe one semantic edge each. ECMAScript RegExp appears only in the
 * tests that import these, as the development oracle; it never appears under src/.
 */
export type Flags = "u" | "su"

/**
 * One family: an alphabet the strings and pattern literals draw from, and handwritten patterns that aim at the edge.
 */
export interface Family {
	readonly name: string
	readonly alphabet: Arr.NonEmptyReadonlyArray<number>
	readonly patterns: ReadonlyArray<readonly [source: string, flags: Flags]>
}

/** A value the generator's own indexing guarantees: its absence is a bug in the generator. */
const defined = <T>(value: T | undefined, what: string): T => {
	if (value === undefined) {
		throw new Error(`expected ${what}`)
	}
	return value
}

const cps = (text: string): Arr.NonEmptyReadonlyArray<number> => {
	const chars = Arr.fromIterable(text)
	if (!Arr.isReadonlyArrayNonEmpty(chars)) {
		throw new Error("an alphabet holds at least one code point")
	}
	return Arr.map(chars, (ch) =>
		Option.getOrThrowWith(Str.codePointAt(ch, 0), () => new Error("a code point"))
	)
}

/**
 * ASCII digits, other decimal digits that ECMAScript's \d and \w exclude, and their neighbors: ARABIC-INDIC DIGIT ZERO
 * (U+0660), EXTENDED ARABIC-INDIC DIGIT FOUR (U+06F4), DEVANAGARI DIGIT ZERO (U+0966), THAI DIGIT ONE (U+0E51),
 * FULLWIDTH DIGIT ZERO (U+FF10), MATHEMATICAL BOLD DIGIT ZERO (U+1D7CE), SUPERSCRIPT TWO (U+00B2) and CIRCLED DIGIT ONE
 * (U+2460).
 */
const nonAsciiDigits = [
	0x0660, 0x0669, 0x06f4, 0x0966, 0x0e51, 0xff10, 0xff19, 0x1d7ce, 0x1d7ff, 0x00b2, 0x2460
] as const

/** ECMAScript's four line terminators, and whitespace that is not one of them. */
const lineTerminators = [0x0a, 0x0d, 0x2028, 0x2029] as const
const otherSpace = [
	0x09, 0x0b, 0x0c, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x200b, 0x3000, 0xfeff
] as const

const supplementary = [0x10000, 0x1f600, 0x1f601, 0x20bb7, 0x10fffe, 0x10ffff] as const
const bmpHigh = [0xd7ff, 0xe000, 0xfffd, 0xffff] as const

export const families: Arr.NonEmptyReadonlyArray<Family> = [
	{
		name: "non-ASCII digits",
		alphabet: [...cps("0129-._aZ"), ...nonAsciiDigits],
		patterns: [
			["^\\d+$", "u"],
			["^\\d{2}-\\d{7}$", "u"],
			["\\d", "u"],
			["^\\D*$", "u"],
			["^[0-9]+(?:\\.[0-9]+)?$", "u"],
			["^\\w+$", "u"],
			["\\W", "u"],
			["^[\\d_]{1,3}$", "u"],
			["^[^\\d]$", "u"],
			["^(\\d*)\\.(\\d*)\\.(\\d*)$", "u"],
			["[\\u0660-\\u0669]", "u"],
			["^\\u{1D7CE}\\d$", "u"]
		]
	},
	{
		name: "line terminators",
		alphabet: [...cps("ab"), ...lineTerminators, ...otherSpace],
		patterns: [
			["^.*$", "u"],
			["^.*$", "su"],
			["^.+$", "u"],
			["a.b", "u"],
			["a.b", "su"],
			["^[^\\n]*$", "u"],
			["\\r\\n", "u"],
			["^[\\n\\r\\u2028\\u2029]+$", "u"],
			["^a$", "u"],
			["[\\t\\v\\f ]", "u"],
			["^(?:a|\\u2028)*$", "u"],
			["^.?$", "su"],
			["\\u0085", "u"]
		]
	},
	{
		name: "anchors",
		alphabet: cps("abc\n"),
		patterns: [
			["^a", "u"],
			["a$", "u"],
			["^$", "u"],
			["^a|b$", "u"],
			["(?:^|b)a", "u"],
			["a(?:$|b)", "u"],
			["^(?:a$)?", "u"],
			["a^", "u"],
			["$a", "u"],
			["(?:^)*a", "u"],
			["(^a)*b", "u"],
			["$^", "u"],
			["^(a|b)*$", "u"],
			["^[a-c]{2,3}$", "u"],
			["(?:a|^)(?:b|$)", "u"],
			["(?:a|$)*b", "u"],
			["(?:a?$)*", "u"],
			["^(?:(?:a|$|)b?)+c", "u"],
			["(?:(?:^|a)(?:b|$))*c", "u"],
			["(?:a$|b)+", "u"],
			["(?:(?:a|^)*b|$)*c", "u"],
			["(?:(?:.|$|){0,2})+b", "u"],
			["(?:(?:^){3}){2}a", "u"],
			["^^a$$", "u"],
			["(?:(?:^|b)(?:c|$)){2,}a?", "u"]
		]
	},
	{
		name: "negated classes",
		alphabet: [...cps("aAz-]^\\"), ...supplementary, ...bmpHigh],
		patterns: [
			["^[^a]$", "u"],
			["^[^a-z]+$", "u"],
			["[^\\u0001-\\uFFFF]", "u"],
			["^[^\\w]*$", "u"],
			["^\\W+$", "u"],
			["^[^]$", "u"],
			["^[^\\-\\]]$", "u"],
			["^[^\\^]+$", "u"],
			["^[\\uD7FF-\\uE000]$", "u"],
			["^[\\u{10000}-\\u{10FFFF}]+$", "u"],
			["^[^\\uD83D\\uDE00]$", "u"],
			["[^\\\\a]", "u"],
			["^[^\\D]$", "u"]
		]
	},
	{
		name: "empty string",
		alphabet: cps("ab"),
		patterns: [
			["", "u"],
			["^$", "u"],
			["^(?:)$", "u"],
			["^a?$", "u"],
			["^a*$", "u"],
			["^(a|)$", "u"],
			["^(?:a|b){0,2}$", "u"],
			["^a+$", "u"],
			["^(?:a{0})$", "u"],
			["^.+$", "su"],
			["()", "u"],
			["^(|a)b?$", "u"],
			["^(?:a?){12}$", "u"],
			["^(?:a|){6}b(?:|b){6}$", "u"],
			["^(?:(?:a|)b?){4}$", "u"]
		]
	},
	{
		name: "escapes and literals",
		alphabet: [...cps("a.*+?()[]{}|/\\$^-é"), 0x7f, 0x08, 0x01, 0x1f600],
		patterns: [
			["^\\.\\*\\+\\?$", "u"],
			["\\(\\)\\[\\]\\{\\}", "u"],
			["\\|\\/\\\\", "u"],
			["^[.*+?()]+$", "u"],
			["\\x7f", "u"],
			["[\\b]", "u"],
			["\\cA", "u"],
			["^\\u00e9$", "u"],
			["^é$", "u"],
			["\\u{1F600}", "u"],
			["\\uD83D\\uDE00", "u"],
			["😀", "u"],
			["^[\\-a]$", "u"],
			["^[a-]$", "u"],
			["^[\\$\\^]$", "u"]
		]
	}
]

/** Strings over a family's alphabet, plus arbitrary admitted scalars, empty included. */
export const stringsOver = (
	alphabet: Arr.NonEmptyReadonlyArray<number>,
	maxLength: number
): Gen<string> =>
	map(
		array(
			weighted([
				[8, element(alphabet)],
				[1, int(1, 0xd7ff)],
				[1, int(0xe000, 0x10ffff)]
			]),
			{ min: 0, max: maxLength }
		),
		(points) => codePointsText(points)
	)

const syntax = "^$\\.*+?()[]{}|/"

const hex = (c: number, width: number): string =>
	pipe(Str.toUpperCase(c.toString(16)), Str.padStart(width, "0"))

/**
 * One code point in one of the spellings the grammar admits outside a class: itself (a syntax character escaped, `\/`
 * among them), a hex, BMP or braced Unicode escape, a control escape (\cA-\cZ or \ca-\cz for U+0001-U+001A), or
 * \n, \r, \t, \v and \f.
 */
const spelled =
	(c: number): Gen<string> =>
	(source) => {
		const spelling = source.draw(int(0, 4))
		const lower = source.draw(boolean)
		const ch = String.fromCodePoint(c)
		if (spelling === 1 && c <= 0xff) {
			return `\\x${hex(c, 2)}`
		}
		if (spelling === 2 && c <= 0xffff && (c < 0xd800 || c > 0xdfff)) {
			return `\\u${hex(c, 4)}`
		}
		if (spelling === 3) {
			return `\\u{${c.toString(16)}}`
		}
		if (spelling === 4 && c >= 0x01 && c <= 0x1a) {
			return `\\c${String.fromCharCode((lower ? 0x60 : 0x40) + c)}`
		}
		if (c === 0x0a) {
			return "\\n"
		}
		if (c === 0x0d) {
			return "\\r"
		}
		if (c === 0x09) {
			return "\\t"
		}
		if (c === 0x0b) {
			return "\\v"
		}
		if (c === 0x0c) {
			return "\\f"
		}
		return Str.includes(ch)(syntax) ? `\\${ch}` : ch
	}

/** A code point of the alphabet, spelled outside a class. */
const literal =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) =>
		source.draw(spelled(source.draw(element(alphabet))))

const classChar = (c: number): string => {
	const ch = String.fromCodePoint(c)
	if (Str.includes(ch)("\\]^-")) {
		return `\\${ch}`
	}
	if (c === 0x0a) {
		return "\\n"
	}
	return ch
}

const characterClass = (alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> => {
	const item = oneOf<string>([
		map(element(alphabet), classChar),
		(source) => {
			const a = source.draw(element(alphabet))
			const b = source.draw(element(alphabet))
			return `${classChar(Math.min(a, b))}-${classChar(Math.max(a, b))}`
		},
		element(["\\d", "\\D", "\\w", "\\W"])
	])
	return (source) => {
		const negated = source.draw(boolean)
		const items = source.draw(array(item, { min: 0, max: 3 }))
		return `[${negated ? "^" : ""}${Arr.join(items, "")}]`
	}
}

const quantifier: Gen<string> = weighted<string>([
	[6, constant("")],
	[4, element(["?", "*", "+"])],
	[
		2,
		(source) => {
			const m = source.draw(int(0, 3))
			const extra = source.draw(int(0, 2))
			const form = source.draw(int(0, 2))
			return form === 0 ? `{${m}}` : form === 1 ? `{${m},}` : `{${m},${m + extra}}`
		}
	]
])

/**
 * The weight of a term's plain option by how many terms enclose it: a term inside two or more others weighs its plain
 * option more, by the options' total weight times ⌊1.5^depth⌋ − 1, so a pattern stays shallow, and a term past the
 * last depth offers only its plain options, so every pattern is finite. A term's options weigh 13 in all, a flat
 * term's 10.
 */
const TERM_FIRST = [8, 8, 21, 34, 60, 86] as const
const FLAT_FIRST = [8, 8, 18, 28, 48, 68] as const

/**
 * Admitted patterns of bounded depth over an alphabet. Every construct appears, groups nest, and anchors fall
 * anywhere, but a quantified group holds no quantifier itself (star height one): ECMAScript's backtracking matcher,
 * the development oracle, takes exponential time on nested quantifiers, which the host NFA and PostgreSQL do not.
 * Nested quantifiers are covered by the handwritten family patterns over short strings.
 */
export const patternOver = (alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> => {
	const simple = weighted<string>([
		[6, literal(alphabet)],
		[1, constant(".")],
		[1, element(["\\d", "\\D", "\\w", "\\W"])],
		[2, characterClass(alphabet)]
	])
	const open = element(["(", "(?:"])
	const anchor = element(["^", "$"])
	const flatDisjunction = (depth: number): Gen<string> => {
		const term = flatTerm(depth)
		return map(
			array(
				map(array(term, { min: 0, max: 3 }), (terms) => Arr.join(terms, "")),
				{ min: 1, max: 3 }
			),
			(arms) => Arr.join(arms, "|")
		)
	}
	const flatTerm = (depth: number): Gen<string> => {
		const first = FLAT_FIRST[depth]
		if (first === undefined) {
			return weighted([
				[8, simple],
				[1, anchor]
			])
		}
		const inner = flatDisjunction(depth + 1)
		return weighted<string>([
			[first, simple],
			[1, anchor],
			[1, (source) => `${source.draw(open)}${source.draw(inner)})`]
		])
	}
	const disjunction = (depth: number): Gen<string> => {
		const term = termAt(depth)
		return map(
			array(
				map(array(term, { min: 0, max: 4 }), (terms) => Arr.join(terms, "")),
				{ min: 1, max: 3 }
			),
			(arms) => Arr.join(arms, "|")
		)
	}
	const quantified: Gen<string> = (source) => source.draw(simple) + source.draw(quantifier)
	const termAt = (depth: number): Gen<string> => {
		const first = TERM_FIRST[depth]
		if (first === undefined) {
			return weighted([
				[8, quantified],
				[1, anchor]
			])
		}
		const flat = flatDisjunction(0)
		const nested = disjunction(depth + 1)
		return weighted<string>([
			[first, quantified],
			[1, anchor],
			[
				2,
				(source) => {
					const o = source.draw(open)
					const body = source.draw(flat)
					const q = source.draw(quantifier)
					return `${o}${body})${q}`
				}
			],
			[2, (source) => `${source.draw(open)}${source.draw(nested)})`]
		])
	}
	return disjunction(0)
}

/** A finite language as a pattern spells it, with its members, which the pattern's construction gives. */
export interface FiniteLanguage {
	readonly source: string
	readonly members: Arr.NonEmptyReadonlyArray<string>
}

/** A spelled part of a pattern, with every string it matches. */
interface Spelled {
	readonly spelling: string
	readonly matches: ReadonlyArray<string>
}

/** The one string a sequence of no pieces matches. */
const emptySequence: ReadonlyArray<string> = [""]

/** Every string of `length` code points, each one of `points`. */
const stringsOf = (points: ReadonlyArray<string>, length: number): ReadonlyArray<string> =>
	length === 0
		? emptySequence
		: Arr.flatMap(stringsOf(points, length - 1), (prefix) => Arr.map(points, (p) => prefix + p))

/** How many times a piece repeats, at least and at most: once, mostly, or counted from none to twice. */
const repetition: Gen<readonly [min: number, max: number]> = weighted<
	readonly [min: number, max: number]
>([
	[3, constant([1, 1] as const)],
	[
		1,
		(source) => {
			const min = source.draw(int(0, 2))
			return [min, source.draw(int(min, 2))] as const
		}
	]
])

/** A code point of the alphabet, or a class of up to three, repeated: one piece of a finite pattern's arm. */
const finitePiece =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<Spelled> =>
	(source) => {
		const first = source.draw(element(alphabet))
		const more = source.draw(array(element(alphabet), { min: 0, max: 2 }))
		const [min, max] = source.draw(repetition)
		const points: Arr.NonEmptyReadonlyArray<number> = [first, ...more]
		const atom =
			more.length === 0
				? source.draw(spelled(first))
				: `[${Arr.join(Arr.map(points, classChar), "")}]`
		const count = min === 1 && max === 1 ? "" : min === max ? `{${min}}` : `{${min},${max}}`
		const chars = Arr.dedupe(Arr.map(points, (c) => String.fromCodePoint(c)))
		return {
			spelling: `${atom}${count}`,
			matches: Arr.flatMap(Arr.range(min, max), (n) => stringsOf(chars, n))
		}
	}

/** The spellings of a pattern's parts, joined by `separator`. */
const spellingsOf = (parts: ReadonlyArray<Spelled>, separator: string): string =>
	Arr.join(
		Arr.map(parts, (part) => part.spelling),
		separator
	)

/** A sequence of up to three pieces: one arm of a finite pattern, matching each concatenation of its pieces' strings. */
const finiteArm = (alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<Spelled> =>
	map(array(finitePiece(alphabet), { min: 0, max: 3 }), (pieces) => ({
		spelling: spellingsOf(pieces, ""),
		matches: Arr.reduce(pieces, emptySequence, (prefixes, p) =>
			Arr.flatMap(prefixes, (prefix) => Arr.map(p.matches, (m) => prefix + m))
		)
	}))

/**
 * Anchored alternations of up to three arms over an alphabet, each a sequence of code points and classes counted up to
 * twice: a finite language, from one member to thousands, which patternOver, whose anchors fall anywhere among its
 * unbounded quantifiers, draws about once in thousands of cases.
 */
export const finiteLanguageOver =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<FiniteLanguage> =>
	(source) => {
		const arms = source.draw(array(finiteArm(alphabet), { min: 1, max: 3 }))
		const members = Arr.dedupe(Arr.flatMap(arms, (arm) => arm.matches))
		if (!Arr.isReadonlyArrayNonEmpty(members)) {
			throw new Error("every arm of a finite pattern matches a string")
		}
		return { source: `^(?:${spellingsOf(arms, "|")})$`, members }
	}

export const flagsGen: Gen<Flags> = element<Flags>(["u", "su"])

/**
 * The weight of a nested pattern's atom by its depth, as a term's plain option weighs (TERM_FIRST) over options weighing
 * 2 in all; at the last depth a node is an atom.
 */
const NESTED_FIRST = [1, 1, 3] as const

/**
 * Patterns that probe PostgreSQL's regex compile space: counted repetitions nested up to three deep,
 * with counts up to 255, over atoms that are nullable, anchored, alternations with an empty arm, or wide classes. These
 * are the shapes PostgreSQL's NFA optimizer grows on (empty-arc removal, constraint elimination), unlike patternOver,
 * whose star height is one. Most exceed the compiler's budgets; the ones it admits must compile on PostgreSQL.
 */
export const nestedPattern: Gen<string> = (() => {
	const atom = element([
		"a",
		"a?",
		"(?:a|)",
		"^",
		"$",
		"[a-z]",
		".",
		"(?:ab|c)",
		"(?:a|b?)",
		"a*",
		"(?:$|a|)",
		"(?:^|a)",
		"\\d",
		"[^a]",
		"(?:.{1,50}|^)"
	])
	const count = element([1, 2, 3, 8, 16, 50, 100, 200, 255])
	const repetition = oneOf<string>([
		element(["?", "*", "+"]),
		map(count, (n) => `{${n}}`),
		(source) => {
			const n = source.draw(count)
			const f = source.draw(element([0, 0.5, 1]))
			return `{${Math.floor(n * f)},${n}}`
		},
		map(count, (n) => `{${n},}`)
	])
	const node = (depth: number): Gen<string> => {
		const first = NESTED_FIRST[depth]
		if (first === undefined) {
			return atom
		}
		const inner = node(depth + 1)
		return weighted<string>([
			[first, atom],
			[
				1,
				(source) => {
					const parts = source.draw(
						array((s) => [s.draw(inner), s.draw(repetition)] as const, { min: 1, max: 3 })
					)
					const alternate = source.draw(boolean)
					return Arr.join(
						Arr.map(parts, ([body, q]) => `(?:${body})${q}`),
						alternate ? "|" : ""
					)
				}
			]
		])
	}
	return map(node(0), (body) => `${body}b`)
})()

/**
 * A class's body from `from`, just past its opening, to its closing `]`, each escape kept whole, and where the `]` is.
 */
const classBody = (
	chars: ReadonlyArray<string>,
	from: number
): { readonly body: string; readonly close: number } => {
	let body = ""
	let j = from
	while (j < chars.length && chars[j] !== "]") {
		body += chars[j] === "\\" ? `\\${chars[j + 1] ?? ""}` : chars[j]
		j += chars[j] === "\\" ? 2 : 1
	}
	return { body, close: j }
}

/**
 * V8 (14.6, Node 26) computes the complement of a class holding U+10FFFE without U+10FFFF, so `/[^\u{10FFFE}]/u`
 * refuses "\u{10FFFF}", against ECMA-262 (CharacterComplement is every code point outside the set). The oracle
 * therefore spells each negated class `[^X]` as `(?:(?![X])[\0-\u{10FFFF}])`: a negative lookahead over the positive
 * class, then any code point, which is the specification's meaning with no complement computed by the engine.
 */
const withoutComplements = (source: string): string => {
	const chars = Arr.fromIterable(source)
	let out = ""
	let i = 0
	while (i < chars.length) {
		const ch = defined(chars[i], "a character")
		if (ch === "\\") {
			out += ch + (chars[i + 1] ?? "")
			i += 2
		} else if (ch === "[" && chars[i + 1] === "^") {
			const { body, close } = classBody(chars, i + 2)
			/** A body that starts with ^ would negate the positive class again; escaped, it is the literal. */
			const positive = Str.startsWith("^")(body) ? `\\${body}` : body
			out += `(?:(?![${positive}])[\\0-\\u{10FFFF}])`
			i = close + 1
		} else if (ch === "[") {
			/** A positive class is copied whole, so a `[^` inside it is not taken for a negated class. */
			const { body, close } = classBody(chars, i + 1)
			out += `[${body}]`
			i = close + 1
		} else {
			out += ch
			i += 1
		}
	}
	return out
}

/**
 * The development oracle: ECMAScript's own membership test of a pattern, compiled once, on the source with its negated
 * classes spelled without an engine complement. The search is spelled as an anchored match after a lazy prefix, which
 * accepts exactly the strings an unanchored `test` does: V8 in Node 26.11 misses an unanchored match of a class that
 * reaches the supplementary planes followed by `$` under the u flag (`/[\s\S]$/u.test("\u{1F600}")` is false), which
 * a rotating seed of the membership suite found as /[^]$/u refusing U+10FFFF. The flags hold neither g nor y, so a
 * test reads no lastIndex and the one RegExp answers every value alike.
 */
export const jsMatcher = (source: string, flags: Flags): ((value: string) => boolean) => {
	const compiled = regex.as(`^[\\s\\S]*?(?:${withoutComplements(source)})`, flags)
	return (value) => compiled.test(value)
}

/**
 * One code point of a set, from three picks: an interval endpoint half the time, which reaches the edges of ranges,
 * else uniform within the interval.
 */
const codePointOf = (set: CharSet, interval: number, edge: number, within: number): number => {
	const [lo, hi] = defined(set[pickIndex(interval, set.length)], "an interval")
	const side = pickIndex(edge, 4)
	if (side === 0) {
		return lo
	}
	if (side === 1) {
		return hi
	}
	return lo + pickIndex(within, hi - lo + 1)
}

/**
 * One walk over a pattern's host NFA, its choices read from the tape in order (0 once it runs out): the string it
 * accepts, or undefined when it ends stuck outside the accepting state. A walk consumes the whole string from offset 0:
 * a start edge is followed only before the first code point, and after an end edge no code point follows.
 */
export const walk = (
	nfa: Nfa,
	tape: ReadonlyArray<number>,
	maxLength: number
): string | undefined => {
	let consumed = 0
	const next = (): number => tape[consumed++] ?? 0
	const codePoints: Array<number> = []
	let state = nfa.start
	let ended = false
	for (let step = 0; step < 400; step++) {
		if (state === nfa.accept && (pickIndex(next(), 5) < 2 || codePoints.length >= maxLength)) {
			return codePointsText(codePoints)
		}
		const allowed = Arr.filter(
			defined(nfa.edges[state], `the edges of state ${state}`),
			(e) =>
				e.kind === "eps" ||
				e.kind === "end" ||
				(e.kind === "start" && codePoints.length === 0) ||
				(e.kind === "set" && !ended && codePoints.length < maxLength)
		)
		if (allowed.length === 0) {
			return state === nfa.accept ? codePointsText(codePoints) : undefined
		}
		const edge = defined(allowed[pickIndex(next(), allowed.length)], "an edge")
		if (edge.kind === "set") {
			codePoints.push(codePointOf(edge.set, next(), next(), next()))
		}
		if (edge.kind === "end") {
			ended = true
		}
		state = edge.to
	}
	return undefined
}

/** The longest walk a witness takes, in code points. */
export const walkLength = 12

/** The picks a walk of walkLength code points can consume: its 400 steps' edges and code-point picks, cut at 240. */
export const walkTape = 240

/**
 * A walk over a pattern's host NFA, its tape drawn, the picks shrinking toward the first edge: a string in the pattern's
 * own language, or undefined for a walk that got stuck.
 */
export const walkGen = (nfa: Nfa): Gen<string | undefined> =>
	map(array(pickGen, { min: 0, max: walkTape }), (tape) => walk(nfa, tape, walkLength))
