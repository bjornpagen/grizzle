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
 *   significant digits a candidate has; a double's text of any digits by the IEEE 754 conversion written from its
 *   definition (test/support/oracle/evaluate/double-text.ts); a date's validity and day number as the proleptic
 *   Gregorian calendar of ECMAScript's Date gives them;
 * - **the inclusion walk's own refutation:** a pattern pair the walk calls included admits no walk of the inner
 *   pattern's NFA outside the outer's language, and a refuted pair's witness is a member of the inner and not of the
 *   outer, both judged by the host NFA, an implementation apart from the canonical DFAs the walk reads.
 *
 * Candidates are members by construction, near every boundary a form draws (the carriers' ranges, the typmod's
 * digits, the exponent bound, leap days, year 0000 and 10000), and named corruptions of them.
 *
 * A parse's lexical precondition, of an integer, a decimal, a double's text and a boolean, is proved exactly when the
 * operand's language is inside the form, by its type or by a matches guard, and a decimal's exactly when its bytes are
 * within the form's besides; a refusal names the remedy. A drawn pattern the text analysis refuses is no case of them,
 * and is given up, counted, never passed.
 *
 * Features: every shape of candidate; every lexical kind; an included and a refuted pair; each route admitted and
 * refused, a decimal's refused by its language and by its bytes.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { decimalTextMaxBytes } from "@grizzle/limits"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import { schema } from "#compiler/public/schema.ts"
import { decimalText } from "#compiler/public/text.ts"
import {
	formOctets,
	formSource,
	type LexicalTarget,
	lexicalValue
} from "#compiler/scalar/lexical.ts"
import { inclusion } from "#compiler/scalar/regex/inclusion.ts"
import { matches } from "#compiler/scalar/regex/match.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	candidateGen,
	dateDays,
	sameValue,
	type Shape,
	shapes,
	targetGen
} from "#test/support/lexical.ts"
import { checkedIn } from "#test/support/policy.ts"
import {
	admittedMaxPrecision,
	alphabet,
	type CheckFeature,
	checkTargets,
	decimalBoundGen,
	type DecimalFeature,
	decimalRelation,
	type InclusionFeature,
	longestMember,
	nfaOf,
	pairGen,
	roundDouble,
	type Route
} from "#test/unit/scalar/lexical.fixtures.ts"
import { admittedPatternOver, walkGen } from "#test/unit/text/generators.ts"

