import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg, uuid } from "#compiler/public/fields.ts"
import { type AnyRelation, relation, schema } from "#compiler/public/schema.ts"
import { toFloat } from "#compiler/scalar/compute/cast.ts"
import { formSource, type LexicalTarget, lexicalValue } from "#compiler/scalar/lexical.ts"
import { inclusion } from "#compiler/scalar/regex/inclusion.ts"
import { buildNfa, matches, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { regexField } from "#compiler/text/field.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	candidateGen,
	dateDays,
	type Shape,
	sameValue,
	shapes,
	targetGen
} from "#test/support/lexical.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedIn } from "#test/support/policy.ts"
import { patternOver, walkGen } from "#test/unit/text/generators.ts"

/**
 * The lexical forms of scalar/lexical.ts, each held to three oracles:
 *
 * - **its second definition:** every form is a pattern (formSource), which str.regex, Compute.matches and the inclusion
 *   proof read, and a scan (lexicalValue), which the host evaluator reads; the host NFA's membership of a text in the
 *   pattern (scalar/regex/nfa.ts) must be exactly the scan's;
 * - **the specification as a checker:** each candidate is built from the parts XML Schema's lexical space spells
 *   (sign, digits either side of a point, exponent; year, month, day), and whether it is a member, and the value it
 *   names, follow from those parts alone: an integer in its carrier's range; a decimal's significant digits against
 *   the typmod; a double's value as ECMAScript's StringToNumber reads it, correctly rounded for the at most 20
 *   significant digits a candidate has; a date's validity and day number as the proleptic Gregorian calendar of
 *   ECMAScript's Date gives them;
 * - **the inclusion walk's own refutation:** a pattern pair the walk calls included admits no walk of the inner
 *   pattern's NFA outside the outer's language, and a refuted pair's witness is a member of the inner and not of the
 *   outer, both judged by the host NFA, an implementation apart from the canonical DFAs the walk reads.
 *
 * Candidates are members by construction, near every boundary a form draws (the carriers' ranges, the typmod's
 * digits, the exponent bound, leap days, year 0000 and 10000), and named corruptions of them.
 */
const nfaOf = (source: string): Nfa => buildNfa(succeeded(parsePattern(source, "u")))

const roundDouble = (negative: boolean, num: bigint, den: bigint): number =>
	toFloat(negative, num, den, "float8")

/** The greatest precision of the numeric targets whose forms the text analysis is held to admit. */
const admittedMaxPrecision = 12

describe("lexical forms", () => {
	it.effect(
		"each form's pattern and its scan agree on every candidate, and a member names XML Schema's value",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/lexical-forms",
						draw: drawn(candidateGen),
						literal: Formatter.format,
						coverage: required<Shape>(shapes, { cases: 4000, sense: notesOnly }),
						kept: [],
						runs: 4000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "XML Schema's lexical spaces built from their parts, against the form's pattern and its scan"
						}
					},
					(c, run) =>
						Effect.sync(() => {
							run.note(c.shape)
							const label = `${Formatter.format(c.target)} ${Formatter.format(c.text)}`
							const scanned = lexicalValue(c.target, c.text, roundDouble)
							assert.equal(
								matches(nfaOf(formSource(c.target)), c.text),
								c.member,
								`${label}: pattern`
							)
							assert.equal(scanned !== undefined, c.member, `${label}: scan`)
							if (c.member) {
								assert.ok(
									sameValue(scanned, c.value),
									`${label}: value ${Formatter.format(scanned)}`
								)
							}
							if (c.target.kind === "date" && c.member) {
								const [y, m, d] = Arr.map(Str.split("-")(c.text), Number)
								assert.equal(
									dayNumber(succeeded(toCalendarDate(c.text))),
									dateDays(defined(y, "year"), defined(m, "month"), defined(d, "day")),
									`${label}: day number`
								)
							}
						})
				)
			)
	)

	it.effect(
		"is admitted by the text analysis as a refinement str.regex types a field by, for every typmod in a box",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/scalar/lexical-admitted",
						generator: targetGen(admittedMaxPrecision),
						literal: Formatter.format,
						limit: 200,
						coverage: requiredInSpace<LexicalTarget["kind"]>([
							"integer",
							"decimal",
							"double",
							"boolean",
							"date"
						]),
						caseHang,
						box: "every integer carrier, numeric(p, s) for p from 1 to 12 and s from 0 to p, and every other kind",
						oracle: {
							kind: "specification",
							name: "the text analysis's admission (text/refinement.ts)"
						}
					},
					(t, c) =>
						Effect.sync(() => {
							c.note(t.kind)
							const analyzed = analyzeText(formSource(t), "u", SourceLoc("lexicalForm", []))
							assert.equal(
								analyzed.ok ? analyzed.value.check.kind : "refused",
								"regex",
								`${Formatter.format(t)}'s form is an admitted refinement`
							)
						})
				)
			)
	)
})

/** What a pair of patterns came to under the walk, the features of the inclusion suite. */
type InclusionFeature = "included" | "refuted" | "bounded"

/**
 * A pattern pair over one small alphabet, the characters of the forms' numerals, and walks of the inner pattern's NFA;
 * one pair in two puts a lexical form outside.
 */
const alphabet: Arr.NonEmptyReadonlyArray<number> = [0x30, 0x31, 0x39, 0x2d, 0x2e, 0x65]

const pairGen: Gen<{ readonly inner: string; readonly outer: string }> = oneOf([
	(source) => ({
		inner: source.draw(patternOver(alphabet)),
		outer: source.draw(patternOver(alphabet))
	}),
	(source) => ({
		inner: source.draw(patternOver(alphabet)),
		outer: formSource(source.draw(targetGen(admittedMaxPrecision)))
	})
])

