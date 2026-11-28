/** What the properties of translate.test.ts read: its spaces, models and helpers. */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { codePoints, codePointsText, collapsed } from "@bjornpagen/grizzle-text/text"
import { assert, assertNot, defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	proportional,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { compiledExpr, sqlNull, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { HostValue } from "#compiler/scalar/values/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { type LeafBinding, testPg } from "#test/support/unit/compute/support.ts"
import {
	families,
	type FiniteLanguage,
	finiteLanguageOver,
	type Flags,
	patternOver,
	stringsOver
} from "#test/support/unit/text/generators.ts"

export const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }

export const variable = (name: string): ExprDesc => ({ kind: "var", var: name })

export const text = (value: string): ExprDesc => ({ kind: "literal", value })

export const collapsing = (subject: ExprDesc): ExprDesc => ({
	kind: "compute",
	fn: "collapse",
	args: [subject]
})

export const translation = (subject: ExprDesc, from: ExprDesc, to: ExprDesc): ExprDesc => ({
	kind: "compute",
	fn: "translate",
	args: [subject, from, to]
})

/** A lowered term's value over a row, on the host and by the reference evaluator. */
export const values = (
	root: ScalarExpr,
	row: ReadonlyMap<string, string>
): { readonly host: HostValue; readonly reference: ModelValue } => {
	const table = predicateTable(root)
	const host = succeeded(
		Engine.mapError(
			compiledExpr(table)(
				{
					value: undefined,
					column: (ref) => row.get(ref.name),
					closed: () => undefined,
					param: noParamLeaf
				},
				ProgramPatterns.of(tablePatterns(table))
			),
			(stop) => new Error(Formatter.format(stop))
		),
		"the host evaluates it"
	)
	assertNot(host, sqlNull, "the host's value is a value, no operand being NULL")
	const reference = evaluate(root, {
		kind: "row",
		column: (ref) => row.get(ref.name),
		param: () => undefined,
		regexMember: patternMember
	})
	if (reference._tag !== "Success") {
		return assert.fail(`the reference evaluates it: ${Formatter.format(reference.failure)}`)
	}
	return { host, reference: reference.success }
}

/** The map applied by hand: each character of from, by its position, to to's; every other character itself. */
export const mapped = (
	value: string,
	from: ReadonlyArray<number>,
	to: ReadonlyArray<number>
): string =>
	codePointsText(
		Arr.map(codePoints(value), (c) => {
			const at = from.indexOf(c)
			return at < 0 ? c : defined(to[at])
		})
	)

/** A map over an alphabet: from distinct code points, to any of the alphabet's, position for position. */
interface MapCase {
	readonly from: ReadonlyArray<number>
	readonly to: ReadonlyArray<number>
}

const mapOver =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<MapCase> =>
	(source) => {
		const from = Arr.dedupe(source.draw(array(element(alphabet), { min: 0, max: 4 })))
		const to = Arr.map(from, () => source.draw(element(alphabet)))
		return { from, to }
	}

/**
 * Tab, LF and CR beside the space they become in xs:normalizedString, the ASCII letters lowerAscii's edges are, their
 * neighbours @, [, ` and {, Latin-1 capital and small E acute, which lowerAscii keeps, and BMP's last and a
 * supplementary code point, where UTF-16 and code points part.
 */
const translationAlphabet: Arr.NonEmptyReadonlyArray<number> = [
	0x09, 0x0a, 0x0d, 0x20, 0x40, 0x41, 0x42, 0x5a, 0x5b, 0x60, 0x61, 0x7a, 0x7b, 0xc9, 0xe9, 0xffff,
	0x1f600
]

interface TranslationCase {
	readonly map: MapCase
	readonly texts: ReadonlyArray<string>
}

export type TranslationFeature =
	| "a character replaced"
	| "a character kept"
	| "a supplementary character replaced"
	| "a capital lowered"
	| "a non-ASCII letter kept"

export const translationCase: Gen<TranslationCase> = (source) => ({
	map: source.draw(mapOver(translationAlphabet)),
	texts: source.draw(array(stringsOver(element(translationAlphabet), 8), { min: 1, max: 16 }))
})

/** The ASCII capitals, which lowerAscii lowers, and nothing else. */
export const isAsciiCapital = (c: number): boolean => c >= 0x41 && c <= 0x5a

/** One case of the image search: a family, its pattern and flags, a map over its alphabet, and the texts probed. */
interface ImageCase {
	readonly family: number
	readonly source: string
	readonly flags: Flags
	readonly map: MapCase
	readonly texts: ReadonlyArray<string>
}

export type ImageFeature =
	| "an image member"
	| "a non-member"
	| "a member through a moved character"
	| "a match of the operand outside the image"
	| "a bounded operand"
	| "a wildcard operand"
	| "an exact image past the measures"

/**
 * A code point and a chain of plain code points at the edge of the depth grizzle holds a pattern to (
 * regexMaxDepth): the pattern and its own image fit the measure for every last run up to 196, and the exact image,
 * eight arcs deeper for the prefix and the suffix of any text it writes out around a pattern unanchored at either
 * end, passes it from a last run of 189. Each such case compiles a pattern of some 16,000 positions, so the arm is
 * drawn rarely.
 */
const deep =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<readonly [string, Flags]> =>
	(s) => [
		`\\u{${s.draw(element(alphabet)).toString(16)}}(?:a{255}){61}b{${s.draw(int(189, 196))}}`,
		"u"
	]

export const imageCase: Gen<ImageCase> = (source) => {
	const family = source.draw(int(0, families.length - 1))
	const f = defined(families[family], "a family")
	const declared: Gen<readonly [string, Flags]> = weighted([
		[4, element(Arr.isReadonlyArrayNonEmpty(f.patterns) ? f.patterns : [["^$", "u"] as const])],
		[8, map(patternOver(f.alphabet), (p): readonly [string, Flags] => [p, "u"])],
		[4, (s): readonly [string, Flags] => ["^.*$", s.draw(boolean) ? "su" : "u"]],
		[1, deep(f.alphabet)]
	])
	const [pattern, flags] = source.draw(declared)
	return {
		family,
		source: pattern,
		flags,
		map: source.draw(mapOver(f.alphabet)),
		texts: source.draw(array(stringsOver(element(f.alphabet), 5), { min: 1, max: 12 }))
	}
}

/**
 * Every text the map takes to `value`: at each character, the character itself where the map does not move it, and
 * each character of from the map takes to it.
 */
export const preimages = (value: string, c: MapCase): ReadonlyArray<string> =>
	Arr.reduce(codePoints(value), [""], (prefixes: ReadonlyArray<string>, cp) => {
		const own = c.from.includes(cp) ? [] : [String.fromCodePoint(cp)]
		const moved = Arr.flatMap(c.from, (f, i) => (c.to[i] === cp ? [String.fromCodePoint(f)] : []))
		return Arr.flatMap(prefixes, (p) => Arr.map([...own, ...moved], (x) => `${p}${x}`))
	})

/** A fault planted in a valid translation or collapse, one for each refusal of the two. */
export type Fault =
	| "a to shorter than from"
	| "a to longer than from"
	| "a repeated character of from"
	| "a character no text holds"
	| "a term as from"
	| "a term as to"
	| "a subject that is no text"
	| "an unbounded subject in a query"
	| "a map of two lengths at the builder"
	| "a repeated character at the builder"
	| "a term as from at the builder"
	| "a subject that is no text at the builder"

export const faults: Arr.NonEmptyReadonlyArray<Fault> = [
	"a to shorter than from",
	"a to longer than from",
	"a repeated character of from",
	"a character no text holds",
	"a term as from",
	"a term as to",
	"a subject that is no text",
	"an unbounded subject in a query",
	"a map of two lengths at the builder",
	"a repeated character at the builder",
	"a term as from at the builder",
	"a subject that is no text at the builder"
]

/**
 * The faults only a translation meets: its map's, and a subject unbounded in a query, which a collapse reads by
 * replace alone.
 */
const translateFaults: ReadonlySet<Fault> = new Set<Fault>([
	"an unbounded subject in a query",
	"a to shorter than from",
	"a to longer than from",
	"a repeated character of from",
	"a character no text holds",
	"a term as from",
	"a term as to",
	"a map of two lengths at the builder",
	"a repeated character at the builder",
	"a term as from at the builder"
])

/**
 * A valid term and the fault planted in it: a translation by a map Text.translate admits, or a collapse, lowered as
 * a check or a query, and two code points a fault is built from beside a code point no text holds, NUL or a lone
 * surrogate.
 */
interface Planted {
	readonly fault: Fault
	readonly term: "translate" | "collapse"
	readonly mode: "check" | "query"
	readonly map: MapCase
	readonly point: number
	readonly other: number
	readonly unheld: number
}

export const plantedGen: Gen<Planted> = (source) => {
	const fault = source.draw(element(faults))
	return {
		fault,
		term: translateFaults.has(fault)
			? "translate"
			: source.draw(element(["translate", "collapse"] as const)),
		mode: source.draw(element(["check", "query"] as const)),
		map: source.draw(mapOver(translationAlphabet)),
		point: source.draw(element(translationAlphabet)),
		other: source.draw(element(translationAlphabet)),
		unheld: source.draw(element([0x0, 0xd800, 0xdfff]))
	}
}

export const vars: Readonly<Record<string, LeafBinding>> = {
	v: textColumn,
	w: textColumn,
	b: {
		kind: "column",
		type: testPg.regex("^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$", "u").scalar
	},
	n: { kind: "column", type: testPg.integer.scalar }
}

/**
 * The operand of a cast: the image of a finite language under a drawn map (its members mapped, which its exact image
 * type holds and nothing else), a collapse of a finite language or of any text, any text, or a language whose own
 * automaton passes the analysis bounds, `^[xy]*x[xy]{n}$`, x and y two code points.
 */
type Operand =
	| {
			readonly kind: "a translated language"
			readonly language: FiniteLanguage
			readonly map: MapCase
	  }
	| { readonly kind: "a collapsed language"; readonly language: FiniteLanguage }
	| { readonly kind: "a collapse of any text" }
	| { readonly kind: "any text" }
	| {
			readonly kind: "a language past the bounds"
			readonly x: number
			readonly y: number
			readonly count: number
	  }

/**
 * What it is cast to: a text type, a contract over one whose predicate bounds the length below the image's longest
 * member, so nothing proves it, the collapsed texts, every text with no tab, LF or CR and a space only between two
 * other characters, or a numeric, whose lexical form the operand is parsed into.
 */
type Target =
	| { readonly kind: "a text type"; readonly source: string }
	| {
			readonly kind: "a contract over a text type"
			readonly source: string
			readonly below: number
	  }
	| { readonly kind: "the collapsed texts" }
	| { readonly kind: "a numeric"; readonly precision: number; readonly scale: number }

/** The members of an operand's image, where a finite language's image has them. */
export const imageMembers = (operand: Operand): ReadonlyArray<string> | undefined => {
	switch (operand.kind) {
		case "a translated language":
			return Arr.map(operand.language.members, (m) => mapped(m, operand.map.from, operand.map.to))
		case "a collapsed language":
			return Arr.map(operand.language.members, collapsed)
		case "a collapse of any text":
		case "any text":
		case "a language past the bounds":
			return undefined
	}
}

/** A code point as its braced escape, which means itself inside a class and out. */
export const escapedPoint = (c: number): string => `\\u{${c.toString(16)}}`

/** A text as the alternation arm that spells it, each code point its braced escape. */
const spelled = (value: string): string => Arr.join(Arr.map(codePoints(value), escapedPoint), "")

/**
 * A text type a drawn image is or is not inside: every text over its code points, or exactly its members, each with
 * one of them dropped half the time and more of the alphabet's added.
 */
const textTarget =
	(image: ReadonlyArray<string>): Gen<string> =>
	(source) => {
		const drop = source.draw(boolean)
		if (source.draw(boolean)) {
			const points = Arr.dedupe(Arr.flatMap(image, codePoints))
			const kept = drop ? points.slice(1) : points
			const more = source.draw(array(element(translationAlphabet), { min: 0, max: 3 }))
			return `^[${Arr.join(Arr.map([...kept, ...more], escapedPoint), "")}]*$`
		}
		const members = Arr.dedupe(image)
		const kept = drop ? members.slice(1) : members
		const more = source.draw(
			array(stringsOver(element(translationAlphabet), 3), { min: 0, max: 3 })
		)
		return `^(?:${Arr.join(Arr.map([...kept, ...more], spelled), "|")})$`
	}

/**
 * The collapsed texts, every text with no tab, LF or CR and a space only between two other characters, the collapse of
 * any text a member; within `length` characters where a bound is given, which the collapse of a text that long keeps.
 */
export const collapsedTexts = (length: number | undefined): string =>
	length === undefined
		? "^(?:[^ \\t\\n\\r]+(?: [^ \\t\\n\\r]+)*)?$"
		: length === 0
			? "^$"
			: length === 1
				? "^[^ \\t\\n\\r]?$"
				: `^(?:[^ \\t\\n\\r](?:[^\\t\\n\\r]{0,${length - 2}}[^ \\t\\n\\r])?)?$`

/** The longest member of a finite language, in code points. */
export const longestOf = (members: ReadonlyArray<string>): number =>
	Arr.reduce(members, 0, (most, m) => Math.max(most, codePoints(m).length))

/**
 * The most members a cast's finite language holds: a search budget, no claim. A target is spelled from the image's
 * members, so a larger language mostly passes the analysis bounds, where the property sees only the refusal that
 * names them, and a case past it costs much and judges little.
 */
const castMembers = 64

export const castGen: Gen<readonly [Operand, Target]> = (source) => {
	const language = source.draw(finiteLanguageOver(translationAlphabet, castMembers))
	const operand = source.draw(
		weighted<Operand>([
			[
				4,
				(s) => ({
					kind: "a translated language",
					language,
					map: s.draw(mapOver(translationAlphabet))
				})
			],
			[2, () => ({ kind: "a collapsed language", language })],
			[1, () => ({ kind: "a collapse of any text" })],
			[1, () => ({ kind: "any text" })],
			[
				1,
				(s) => {
					const [x, y] = s.draw(shuffled(translationAlphabet, { min: 2, max: 2 }))
					return {
						kind: "a language past the bounds",
						x: defined(x, "a first code point"),
						y: defined(y, "a second code point"),
						count: s.draw(int(11, 13))
					}
				}
			]
		])
	)
	const image = imageMembers(operand) ?? language.members
	const longest = longestOf(image)
	const target = source.draw(
		weighted<Target>([
			[4, (s) => ({ kind: "a text type", source: s.draw(textTarget(image)) })],
			[
				1,
				(s) => ({
					kind: "a contract over a text type",
					source: s.draw(textTarget(image)),
					below: longest - 1
				})
			],
			[1, () => ({ kind: "the collapsed texts" })],
			[1, (s) => ({ kind: "a numeric", precision: s.draw(int(20, 60)), scale: s.draw(int(0, 10)) })]
		])
	)
	return [operand, target] as const
}

export type TranslatedInclusion =
	| "an image inside the target"
	| "an image outside the target"
	| "a contract's predicate unproved"
	| "any text outside the target"
	| "a collapse inside the collapsed texts"
	| "a refinement past the analysis bounds"
	| "a parse past the analysis bounds"

/** XML's four white space characters beside no-break space and line separator, which XML does not count, and letters. */
const spaceAlphabet: Arr.NonEmptyReadonlyArray<number> = [
	0x09, 0x0a, 0x0d, 0x20, 0x61, 0x62, 0xa0, 0x2028, 0xe9, 0x1f600
]

/** A character of the alphabet, the space twice as often as each other one. */
export const spaceCharacter: Gen<number> = proportional(
	Arr.map(spaceAlphabet, (point) => [point === 0x20 ? 2 : 1, constant(point)] as const)
)

/** XML Schema's collapse as its definition reads: pieces cut at every run of white space, the empty ones dropped. */
export const byDefinition = (value: string): string =>
	Arr.join(
		Arr.filter(
			Arr.reduce(codePoints(value), [""], (pieces: ReadonlyArray<string>, c) =>
				isXmlSpace(c)
					? [...pieces, ""]
					: [...pieces.slice(0, -1), `${pieces.at(-1) ?? ""}${String.fromCodePoint(c)}`]
			),
			(piece) => piece.length > 0
		),
		" "
	)

export const isXmlSpace = (c: number): boolean =>
	c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20

export type CollapseFeature =
	| "a run folded"
	| "an end trimmed"
	| "a no-break space kept"
	| "a character replaced"

/** One case of the collapse image: a pattern over an alphabet dense in white space, and the texts probed. */
interface CollapseCase {
	readonly source: string
	readonly flags: Flags
	readonly texts: ReadonlyArray<string>
}

export type CollapseImageFeature =
	| "an image member"
	| "an image non-member"
	| "an exact image"
	| "a bounded image"
	| "an image with no white space"

export const collapseCase: Gen<CollapseCase> = (source) => {
	const declared: Gen<readonly [string, Flags]> = weighted([
		[4, map(patternOver(spaceAlphabet), (p): readonly [string, Flags] => [p, "u"])],
		[1, (s): readonly [string, Flags] => ["^.*$", s.draw(boolean) ? "su" : "u"]],
		[1, (s): readonly [string, Flags] => [`^.{0,${s.draw(int(0, 12))}}$`, "su"]],
		[
			1,
			element([
				["^[ab]{1,6}$", "u"],
				["^[ \\ta]*$", "u"],
				["^ *$", "u"]
			] as const)
		]
	])
	const [pattern, flags] = source.draw(declared)
	return {
		source: pattern,
		flags,
		texts: source.draw(array(stringsOver(spaceCharacter, 8), { min: 1, max: 16 }))
	}
}