/** Lexical forms each form's pattern and its scan agree on every candidate, and a member names XML Schema's value. */
export const lexicalFormsEachFormsPatternAndItsScanAgreeOnEveryCandidateAndAMemberNamesXMLSchemasValue =
	property.explore(candidateGen, {
		needs: {},
		situations: shapes satisfies ReadonlyArray<Reached<Shape>>,
		check: (_, run: Case<Shape>) => (c) =>
			Effect.sync(() => {
				run.note(c.shape)
				const label = `${Formatter.format(c.target)} ${Formatter.format(c.text)}`
				const scanned = lexicalValue(c.target, c.text, roundDouble)
				const octets = formOctets(c.target)
				assert.equal(
					matches(nfaOf(formSource(c.target)), c.text) &&
						(octets === undefined || utf8Length(c.text) <= octets),
					c.member,
					`${label}: pattern and bytes`
				)
				assert.equal(scanned !== undefined, c.member, `${label}: scan`)
				if (c.member) {
					assert.ok(sameValue(scanned, c.value), `${label}: value ${Formatter.format(scanned)}`)
				}
				if (c.target.kind === "date" && c.member) {
					const [y, m, d] = Arr.map(Str.split("-")(c.text), Number)
					assert.equal(
						dayNumber(succeeded(toCalendarDate(c.text))),
						dateDays(defined(y, "year"), defined(m, "month"), defined(d, "day")),
						`${label}: day number`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "XML Schema's lexical spaces built from their parts, against the form's pattern and its scan"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original: '\t\t\t\treturn "true|false|1|0"',
				replacement: '\t\t\t\treturn "true|false|1|0|yes"',
				why: 'The boolean form\'s pattern admits "yes", which its scan does not; the second-definition property fails.'
			}
		]
	})

/** Lexical forms is admitted by the text analysis as a refinement str.regex types a field by, for every typmod in a box. */
export const lexicalFormsIsAdmittedByTheTextAnalysisAsARefinementStrRegexTypesAFieldByForEveryTypmodInABox =
	property.exhaust(finite(targetGen(admittedMaxPrecision)), {
		needs: {},
		situations: [
			"integer",
			"decimal",
			"double",
			"boolean",
			"date",
			"doubleText",
			"decimalText"
		] satisfies ReadonlyArray<Reached<LexicalTarget["kind"]>>,
		check: (_, c: Case<LexicalTarget["kind"]>) => (t) =>
			Effect.sync(() => {
				c.note(t.kind)
				const analyzed = analyzeText(
					[{ source: formSource(t), flags: "u" }],
					SourceLoc("lexicalForm", [])
				)
				assert.equal(
					analyzed.ok ? analyzed.value.check.kind : "refused",
					"regex",
					`${Formatter.format(t)}'s form is an admitted refinement`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the text analysis's admission (text/refinement.ts)"
		},
		box: "every integer carrier, numeric(p, s) for p from 1 to 12 and s from 0 to p, and every other kind",
		kept: [],
		kills: []
	})

/** Language inclusion an included pair admits no member of the inner pattern outside the outer, and a refuted pair's witness separates them. */
export const languageInclusionAnIncludedPairAdmitsNoMemberOfTheInnerPatternOutsideTheOuterAndARefutedPairsWitnessSeparatesThem =
	property.explore(
		(source) => {
			const pair = source.draw(pairGen)
			const parsed = parsePattern(pair.inner, "u")
			return {
				...pair,
				walks: parsed.ok
					? source.draw(array(walkGen(buildNfa(parsed.value)), { min: 1, max: 16 }))
					: []
			}
		},
		{
			needs: {},
			situations: ["included", "refuted"] satisfies ReadonlyArray<Reached<InclusionFeature>>,
			check:
				(_, run: Case<InclusionFeature>) =>
				({ inner, outer, walks }) =>
					Effect.sync(() => {
						const a = parsePattern(inner, "u")
						const b = parsePattern(outer, "u")
						if (!a.ok || !b.ok) {
							return assert.fail(`${inner} and ${outer}: admitted patterns parse`)
						}
						const innerNfa = buildNfa(a.value)
						const outerNfa = buildNfa(b.value)
						const result = inclusion([innerNfa], [outerNfa])
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
					}),
			oracle: {
				kind: "second-implementation",
				name: "the host NFA's membership (scalar/regex/nfa.ts)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/regex/inclusion.ts",
					original: '\t\t\treturn { kind: "refuted", witness: witness(at) }',
					replacement: '\t\t\treturn { kind: "included" }',
					why: "The inclusion walk calls every pair it reaches included, never refuted; the inclusion walk's refutation property fails, and the parse properties with it."
				}
			]
		}
	)

/** A parse's lexical precondition is proved exactly when the operand's language is inside the form, by its type or by a matches guard. */
export const aParsesLexicalPreconditionIsProvedExactlyWhenTheOperandsLanguageIsInsideTheFormByItsTypeOrByAMatchesGuard =
	property.explore(
		(source) => ({
			pattern: `^(?:${source.draw(admittedPatternOver(alphabet))})$`,
			target: source.draw(element(checkTargets)),
			route: source.draw(element<Route>(["type", "guard"]))
		}),
		{
			needs: {},
			situations: [
				"type admitted",
				"type refused",
				"guard admitted",
				"guard refused"
			] satisfies ReadonlyArray<Reached<CheckFeature>>,
			check:
				(_, run: Case<CheckFeature>) =>
				({ pattern, target: [target, build], route }) =>
					Effect.sync(() => {
						assert.ok(
							analyzeText([{ source: pattern, flags: "u" }], SourceLoc("str.regex", [])).ok,
							`${pattern}: an admitted pattern's text analyzes`
						)
						const verdict = inclusion([nfaOf(pattern)], [nfaOf(formSource(target))]).kind
						const checked = checkedIn(schema("Lexical", [build(pattern, route)], []))
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
					}),
			oracle: {
				kind: "second-implementation",
				name: "language inclusion of the pattern in the form (scalar/regex/inclusion.ts)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/regex/inclusion.ts",
					original: '\t\t\treturn { kind: "refuted", witness: witness(at) }',
					replacement: '\t\t\treturn { kind: "included" }',
					why: "The inclusion walk calls every pair it reaches included, never refuted; the inclusion walk's refutation property fails, and the parse properties with it."
				}
			]
		}
	)

/** A decimal's parse is proved exactly when the operand's language is inside decimalText and its bytes within the form's, by its type or by guards. */
export const aDecimalsParseIsProvedExactlyWhenTheOperandsLanguageIsInsideDecimalTextAndItsBytesWithinTheFormsByItsTypeOrByGuards =
	property.explore(
		(source) => ({
			pattern: `^(?:${source.draw(admittedPatternOver(alphabet))})$`,
			route: source.draw(element<Route>(["type", "guard"])),
			bound: source.draw(decimalBoundGen)
		}),
		{
			needs: {},
			situations: [
				"type admitted",
				"type refused by its language",
				"type refused by its bytes",
				"guard admitted",
				"guard refused by its language",
				"guard refused by its bytes"
			] satisfies ReadonlyArray<Reached<DecimalFeature>>,
			check:
				(_, run: Case<DecimalFeature>) =>
				({ pattern, route, bound }) =>
					Effect.sync(() => {
						const analyzed = analyzeText(
							[{ source: pattern, flags: "u" }],
							SourceLoc("str.regex", [])
						)
						if (!analyzed.ok) {
							return assert.fail(`${pattern}: an admitted pattern's text analyzes`)
						}
						const verdict = inclusion([nfaOf(pattern)], [nfaOf(decimalText.source)]).kind
						const check = analyzed.value.check
						const patternBytes =
							check.kind === "tautology" || check.bounds === undefined
								? Number.POSITIVE_INFINITY
								: check.bounds.bytes
						const bytes = Math.min(
							patternBytes,
							bound.kind === "bytes" ? bound.bytes : Number.POSITIVE_INFINITY
						)
						const withinBytes =
							bytes <= decimalTextMaxBytes.value ||
							(verdict === "included" &&
								bytes < patternBytes &&
								longestMember(nfaOf(pattern), bytes) <= decimalTextMaxBytes.value)
						const checked = checkedIn(
							schema("DecimalLexical", [decimalRelation(pattern, route, bound)], [])
						)
						const label = `/${pattern}/ by ${route} within ${Formatter.format(bound)}`
						if (verdict === "included" && withinBytes) {
							assert.ok(checked.ok, `${label}: ${checked.ok ? "" : checked.error.message}`)
							run.note(`${route} admitted`)
							return
						}
						assert.ok(!checked.ok, `${label}: refused`)
						const reason = checked.error.reason
						if (verdict === "bounded") {
							assert.equal(reason._tag, "ResourceBound", label)
							return
						}
						assert.ok(reason._tag === "PartialOperation", `${label}: refused as ${reason._tag}`)
						assert.equal(reason.precondition, "lexical", label)
						assert.deepEqual(
							reason.guard.remedy,
							verdict === "included"
								? { kind: "octets", bytes: decimalTextMaxBytes.value }
								: { kind: "matches", pattern: "decimalText" },
							label
						)
						run.note(
							verdict === "included"
								? `${route} refused by its bytes`
								: `${route} refused by its language`
						)
					}),
			oracle: {
				kind: "second-implementation",
				name: "language inclusion of the pattern in decimalText (scalar/regex/inclusion.ts) and the bytes of its longest member within the bound the text analysis and the str.bytes prove, by the host matcher's walk"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/regex/inclusion.ts",
					original: '\t\t\treturn { kind: "refuted", witness: witness(at) }',
					replacement: '\t\t\treturn { kind: "included" }',
					why: "The inclusion walk calls every pair it reaches included, never refuted; the inclusion walk's refutation property fails, and the parse properties with it."
				},
				{
					file: "packages/engine/src/scalar/compute/lower.ts",
					original:
						'\treturn formIncludes(regex.patterns, lexical, patterns).kind === "included"\n\t\t? { kind: "octets", bytes: octets }',
					replacement:
						'\treturn formIncludes(regex.patterns, lexical, patterns).kind === "included"\n\t\t? { kind: "octets", bytes: octets + 1 }',
					why: "A decimal parse's remedy bounds the operand's bytes one past the form's bound; the parse precondition's remedy property fails."
				}
			]
		}
	)
