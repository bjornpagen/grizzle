/**
 * The lexical forms of scalar/lexical.ts, each held to three oracles:
 *
 * - **its second definition:** every form is a pattern (formSource), which str.regex, Text.matches and the inclusion
 *   proof read, and a scan (lexicalValue), which the host evaluator reads; the host NFA's membership of a text in the
 *   pattern (scalar/regex/nfa.ts) must be exactly the scan's;
 * - **the specification as a checker:** each candidate is built from the parts XML Schema's lexical space spells
 *   (sign, digits either side of a point, exponent; year, month, day), and whether it is a member, and the value it
 *   names, follow from those parts alone: an integer in its carrier's range; a decimal's significant digits against
 *   the typmod; a double's value as ECMAScript's StringToNumber reads it, correctly rounded for the at most 20
 *   significant digits a candidate has, a zero's sign its own; a double's text of any digits by the IEEE 754 conversion written from its
 *   definition (test/support/oracle/evaluate/double-text.ts); a date's validity and day number as the proleptic
 *   Gregorian calendar of ECMAScript's Date gives them;
 * - **the inclusion walk's own refutation:** a pattern pair the walk calls included admits no walk of the inner
 *   pattern's NFA outside the outer's language, and a refuted pair's witness is a member of the inner and not of the
 *   outer, both judged by the host NFA, an implementation apart from the canonical DFAs the walk reads.
 *
 * Candidates are members by construction, near every boundary a form draws (the carriers' ranges, the typmod's
 * digits, the exponent bound, leap days, year 0000 and 10000), and named corruptions of them.
 *
 * lexicalForm and lexical read a field of every kind a relation holds that is typed as a type with a form, an
 * accumulated field and drawn(natural), as its declared type: the candidates of the type's form are
 * exactly the members of the pattern each gives for the field.
 *
 * A parse's lexical precondition, of an integer, a decimal, a double's text and a boolean, is proved exactly when the
 * operand's language is inside the form, by its type or by a matches guard, and a decimal's exactly when its bytes are
 * within the form's besides; a refusal names the remedy. A drawn pattern the text analysis refuses is no case of them,
 * and is given up, counted, never passed.
 *
 * Features: every shape of candidate; every lexical kind; an included and a refuted pair; each route admitted and
 * refused, a decimal's refused by its language and by its bytes; each kind of field lexicalForm reads.
 */

import { type DfaOutcome, minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import { type Inclusion, inclusion } from "@bjornpagen/grizzle-text/regex/inclusion"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { includedWithin } from "@bjornpagen/grizzle-text/regex/within"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import { schema } from "#compiler/public/schema.ts"
import { numericText, lexical, lexicalForm } from "#compiler/public/text.ts"
import {
	numericTextMaxBytes,
	formOctets,
	formSource,
	type LexicalTarget,
	lexicalValue
} from "#compiler/scalar/lexical.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	candidateGen,
	dateDays,
	sameValue,
	type Shape,
	shapes,
	targetGen
} from "#test/support/lexical.ts"
import { checkedIn } from "#test/support/policy.ts"
import { admittedPatternOver, walkGen } from "#test/support/unit/text/generators.ts"
import {
	admittedMaxPrecision,
	alphabet,
	type CheckFeature,
	checkTargets,
	decimalBoundGen,
	type DecimalFeature,
	decimalRelation,
	type InclusionFeature,
	type LexicalFieldFeature,
	lexicalFieldGen,
	lexicalFieldOf,
	lexicalFieldSituations,
	longestMember,
	nfaOf,
	pairGen,
	roundDouble,
	type Route
} from "#test/unit/scalar/lexical.fixtures.ts"

/** A pattern automaton's minimization at the text analysis's bounds, what an inclusion compares. */
const minimal = (nfa: Nfa): DfaOutcome => minimalDfa(nfa, regexDfaLimits)

/**
 * Whether the inner automaton's language within `bytes` UTF-8 bytes (every member where they are unbounded) lies inside
 * the outer's: the one inclusion judgment of texts (scalar/regex/inclusion.ts languageIncludes) restated over the two
 * minimizations, its walk grizzle-text's own (regex/within.ts includedWithin), its verdict's kind.
 */
const includedInBytes = (inner: Nfa, bytes: number, outer: Nfa): Inclusion["kind"] => {
	if (!Number.isFinite(bytes)) {
		return inclusion([minimal(inner)], [minimal(outer)], regexDfaLimits).kind
	}
	const a = minimal(inner)
	const b = minimal(outer)
	return a.kind === "minimal" && b.kind === "minimal"
		? includedWithin(a.dfa, bytes, b.dfa, regexDfaLimits).kind
		: "bounded"
}

