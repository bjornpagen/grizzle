/** What within.test.ts reads: its alphabets, its pattern spaces, its brute force and each judgment under test. */

import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { utf8Classes } from "@bjornpagen/grizzle-text/regex/charset"
import { type CanonicalDfa, intersectionDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import { type Inclusion, included } from "@bjornpagen/grizzle-text/regex/inclusion"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { type Exceeds, exceedsBytes, includedWithin } from "@bjornpagen/grizzle-text/regex/within"
import { codePointsText } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { array, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type Judgment, languageIncludes } from "#compiler/scalar/regex/inclusion.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { conjunctionGen, jsAll, walksOf } from "#test/unit/text/conjunction.fixtures.ts"

/**
 * The alphabet the searches draw over: two letters and a digit of one UTF-8 byte, and one character of two, of three
 * and of four bytes, so a byte bound cuts a language unlike a count of characters.
 */
const alphabet: NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x30, 0xe9, 0x20ac, 0x1f600]

/** The pattern table every judgment reads its canonical DFAs from (scalar/regex/patterns.ts CompilePatterns). */
const patterns = new CompilePatterns()

/** A pattern's canonical DFA, or none past the analysis's bounds or for a pattern the grammar refuses. */
const dfaOf = (p: PatternSource): CanonicalDfa | undefined => {
	const outcome = patterns.minimal(p)
	return outcome.kind === "minimal" ? outcome.dfa : undefined
}

/** A conjunction's canonical DFA, its members' intersection, or none past the bounds. */
const conjunctionOf = (ps: Patterns): CanonicalDfa | undefined => {
	const dfas = Arr.map(ps, dfaOf)
	const known = Arr.filter(dfas, (d) => d !== undefined)
	if (known.length !== dfas.length || !isNonEmpty(known)) {
		return undefined
	}
	const product = intersectionDfa(known, regexDfaLimits)
	return product.kind === "minimal" ? product.dfa : undefined
}

/**
 * The canonical DFA of every text of at most `octets` UTF-8 bytes: a state for each count of bytes read, each accepting,
 * a code point of w bytes moving the count by w. The second implementation exceedsBytes is held to: a language holds a
 * member past the bound exactly where its inclusion in this one is refuted (inclusion.ts included).
 */
const bytesDfa = (octets: number): CanonicalDfa => ({
	states: Array.from({ length: octets + 1 }, (_, k) => ({
		accept: true,
		edges: Arr.flatMap(utf8Classes, ({ width, set }) =>
			k + width <= octets ? [{ set, to: k + width }] : []
		)
	}))
})

/** Every text over `alphabet` of at most `octets` UTF-8 bytes: the empty text, and each code point before a shorter. */
const textsWithin = (octets: number): ReadonlyArray<string> =>
	octets < 0
		? []
		: [
				"",
				...Arr.flatMap(alphabet, (c) => {
					const head = codePointsText([c])
					return Arr.map(textsWithin(octets - utf8Length(head)), (t) => `${head}${t}`)
				})
			]

/** A case of the bounded inclusion: an inner conjunction within a byte bound, an outer pattern, and walks of the inner. */
export interface WithinCase {
	readonly inner: Patterns
	readonly octets: number
	readonly outer: PatternSource
	readonly walks: ReadonlyArray<string>
}

export const withinCaseGen: Gen<WithinCase> = (source) => {
	const inner = source.draw(conjunctionGen(alphabet, 1, 2))
	const [outer] = source.draw(conjunctionGen(alphabet, 1, 1))
	return {
		inner,
		octets: source.draw(int(0, 7)),
		outer,
		walks: source.draw(walksOf(inner))
	}
}

export type WithinFeature = "included" | "refuted" | "cut by the bound"

/** The verdict of a bounded inclusion case (regex/within.ts includedWithin), none where a DFA passes the bounds. */
export const withinVerdict = (c: WithinCase): Inclusion => {
	const inner = conjunctionOf(c.inner)
	const outer = dfaOf(c.outer)
	return inner === undefined || outer === undefined
		? { kind: "bounded" }
		: includedWithin(inner, c.octets, outer, regexDfaLimits)
}