describe("language inclusion", () => {
	it.effect(
		"an included pair admits no member of the inner pattern outside the outer, and a refuted pair's witness separates them",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/lexical-inclusion",
						draw: drawn((source) => {
							const pair = source.draw(pairGen)
							const parsed = parsePattern(pair.inner, "u")
							return {
								...pair,
								walks: parsed.ok
									? source.draw(array(walkGen(buildNfa(parsed.value)), { min: 1, max: 16 }))
									: []
							}
						}),
						literal: Formatter.format,
						coverage: required<InclusionFeature>(["included", "refuted"], {
							cases: 1500,
							sense: notesOnly
						}),
						kept: [],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the host NFA's membership (scalar/regex/nfa.ts)"
						}
					},
					({ inner, outer, walks }, run) =>
						Effect.sync(() => {
							const a = parsePattern(inner, "u")
							const b = parsePattern(outer, "u")
							if (!a.ok || !b.ok) {
								return
							}
							const innerNfa = buildNfa(a.value)
							const outerNfa = buildNfa(b.value)
							const result = inclusion(innerNfa, outerNfa)
							run.note(result.kind)
							const label = `/${inner}/ in /${outer}/`
							switch (result.kind) {
								case "included":
									for (const w of walks) {
										if (w !== undefined) {
											assert.ok(matches(innerNfa, w), `${label}: a walk is a member`)
											assert.ok(
												matches(outerNfa, w),
												`${label}: ${Formatter.format(w)} is in the outer`
											)
										}
									}
									return
								case "refuted":
									assert.ok(
										matches(innerNfa, result.witness),
										`${label}: the witness is in the inner`
									)
									assert.ok(
										!matches(outerNfa, result.witness),
										`${label}: the witness is not in the outer`
									)
									return
								case "bounded":
									return
							}
						})
				)
			)
	)
})

/** How a case states the parse's operand: by its field's type, or under a Compute.matches guard on a plain text. */
type Route = "type" | "guard"

/** What the checker answered a case, by how it stated the operand. */
type CheckFeature = `${Route} admitted` | `${Route} refused`

/**
 * A case's relation: its text field `t` typed by the pattern, or plain text under a matches guard by it, and a field
 * generated from its parse into the target, one builder per target so each names its own descriptor.
 */
type Parsed = (pattern: string, route: Route) => AnyRelation

const typedText = (pattern: string, route: Route) =>
	route === "type"
		? regexField<string, string, readonly []>(pattern, [])
		: regexField<string, string, readonly ["su"]>("^.*$", ["su"])

const checkTargets: Arr.NonEmptyReadonlyArray<readonly [LexicalTarget, Parsed]> = [
	[
		{ kind: "integer", carrier: "int2" },
		(pattern, route) =>
			relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					pg.smallint,
					route === "type"
						? Compute.cast(r.t, pg.smallint)
						: Compute.when(
								Compute.matches(r.t, pattern),
								(t) => Compute.cast(t, pg.smallint),
								Compute.literal(pg.smallint, 0)
							)
				)
			}))
	],
	[
		{ kind: "decimal", typmod: { precision: 3, scale: 1 } },
		(pattern, route) =>
			relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					pg.numeric(3, 1),
					route === "type"
						? Compute.cast(r.t, pg.numeric(3, 1))
						: Compute.when(
								Compute.matches(r.t, pattern),
								(t) => Compute.cast(t, pg.numeric(3, 1)),
								Compute.literal(pg.numeric(3, 1), "0")
							)
				)
			}))
	],
	[
		{ kind: "boolean" },
		(pattern, route) =>
			relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					pg.boolean,
					route === "type"
						? Compute.cast(r.t, pg.boolean)
						: Compute.when(
								Compute.matches(r.t, pattern),
								(t) => Compute.cast(t, pg.boolean),
								Compute.literal(pg.boolean, false)
							)
				)
			}))
	]
]

describe("a parse's lexical precondition", () => {
	it.effect(
		"is proved exactly when the operand's language is inside the form, by its type or by a matches guard",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/scalar/lexical-proved",
						draw: drawn((source) => ({
							pattern: `^(?:${source.draw(patternOver(alphabet))})$`,
							target: source.draw(element(checkTargets)),
							route: source.draw(element<Route>(["type", "guard"]))
						})),
						literal: Formatter.format,
						coverage: required<CheckFeature>(
							["type admitted", "type refused", "guard admitted", "guard refused"],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "language inclusion of the pattern in the form (scalar/regex/inclusion.ts)"
						}
					},
					({ pattern, target: [target, build], route }, run) =>
						Effect.sync(() => {
							if (!analyzeText(pattern, "u", SourceLoc("str.regex", [])).ok) {
								return
							}
							const verdict = inclusion(nfaOf(pattern), nfaOf(formSource(target))).kind
							const checked = checkedIn(schema("Lexical", { R: build(pattern, route) }, []))
							run.note(`${route} ${checked.ok ? "admitted" : "refused"}`)
							assert.equal(
								checked.ok,
								verdict === "included",
								`/${pattern}/ as ${Formatter.format(target)}`
							)
							if (!checked.ok) {
								/** A comparison past the analysis bounds decides nothing, which names them, not a missing guard. */
								const expected: CompileReasonTag =
									verdict === "bounded" ? "ResourceBound" : "PartialOperation"
								assert.equal(checked.error.reason._tag, expected, pattern)
							}
						})
				)
			)
	)
})