/**
 * Lexical forms each form's pattern and its scan agree on every candidate, and a member names XML Schema's value.
 *
 * Budget: its suite's count before the conversion (unit/scalar/lexical-forms: 4000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
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
					Matcher.of(nfaOf(formSource(c.target))).matches(c.text) &&
						(octets === undefined || utf8Length(c.text) <= octets),
					c.member,
					`${label}: pattern and bytes`
				)
				assert.equal(scanned !== undefined, c.member, `${label}: scan`)
				if (c.target.kind === "double" && c.member) {
					assert.ok(
						Matcher.of(nfaOf(formSource({ kind: "float8Text" }))).matches(c.text),
						`${label}: the bounded double form lies inside float8Text`
					)
				}
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
		budget: { runs: 4000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original: '\t\t\t\treturn "true|false|1|0"',
				replacement: '\t\t\t\treturn "true|false|1|0|yes"',
				why: 'The boolean form\'s pattern admits "yes", which its scan does not; the second-definition property fails.'
			},
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original: '(?:[eE][+-]?[0-9]+)?|-?INF|NaN"',
				replacement: '(?:[eE][+-]?[0-9]+)?|[+-]?INF|NaN"',
				why: 'float8Text\'s pattern admits "+INF", which XML Schema 1.0\'s xs:double lexical space does not hold; the "+INF" candidate fails.'
			},
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original: '\t\ttext === "INF" ||\n\t\ttext === "-INF" ||',
				replacement: '\t\ttext === "INF" ||\n\t\ttext === "+INF" ||\n\t\ttext === "-INF" ||',
				why: 'float8Text\'s scan reads "+INF" as Infinity, which XML Schema 1.0 does not; the "+INF" candidate fails.'
			},
			{
				file: "packages/engine/src/scalar/compute/cast.ts",
				original: "\treturn negative ? -magnitude : magnitude\n",
				replacement: "\treturn magnitude === 0 ? 0 : negative ? -magnitude : magnitude\n",
				why: "The host rounds a negative rational to the one zero: a double's text of a negative zero, -0 or -000.0e-293, parses to 0, where ECMAScript, XML Schema's lexical mapping and PostgreSQL's float8in read -0."
			}
		]
	})

/**
 * A field's lexical form is its declared type's, whatever kind of field it is: for a caller's descriptor, an accumulated
 * field of it and drawn(natural), the candidates of the declared type's form, built from XML
 * Schema's parts, are exactly the members of lexicalForm's pattern for the field, within the form's bytes, and of the
 * pattern of lexical's text field.
 *
 * Budget: a thousand candidates, each kind of field drawn alike, every candidate shape of a type's form among them.
 */