/**
 * The texts a case's verdict of inclusion is held to: every text over the alphabet within the bound, and every walk of
 * an inner member within it, each a member of the inner conjunction that ECMAScript finds outside the outer pattern.
 */
export const outsideWithin = (c: WithinCase): ReadonlyArray<string> => {
	const inner = jsAll(c.inner)
	const outer = jsMatcher(c.outer.source, c.outer.flags)
	return Arr.filter(
		[...textsWithin(c.octets), ...c.walks],
		(t) => utf8Length(t) <= c.octets && inner(t) && !outer(t)
	)
}

/** Whether a refutation's witness is a member of the inner conjunction within the bound that the outer pattern misses. */
export const witnessHolds = (c: WithinCase, witness: string): boolean =>
	utf8Length(witness) <= c.octets &&
	jsAll(c.inner)(witness) &&
	!jsMatcher(c.outer.source, c.outer.flags)(witness)

/** Whether the inclusion within the bound differs from the inclusion of the languages alone (inclusion.ts included). */
export const cutByBound = (c: WithinCase): boolean => {
	const inner = conjunctionOf(c.inner)
	const outer = dfaOf(c.outer)
	return (
		inner !== undefined &&
		outer !== undefined &&
		included(inner, outer, regexDfaLimits).kind === "refuted" &&
		includedWithin(inner, c.octets, outer, regexDfaLimits).kind === "included"
	)
}

/** A case of the byte excess: a conjunction and a byte bound. */
export interface ExceedsCase {
	readonly language: Patterns
	readonly octets: number
}

export const exceedsCaseGen: Gen<ExceedsCase> = (source) => ({
	language: source.draw(conjunctionGen(alphabet, 1, 2)),
	octets: source.draw(int(0, 12))
})

export type ExceedsFeature = "exceeds" | "within"

/**
 * A case's verdict (regex/within.ts exceedsBytes) beside the second implementation's: the conjunction's inclusion in
 * every text of at most `octets` bytes (bytesDfa), refuted by a member past the bound; none where a DFA passes the
 * bounds.
 */
export const exceedsVerdicts = (
	c: ExceedsCase
): Option.Option<{ readonly verdict: Exceeds; readonly reference: Inclusion }> => {
	const dfa = conjunctionOf(c.language)
	return dfa === undefined
		? Option.none()
		: Option.some({
				verdict: exceedsBytes(dfa, c.octets, regexDfaLimits),
				reference: included(dfa, bytesDfa(c.octets), regexDfaLimits)
			})
}

/**
 * A pattern of the exhaustive space: a whole value of the alphabet's characters alone, `^(?:…)$`, its sequences of
 * literals and classes of the alphabet each optionally quantified, so its every member is a text over the alphabet and
 * a bounded one's members are every text the brute force enumerates within the bound.
 */
const closedPattern: Gen<PatternSource> = (source) => {
	const char = (c: number): string => codePointsText([c])
	const atom = weighted<string>([
		[3, (s) => char(s.draw(element(alphabet)))],
		[
			1,
			(s) =>
				`[${Arr.join(Arr.map(s.draw(array(element(alphabet), { min: 1, max: 3 })), char), "")}]`
		]
	])
	const quantifier = weighted<string>([
		[2, constant("")],
		[1, constant("?")],
		[1, constant("*")],
		[1, constant("+")],
		[1, constant("{0,2}")],
		[1, constant("{1,3}")]
	])
	const sequence = (s: Parameters<Gen<string>>[0]): string =>
		Arr.join(s.draw(array((t) => `${t.draw(atom)}${t.draw(quantifier)}`, { min: 1, max: 4 })), "")
	return {
		source: `^(?:${Arr.join(source.draw(array(sequence, { min: 1, max: 2 })), "|")})$`,
		flags: source.draw(element(["u", "su"] as const))
	}
}

