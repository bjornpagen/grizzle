/** What the properties of conjunction.test.ts read: its spaces, models and helpers. */

import { has } from "@bjornpagen/grizzle-text/regex/charset"
import type { CanonicalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import type { Inclusion } from "@bjornpagen/grizzle-text/regex/inclusion"
import { buildNfa, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { array, constant, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { regexCheck } from "#compiler/ir/scalar.ts"
import { Logic, Text, Type } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { formSource } from "#compiler/scalar/lexical.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { regexField } from "#compiler/text/field.ts"
import { domainValue, membership, type TextRefinement } from "#compiler/text/refinement.ts"
import { Id } from "#test/support/ids.ts"
import { jsMatcher } from "#test/support/regex.ts"
import {
	finiteLanguageOver,
	flagsGen,
	mostFiniteMembers,
	patternOver,
	walkGen
} from "#test/support/unit/text/generators.ts"
import { upTo } from "#test/support/up-to.ts"

export const loc = SourceLoc("str.and", [])

/**
 * A pattern of a conjunction as a case draws it: a generated one, or a finite language, which bounds what the generated
 * ones, whose anchors fall anywhere among their unbounded quantifiers, rarely bound.
 */
const memberGen =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<PatternSource> =>
	(source) => ({
		source: source.draw(
			weighted<string>([
				[3, patternOver(alphabet)],
				[1, map(finiteLanguageOver(alphabet, mostFiniteMembers), (language) => language.source)]
			])
		),
		flags: source.draw(flagsGen)
	})

/** From `min` to `max` patterns of a conjunction, its members in declared order, at least one. */
export const conjunctionGen =
	(alphabet: Arr.NonEmptyReadonlyArray<number>, min: number, max: number): Gen<Patterns> =>
	(source) => [
		source.draw(memberGen(alphabet)),
		...source.draw(array(memberGen(alphabet), { min: Math.max(0, min - 1), max: max - 1 }))
	]

/**
 * Whether ECMAScript finds every member of a conjunction in a text: the oracle of the conjunction's membership, each
 * member compiled once.
 */
export const jsAll = (patterns: ReadonlyArray<PatternSource>): ((text: string) => boolean) => {
	const matchers = Arr.map(patterns, (p) => jsMatcher(p.source, p.flags))
	return (text) => Arr.every(matchers, (m) => m(text))
}

/** A member's NFA, or none for a member the parser refuses. */
export const nfaOf = (p: PatternSource): Option.Option<Nfa> => {
	const parsed = parsePattern(p.source, p.flags)
	return parsed.ok ? Option.some(buildNfa(parsed.value)) : Option.none()
}

/** Whether a canonical DFA, which reads whole values, accepts `text`: its states walked by `text`'s code points. */
export const dfaAccepts = (dfa: CanonicalDfa, text: string): boolean =>
	Option.exists(
		Arr.reduce(codePoints(text), Arr.head(dfa.states), (state, c) =>
			Option.flatMap(state, (s) =>
				Option.flatMap(
					Arr.findFirst(s.edges, (e) => has(e.set, c)),
					(e) => Arr.get(dfa.states, e.to)
				)
			)
		),
		(s) => s.accept
	)

/** Every text of at most `length` code points of `alphabet`: the empty text, and each code point before a shorter. */
const textsUpTo = (alphabet: ReadonlyArray<number>, length: number): ReadonlyArray<string> =>
	length === 0
		? [""]
		: [
				"",
				...Arr.flatMap(textsUpTo(alphabet, length - 1), (t) =>
					Arr.map(alphabet, (c) => `${codePointsText([c])}${t}`)
				)
			]

/** Every member's walks drawn over its own NFA: texts of each member's language, of the conjunction's or not. */
export const walksOf =
	(patterns: Patterns): Gen<ReadonlyArray<string>> =>
	(source) =>
		Arr.flatMap(patterns, (p) =>
			Option.match(nfaOf(p), {
				onNone: () => [],
				onSome: (nfa) =>
					Arr.flatMap(source.draw(array(walkGen(nfa), { min: 0, max: 8 })), (w) =>
						w === undefined ? [] : [w]
					)
			})
		)

/** The alphabet the language and key search draws its patterns and texts over. */
export const letters: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x63, 0x30, 0x0a]

/** A conjunction's analysis in another order of its members. */
export const reversed = (patterns: Patterns): Patterns => {
	const [first, ...rest] = patterns
	return Arr.isReadonlyArrayNonEmpty(rest) ? [...Arr.reverse(rest), first] : [first]
}

export type LanguageFeature =
	| "a pair"
	| "a triple"
	| "keyed by the intersection's automaton"
	| "keyed by its members past the bounds"
	| "a text the first member holds and the conjunction does not"
	| "a text of the conjunction"
	| "refused as matching no text"
	| "bounded where a member alone is not"

/** The small alphabet whose every short text the inclusion search enumerates. */
const abc: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x63]

/** Every text of up to four code points of the inclusion search's alphabet: 121 texts. */
export const shortTexts = textsUpTo(abc, 4)

/** An inclusion case: an inner conjunction, an outer one, and walks of the inner members. */
export interface InclusionCase {
	readonly inner: Patterns
	readonly outer: Patterns
	readonly walks: ReadonlyArray<string>
}

/** Conjunctions over abc, an inner of one to three members and an outer of one or two, and walks of the inner's. */
export const inclusionCaseGen: Gen<InclusionCase> = (source) => {
	const inner = source.draw(conjunctionGen(abc, 1, 3))
	return {
		inner,
		outer: source.draw(conjunctionGen(abc, 1, 2)),
		walks: source.draw(walksOf(inner))
	}
}

/**
 * An inner pair whose intersection, and neither member alone, lies inside the outer: one letter's texts of any length
 * (`^a*$`) beside every text of at most `k` code points (`^.{0,k}$`), inside that letter's texts of at most `k`, spelled
 * as an optional alternation of each length (`^(?:a|aa)?$`). inclusionCaseGen draws such a pair about once in
 * thousands of cases.
 */
export const includedTogetherGen: Gen<InclusionCase> = (source) => {
	const letter = String.fromCodePoint(source.draw(element(abc)))
	const k = source.draw(int(1, 3))
	const inner: Patterns = [
		{ source: `^${letter}*$`, flags: source.draw(flagsGen) },
		{ source: `^.{0,${k}}$`, flags: source.draw(flagsGen) }
	]
	return {
		inner,
		outer: [
			{
				source: `^(?:${Arr.join(
					upTo(k, (i) => Str.repeat(i + 1)(letter)),
					"|"
				)})?$`,
				flags: source.draw(flagsGen)
			}
		],
		walks: source.draw(walksOf(inner))
	}
}

export type InclusionFeature =
	| "included"
	| "refuted"
	| "bounded"
	| "included by inner members together, by none alone"

/**
 * The digits and signs the guard search draws over: the characters of an integer's lexical form, and two others, so its
 * finite languages often lie inside smallint's form and its generated patterns often reach past it.
 */
const numerals: Arr.NonEmptyReadonlyArray<number> = [0x30, 0x31, 0x39, 0x2d, 0x2e, 0x61]

/** A guard case: a subject's pattern and a match's, each a member of a conjunction over the numerals. */
export interface GuardCase {
	readonly subject: string
	readonly guard: string
}

/** Two patterns over the numerals, the subject's and the guard's. */
export const guardCaseGen: Gen<GuardCase> = (source) => ({
	subject: source.draw(memberGen(numerals)).source,
	guard: source.draw(memberGen(numerals)).source
})

/**
 * A subject of digits of any count, a minus sign before them or not, under a guard of at most four characters: their
 * conjunction lies inside smallint's form where neither alone does (`^[0-9]*$` under `^.{1,4}$`), but for a lone sign.
 * guardCaseGen's two patterns lie inside it together about once in hundreds of cases.
 */
export const digitsUnderLengthGen: Gen<GuardCase> = (source) => ({
	subject: `^${source.draw(element(["", "-?"]))}${source.draw(element(["[0-9]", "\\d", "[019]"]))}${source.draw(element(["*", "+"]))}$`,
	guard: `^.{1,${source.draw(int(1, 4))}}$`
})

/** smallint's lexical form, which a parse in the guard's branch reads its text into. */
export const smallintForm = formSource({ kind: "integer", carrier: "int2" })

/**
 * A relation whose text `t` is typed by `subject`, and a smallint generated from its parse under a match of `guard`:
 * the branch reads `t` as text of both patterns.
 */
export const guardedParse = (subject: string, guard: string) =>
	schema(
		"Guarded",
		[
			relation.generated("R", { id: Id, t: regexField<string>(subject, []) }, ["id"], (r) => ({
				n: generated(
					pg.smallint,
					Logic.when(
						Text.matches(r.t, Text.pattern(guard)),
						(t) => Type.cast(t, pg.smallint),
						Type.literal(pg.smallint, 0)
					)
				)
			}))
		],
		[]
	)

/** What compiling a guarded parse answers: admitted, or refused for a reason. */
export type GuardOutcome =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused"; readonly reason: CompileReasonTag }

/**
 * What compiling the guarded parse answers for each verdict of the conjunction's inclusion in the form: admitted where it
 * lies inside, a missing guard where a value of it lies outside, and the analysis's bounds where they decide nothing.
 */
export const guardOutcome: { readonly [K in Inclusion["kind"]]: GuardOutcome } = {
	included: { kind: "admitted" },
	refuted: { kind: "refused", reason: "PartialOperation" },
	bounded: { kind: "refused", reason: "ResourceBound" }
}

export type GuardFeature =
	| "admitted"
	| "refused"
	| "admitted where neither pattern alone lies inside the form"

/** The bytes a check's predicate over VALUE prints in. */
export const predicateBytes = (r: TextRefinement): number =>
	r.check.kind === "tautology" ? 0 : utf8Length(printExpr(membership(r.check, domainValue)))

/** The bytes each member's own test prints in, `VALUE ~ '<ARE>'`, the test a conjunction's CHECK joins by AND. */
export const memberBytes = (r: TextRefinement): number =>
	Arr.reduce(
		r.members,
		0,
		(n, m) => n + utf8Length(printExpr(membership(regexCheck([m.are], undefined), domainValue)))
	)

/** The bytes AND adds between two tests. */
export const andBytes = utf8Length(" AND ")

/**
 * The endpoints of XML's name ranges, NameStartChar without the colon and NameChar's others (XML 1.0 §2.3, Namespaces
 * in XML §3): the alphabet the size search's wide arm draws over, so its classes span planes as an NCName's do.
 */
const xmlNameEndpoints: Arr.NonEmptyReadonlyArray<number> = [
	0x41, 0x5a, 0x5f, 0x61, 0x7a, 0xc0, 0xd6, 0xd8, 0xf6, 0xf8, 0x2ff, 0x370, 0x37d, 0x37f, 0x1fff,
	0x200c, 0x200d, 0x2070, 0x218f, 0x2c00, 0x2fef, 0x3001, 0xd7ff, 0xf900, 0xfdcf, 0xfdf0, 0xfffd,
	0x10000, 0xeffff, 0x2d, 0x2e, 0x30, 0x39, 0xb7, 0x300, 0x36f, 0x203f, 0x2040
]

/**
 * One to eight patterns of a conjunction over the small alphabet, or over XML's name endpoints, whose classes span the
 * planes as an NCName's do, where an intersection's automaton prints largest.
 */
export const sizeCaseGen: Gen<{ readonly patterns: Patterns }> = (source) => {
	const alphabet = source.draw(
		weighted<Arr.NonEmptyReadonlyArray<number>>([
			[3, constant(letters)],
			[1, constant(xmlNameEndpoints)]
		])
	)
	return { patterns: source.draw(conjunctionGen(alphabet, 1, source.draw(int(1, 8)))) }
}

export type SizeFeature =
	| "a regex check of several patterns"
	| "an IN list"
	| "more than four patterns"