export const aFieldsLexicalFormIsItsDeclaredTypesWhateverKindOfFieldItIs = property.explore(
	lexicalFieldGen,
	{
		needs: {},
		situations: lexicalFieldSituations satisfies ReadonlyArray<Reached<LexicalFieldFeature>>,
		check: (_, run: Case<LexicalFieldFeature>) => (c) =>
			Effect.sync(() => {
				run.note(`reads ${c.reading}`)
				const field = lexicalFieldOf(c)
				const label = `${c.reading} ${Formatter.format(c.target)} ${Formatter.format(c.candidate.text)}`
				const octets = formOctets(c.target)
				const admits = (source: string): boolean =>
					Matcher.of(nfaOf(source)).matches(c.candidate.text) &&
					(octets === undefined || utf8Length(c.candidate.text) <= octets)
				assert.equal(
					admits(lexicalForm(field).source),
					c.candidate.member,
					`${label}: lexicalForm's pattern`
				)
				assert.equal(
					Arr.every(lexical(field).patterns, (p) => admits(p.source)),
					c.candidate.member,
					`${label}: lexical's patterns`
				)
			}),
		oracle: {
			kind: "specification",
			name: "XML Schema's lexical spaces built from their parts, against the patterns lexicalForm and lexical give for a field of every kind"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/relation.ts",
				original:
					'\tfieldEntries.set(value, { kind: "written", writing: { kind: "drawn" } })\n\tregisterWrittenField(value, type)\n',
				replacement: '\tfieldEntries.set(value, { kind: "written", writing: { kind: "drawn" } })\n',
				why: "drawn(natural) registers no type its values are of (scalar/registry.ts registerWrittenField), so the one reading of a field as its declared type (describeDeclared) reads none for a drawn field: lexicalForm and lexical refuse it (MalformedDescription) though its type, a bigint's, admits it."
			}
		]
	}
)

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
			"float8Text",
			"numericText"
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
		kills: [
			{
				file: "packages/text/src/regex/parse.ts",
				original: '\t\tif (c !== cp("\\\\")) {',
				replacement: '\t\tif (c === cp("\\\\")) {',
				why: "Operator mutant (comparison) at packages/engine/src/scalar/regex/parse.ts:914 in <module>: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Language inclusion an included pair admits no member of the inner pattern outside the outer, and a refuted pair's
 * witness separates them.
 *
 * Budget: its suite's count before the conversion (unit/scalar/lexical-inclusion: 1500 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
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
						const result = inclusion([minimal(innerNfa)], [minimal(outerNfa)], regexDfaLimits)
						run.note(result.kind)
						const label = `/${inner}/ in /${outer}/`
						switch (result.kind) {
							case "included":
								for (const w of walks) {
									if (w !== undefined) {
										assert.ok(Matcher.of(innerNfa).matches(w), `${label}: a walk is a member`)
										assert.ok(
											Matcher.of(outerNfa).matches(w),
											`${label}: ${Formatter.format(w)} is in the outer`
										)
									}
								}
								return
							case "refuted":
								assert.ok(
									Matcher.of(innerNfa).matches(result.witness),
									`${label}: the witness is in the inner`
								)
								assert.ok(
									!Matcher.of(outerNfa).matches(result.witness),
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
			budget: { runs: 1500, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/inclusion.ts",
					original: '\t\t\treturn { kind: "refuted", witness: witness(at) }',
					replacement: '\t\t\treturn { kind: "included" }',
					why: "The inclusion walk calls every pair it reaches included, never refuted; the inclusion walk's refutation property fails, and the parse properties with it."
				}
			]
		}
	)

/**
 * A parse's lexical precondition is proved exactly when the operand's language is inside the form, by its type or by a
 * matches guard.
 *
 * Budget: its suite's count before the conversion (unit/scalar/lexical-proved: 600 independent cases and 16 steered,
 * Vitest at grizzle 4ca3036a).
 */
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
						const verdict = inclusion(
							[minimal(nfaOf(pattern))],
							[minimal(nfaOf(formSource(target)))],
							regexDfaLimits
						).kind
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
			budget: { runs: 600, steered: 16 },
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/inclusion.ts",
					original: '\t\t\treturn { kind: "refuted", witness: witness(at) }',
					replacement: '\t\t\treturn { kind: "included" }',
					why: "The inclusion walk calls every pair it reaches included, never refuted; the inclusion walk's refutation property fails, and the parse properties with it."
				}
			]
		}
	)

/**
 * A decimal's parse is proved exactly when the operand's language is inside numericText and its bytes within the
 * form's, by its type or by guards.
 *
 * Budget: its suite's count before the conversion (unit/scalar/lexical-decimal-proved: 600 independent cases and 240
 * steered, Vitest at grizzle 4ca3036a).
 */
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
						const language = inclusion(
							[minimal(nfaOf(pattern))],
							[minimal(nfaOf(numericText.source))],
							regexDfaLimits
						).kind
						const check = analyzed.value.check
						const patternBytes =
							check.kind === "tautology" || check.bounds === undefined
								? Number.POSITIVE_INFINITY
								: check.bounds.bytes
						const bytes = Math.min(
							patternBytes,
							bound.kind === "bytes" ? bound.bytes : Number.POSITIVE_INFINITY
						)
						/** The judgment within the operand's bytes; the remedy reads the language alone (lexicalRemedy). */
						const verdict = includedInBytes(nfaOf(pattern), bytes, nfaOf(numericText.source))
						const withinBytes =
							bytes <= numericTextMaxBytes ||
							(verdict === "included" &&
								bytes < patternBytes &&
								longestMember(nfaOf(pattern), bytes) <= numericTextMaxBytes)
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
							language === "included"
								? { kind: "octets", bytes: numericTextMaxBytes }
								: { kind: "matches", pattern: "numericText" },
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
				name: "language inclusion of the pattern in numericText (scalar/regex/inclusion.ts) and the bytes of its longest member within the bound the text analysis and the str.bytes prove, by the host matcher's walk"
			},
			budget: { runs: 600, steered: 240 },
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/inclusion.ts",
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