/** A case of the text guarantee: a bounded inner language and an outer one, each a conjunction of the exhaustive space. */
export interface GuaranteeCase {
	readonly inner: Patterns
	readonly innerOctets: number
	readonly outer: Patterns
	readonly outerOctets: number | undefined
}

export const guaranteeCaseGen: Gen<GuaranteeCase> = (source) => ({
	inner: [source.draw(closedPattern), ...source.draw(array(closedPattern, { min: 0, max: 1 }))],
	innerOctets: source.draw(int(0, 7)),
	outer: [source.draw(closedPattern), ...source.draw(array(closedPattern, { min: 0, max: 1 }))],
	outerOctets: source.draw(
		weighted<number | undefined>([
			[1, () => undefined],
			[3, int(0, 9)]
		])
	)
})

export type GuaranteeFeature = "guaranteed" | "not guaranteed" | "refuted by the bytes alone"

/** The judgment of a guarantee case (scalar/regex/inclusion.ts languageIncludes), or none past the bounds. */
export const guaranteeVerdict = (c: GuaranteeCase): Judgment =>
	languageIncludes(
		{ patterns: c.inner, octets: c.innerOctets },
		{ patterns: c.outer, octets: c.outerOctets },
		patterns
	)

/**
 * The brute force a guarantee case is held to, in both directions: every value of the inner type is a text over the
 * alphabet within its bound, every one of which the enumeration holds, so the inner type guarantees the outer exactly
 * where every such text ECMAScript finds in the inner language it finds in the outer, within the outer bound.
 */
export const guaranteeTruth = (
	c: GuaranteeCase
): { readonly holds: boolean; readonly bytes: boolean } => {
	const inner = jsAll(c.inner)
	const outer = jsAll(c.outer)
	const values = Arr.filter(textsWithin(c.innerOctets), inner)
	const language = Arr.every(values, outer)
	const bytes = Arr.every(
		values,
		(t) => c.outerOctets === undefined || utf8Length(t) <= c.outerOctets
	)
	return { holds: language && bytes, bytes }
}

/** The text types a cast reads between: a learner's id and a person's, a state and a slug, each held by a relation. */
const castTypes = {
	learner: str.bytes(69, str.regex("^.+$", "su")),
	person: str.bytes(1020, str.regex("^.{1,255}$", "su")),
	state: str.regex("^(?:draft|published)$"),
	slug: str.regex("^[a-z][a-z0-9-]*$")
} as const

export type CastType = keyof typeof castTypes

const castHolders = {
	learner: relation("CastLearner", { n: pg.bigint, x: castTypes.learner }, ["n"]),
	person: relation("CastPerson", { n: pg.bigint, x: castTypes.person }, ["n"]),
	state: relation("CastState", { n: pg.bigint, x: castTypes.state }, ["n"]),
	slug: relation("CastSlug", { n: pg.bigint, x: castTypes.slug }, ["n"])
} as const

const Casts = schema(
	"WithinCasts",
	[castHolders.learner, castHolders.person, castHolders.state, castHolders.slug],
	[]
)

/** A cast of one held text into another type, and whether every value of the first is a value of the second. */
export interface CastCase {
	readonly from: CastType
	readonly to: CastType
	readonly holds: boolean
}

export const castCaseGen: Gen<CastCase> = element<CastCase>([
	{ from: "learner", to: "person", holds: true },
	{ from: "person", to: "learner", holds: false },
	{ from: "state", to: "slug", holds: true },
	{ from: "slug", to: "state", holds: false }
])

export type CastFeature = "proved" | "refused"

/** Whether a read casting the case's held text into its target type compiles: the cast proved total, or refused. */
export const castCompiles = (c: CastCase): boolean => {
	const read = query(Casts).rule((r) => {
		const { x } = v(castHolders[c.from], "held")
		return r
			.match(castHolders[c.from], { n: r.param("n", pg.bigint), x })
			.find({ cast: Type.cast(x, castTypes[c.to]) })
	})
	return compileTemplate(read, undefined, testCompile).ok
}
