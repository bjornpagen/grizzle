/** What the properties of lowering.test.ts read: its spaces, models and helpers. */

import * as RegexIr from "@bjornpagen/grizzle-text/regex/ir"
import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { everyProperty } from "#compiler/core/canonical.ts"
import { domainDigest } from "#compiler/core/fingerprint.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { RegexCheck } from "#compiler/ir/scalar.ts"
import { createDomain } from "#compiler/physical/ddl/domains.ts"
import { emit, costChosen } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import {
	analyzeText,
	textDomainDefinition,
	type TextRefinement
} from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { refinementBounds } from "#test/support/text.ts"
import {
	families,
	type FiniteLanguage,
	type Flags,
	flagsGen,
	patternOver,
	stringsOver
} from "#test/unit/text/generators.ts"

export const loc = SourceLoc("str.regex", ["Content", "relations", "Article", "fields", "f"])

const hex = (c: number): string => Str.toUpperCase(c.toString(16))

const isAsciiAlnum = (c: number): boolean =>
	(c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

/**
 * The admitted source spelling (scalar/regex/parse.ts) of an ARE the printer (print.ts toAre) wrote, or undefined for any other
 * string: the printer's inverse up to spelling, written here from the printer's documented output, so the language an
 * ARE recognizes can be analyzed again. Every construct the printer emits is respelled into the admitted grammar, which
 * reads it as the same set of code points: `\A` and `\Z` are `^` and `$` (absolute without the `m` flag), and every
 * escaped character, a `\X` of printable ASCII or a fixed-width `\uXXXX` or `\UXXXXXXXX`, is the `\u{H...}` escape of
 * its code point, inside or outside a bracket expression. ASCII letters, digits and space, and the printer's own
 * syntax (`[`, `]`, `-`, `(?:`, `)`, `|` and the quantifiers), pass through. Anything the printer never emits, such as
 * a bare `.`, `^` or `$`, or another escape, leaves the string unread.
 */
export const areSource = (are: string): string | undefined => {
	const syntax = new Set(["[", "]", "-", "(", "?", ":", ")", "|", "*", "+", "{", "}", ","])
	/** The printer's fixed-width uppercase hexadecimal digits at `at`. */
	const fixed = (at: number, width: number): number | undefined => {
		const digits = Str.slice(at, at + width)(are)
		if (digits.length !== width) {
			return undefined
		}
		for (const d of digits) {
			if (!((d >= "0" && d <= "9") || (d >= "A" && d <= "F"))) {
				return undefined
			}
		}
		return Number.parseInt(digits, 16)
	}
	let out = ""
	let i = 0
	for (let at = Str.charCodeAt(are, i); Option.isSome(at); at = Str.charCodeAt(are, i)) {
		const code = at.value
		const c = String.fromCharCode(code)
		if (c !== "\\") {
			if (!(isAsciiAlnum(code) || code === 0x20 || syntax.has(c))) {
				return undefined
			}
			out += c
			i++
			continue
		}
		/** A trailing backslash escapes nothing. */
		const escaped = Str.charCodeAt(are, i + 1)
		if (Option.isNone(escaped)) {
			return undefined
		}
		const next = String.fromCharCode(escaped.value)
		if (next === "A" || next === "Z") {
			out += next === "A" ? "^" : "$"
			i += 2
			continue
		}
		const width = next === "u" ? 4 : next === "U" ? 8 : 0
		if (width > 0) {
			const cp = fixed(i + 2, width)
			if (cp === undefined) {
				return undefined
			}
			out += `\\u{${hex(cp)}}`
			i += 2 + width
			continue
		}
		if (isAsciiAlnum(escaped.value) || escaped.value <= 0x20 || escaped.value >= 0x7f) {
			return undefined
		}
		out += `\\u{${hex(escaped.value)}}`
		i += 2
	}
	return out
}

/**
 * The canonical pattern key of the language a printed ARE recognizes, read back (areSource) and analyzed as a declared
 * pattern would be, or undefined when the string is no such ARE or its language cannot be analyzed within the bounds.
 */
export const areKey = (are: string): string | undefined => {
	const source = areSource(are)
	if (source === undefined) {
		return undefined
	}
	const analyzed = analyzeText([{ source, flags: "su" }], SourceLoc("a printed ARE", []))
	return analyzed.ok ? analyzed.value.key : undefined
}

/** A pattern over any family's alphabet. */
export const familyPattern: Gen<string> = (source) =>
	source.draw(patternOver(source.draw(element(families)).alphabet))

/** Whether a node holds an assertion, `^` or `$`, anywhere. */
const asserts = (node: RegexIr.RegexNode): boolean => {
	switch (node.kind) {
		case "start":
		case "end":
			return true
		case "seq":
			return Arr.some(node.items, asserts)
		case "alt":
			return Arr.some(node.arms, asserts)
		case "repeat":
			return asserts(node.body)
		case "empty":
		case "never":
		case "set":
			return false
	}
}

/** Whether a repetition loops through an assertion: an unbounded repeat whose body can match zero-width through one. */
export const loops = (node: RegexIr.RegexNode): boolean => {
	switch (node.kind) {
		case "seq":
			return Arr.some(node.items, loops)
		case "alt":
			return Arr.some(node.arms, loops)
		case "repeat":
			return (
				(node.max === "unbounded" && asserts(new RegexIr.RegexBuilder().zeroPart(node.body))) ||
				loops(node.body)
			)
		case "empty":
		case "never":
		case "set":
		case "start":
		case "end":
			return false
	}
}

/** A code point of the loops' small alphabet, a class of letters or any code point. */
const loopAtom: Gen<string> = element(["a", "b", "c", "[a-z]", "."])

const loopAnchor: Gen<string> = element(["^", "$"])

/**
 * An item a path may pass without consuming a code point: an anchor, an atom made optional or repeated, or an atom
 * beside the empty arm.
 */
const passable: Gen<string> = oneOf<string>([
	loopAnchor,
	map(loopAtom, (atom) => `${atom}?`),
	map(loopAtom, (atom) => `${atom}*`),
	map(loopAtom, (atom) => `(?:${atom}|)`)
])

/**
 * An arm whose zero-width part asserts: an anchor, bare or beside an atom, among items a path may pass, so the
 * assertion stands alone or beside items that assert nothing (`(?:a|$|)b?`).
 */
const assertingArm: Gen<string> = (source) =>
	Arr.join(
		[
			...source.draw(array(passable, { min: 0, max: 2 })),
			source.draw(
				oneOf<string>([
					loopAnchor,
					(s) => `(?:${s.draw(loopAtom)}|${s.draw(loopAnchor)})`,
					(s) => `(?:${s.draw(loopAnchor)}|${s.draw(loopAtom)}|)`
				])
			),
			...source.draw(array(passable, { min: 0, max: 2 }))
		],
		""
	)

/** A word of one or two atoms. */
const loopWord: Gen<string> = map(array(loopAtom, { min: 1, max: 2 }), (atoms) =>
	Arr.join(atoms, "")
)

/**
 * An atom under three nested counts whose product passes regexMaxHeldArcs, `(?:(?:[a-z]{255}){255}){31}`: an arm whose
 * written-out positions the IR does not write out again, so a loop holding it stays a loop (scalar/regex/ir.ts repeat),
 * which analyzeText refuses (loopsThroughAnchor). The outer count is the least past the bound, and up to three more.
 */
const pastHeldArcs: Gen<string> = (source) => {
	const inner = source.draw(int(128, 255))
	const middle = source.draw(int(128, 255))
	const outer = Math.floor(RegexIr.regexMaxHeldArcs / (inner * middle)) + 1 + source.draw(int(0, 3))
	return `(?:(?:${source.draw(loopAtom)}{${inner}}){${middle}}){${outer}}`
}

/**
 * A repetition that loops through an assertion, the shape the IR rewrites away (scalar/regex/ir.ts repeat): an
 * unbounded group whose arms, in a drawn order, are an asserting arm (assertingArm) and up to two others, a word of
 * atoms, an arm past the held arcs (pastHeldArcs) or, `depth` levels down, such a loop of its own, then an atom after
 * it.
 */
const loopThroughAssertion = (depth: number): Gen<string> => {
	const other: Gen<string> =
		depth === 0
			? oneOf<string>([loopWord, pastHeldArcs])
			: oneOf<string>([loopWord, pastHeldArcs, loopThroughAssertion(depth - 1)])
	return (source) => {
		const arms = [source.draw(assertingArm), ...source.draw(array(other, { min: 0, max: 2 }))]
		const ordered = source.draw(shuffled(arms, { min: arms.length, max: arms.length }))
		return `(?:${Arr.join(ordered, "|")})${source.draw(element(["*", "+", "{0,}", "{2,}"]))}${source.draw(loopAtom)}`
	}
}

/** A repetition that loops through an assertion, holding up to one more such loop in an arm. */
export const assertionLoop: Gen<string> = loopThroughAssertion(1)

/**
 * The compile-space budgets judge the ARE PostgreSQL is sent, whatever the spelling it was printed from: a pattern
 * and its ARE read back are admitted alike, with one ARE, or refused for one reason. Patterns near the budgets are
 * drawn, where a measure that read the spelling would part them.
 */
export type Verdict = "admitted" | "refused at a budget" | "spelled otherwise than its ARE"

/** The UTF-8 bytes of a text: what PostgreSQL measures a statement by. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** The structural domain each form of a case's language is printed as, under one name. */
const formDomain = identity.textDomain(domainDigest({ form: "finite" }, everyProperty))

/** The UTF-8 bytes of the CREATE DOMAIN the compiler installs a check by, as it prints it. */
export const domainBytes = (check: RegexCheck): number =>
	utf8Bytes(
		succeeded(
			emit(
				createDomain(
					textDomainDefinition(check),
					{ schema: "text", name: formDomain.identifier },
					() => identity.domainCheck(formDomain).identifier
				),
				emptyNameMap,
				costChosen
			),
			"a text domain prints"
		).text
	)

/** The two forms that enforce a finite language: the IN list of its members, and the regex of its pattern. */
interface Forms {
	readonly inList: RegexCheck
	readonly regex: RegexCheck
}

export const formsOf = (language: FiniteLanguage, refinement: TextRefinement): Forms => {
	const bounds = defined(
		refinementBounds(refinement),
		`/${refinement.members[0].source}/${refinement.members[0].flags} bounds its finite language`
	)
	return {
		inList: { kind: "finite", members: language.members, bounds },
		regex: { kind: "regex", ares: [refinement.members[0].are], bounds }
	}
}

/**
 * The first run of two letters or more, `^a{k}$`, whose IN list prints as long as its regex: a list of two letters
 * prints shorter than the counted regex, and the list then grows by a byte a letter while the regex grows only with the
 * count's digits, so the two meet. The space draws it where a witness aims at a tie (finiteDraw), since a drawn
 * language rarely prints as long both ways.
 */
const tieFrom = (k: number): FiniteLanguage => {
	const language: FiniteLanguage = { source: `^a{${k}}$`, members: [Str.repeat(k)("a")] }
	const { inList, regex } = formsOf(
		language,
		succeeded(analyzeText([{ source: language.source, flags: "u" }], loc), language.source)
	)
	return domainBytes(inList) < domainBytes(regex) ? tieFrom(k + 1) : language
}

export const tie = tieFrom(2)

/** The quote, which an IN list's literal doubles and the ARE escapes. */
const apostrophe = 0x27

export type FormFeature = "IN list chosen" | "regex chosen" | "tie"

/** A finite language under its flags, and strings over its family's alphabet to match against it. */
interface FiniteCase {
	readonly language: FiniteLanguage
	readonly flags: Flags
	readonly strings: ReadonlyArray<string>
}

/**
 * A finite case whose language `languageOf` draws over its family's alphabet with the quote: its flags and strings over
 * that alphabet.
 */
export const finiteCaseOf =
	(
		languageOf: (alphabet: Arr.NonEmptyReadonlyArray<number>) => Gen<FiniteLanguage>
	): Gen<FiniteCase> =>
	(source) => {
		const family = source.draw(element(families))
		const alphabet: Arr.NonEmptyReadonlyArray<number> = [...family.alphabet, apostrophe]
		return {
			language: source.draw(languageOf(alphabet)),
			flags: source.draw(flagsGen),
			strings: source.draw(array(stringsOver(element(alphabet), 6), { min: 1, max: 24 }))
		}
	}
