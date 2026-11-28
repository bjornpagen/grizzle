/**
 * A conjunction of patterns (str.and), whose language is the intersection of its members', as the text analysis keys,
 * bounds, matches, compares and enforces it. Each search draws its patterns from the generated grammar and finite
 * languages over a small alphabet, ECMAScript's own membership of every member (test/support/regex.ts jsMatcher) the oracle of
 * the intersection:
 *
 * - **its language:** the host's membership of a drawn text (scalar/regex/patterns.ts) and the intersection's canonical
 *   DFA, where the analysis builds one, are ECMAScript's conjunction of its members' verdicts; every text of it lies
 *   within the bounds it proves, which a bounded member gives an unbounded one; and the key is the language's, so the
 *   members in either order, a member twice, or a member beside every text's pattern key alike;
 * - **inclusion:** a conjunction's inclusion in another (scalar/regex/inclusion.ts) holds exactly when brute force over
 *   every text of up to four code points of the alphabet, and walks of the inner members, finds no text of every inner
 *   member outside some outer one, and a refutation's witness is such a text;
 * - **a match guard:** Text.matches over a refined subject types its branch by both languages, so a parse in the
 *   branch compiles exactly when the conjunction lies inside the parse's form, a case neither pattern alone proves among
 *   them;
 * - **its size:** its CHECK prints in no more bytes than its members' own tests joined by AND, so a conjunction's
 *   installation is linear in its members, conjunctions of classes over XML's name ranges, which span the planes as an
 *   NCName's do, among them.
 *
 * Oracles: ECMAScript's membership of every member; brute force over every short text and walks of the inner members;
 * the inclusion of the two patterns' conjunction in the form; the sum of the members' own tests and their joins.
 *
 * Features: a pair and a triple, keyed by the intersection's automaton or by its members, a text of the conjunction and
 * one the first member alone holds, refused as matching no text, bounded where a member alone is not; included and
 * refuted inclusions, and one included by the inner members together and by none alone; admitted and refused guards;
 * a regex check of several patterns and an IN list.
 */

import { type DfaOutcome, minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import { inclusion } from "@bjornpagen/grizzle-text/regex/inclusion"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import type { Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { codePoints } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, array, element } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { wildcardPattern } from "#compiler/ir/scalar.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { analyzeText, type TextRefinement } from "#compiler/text/refinement.ts"
import { checkedIn } from "#test/support/policy.ts"
import { textInfo } from "#test/support/text.ts"
import { refinementBounds } from "#test/support/text.ts"
import { stringsOver } from "#test/support/unit/text/generators.ts"
import {
	includedTogetherGen,
	type InclusionCase,
	inclusionCaseGen,
	andBytes,
	conjunctionGen,
	dfaAccepts,
	digitsUnderLengthGen,
	type GuardCase,
	guardCaseGen,
	guardedParse,
	type GuardFeature,
	type GuardOutcome,
	guardOutcome,
	type InclusionFeature,
	jsAll,
	type LanguageFeature,
	letters,
	loc,
	memberBytes,
	nfaOf,
	predicateBytes,
	reversed,
	shortTexts,
	sizeCaseGen,
	type SizeFeature,
	smallintForm,
	walksOf
} from "#test/unit/text/conjunction.fixtures.ts"

/** A pattern automaton's minimization at the text analysis's bounds, what an inclusion compares. */
const minimal = (nfa: Nfa): DfaOutcome => minimalDfa(nfa, regexDfaLimits)

/** A conjunction's language is every member's at once, by the host and by the intersection's automaton, and is keyed by its language. Its budget is its suite's before it was a property (test/unit/text/conjunction.test.ts at 4ca3036a): 1200 runs and 1200 steered cases. */
export const aConjunctionsLanguageIsEveryMembersAtOnceByTheHostAndByTheIntersectionsAutomatonAndIsKeyedByItsLanguage =
	property.explore(
		(source) => {
			const patterns = source.draw(conjunctionGen(letters, 2, 3))
			return {
				patterns,
				texts: [
					...source.draw(array(stringsOver(element(letters), 6), { min: 1, max: 40 })),
					...source.draw(walksOf(patterns))
				]
			}
		},
		{
			needs: {},
			budget: { runs: 1200, steered: 1200 },
			situations: [
				"a pair",
				"a triple",
				"keyed by the intersection's automaton",
				"a text the first member holds and the conjunction does not",
				"a text of the conjunction",
				"refused as matching no text",
				"bounded where a member alone is not"
			] satisfies ReadonlyArray<Reached<LanguageFeature>>,
			check:
				(_, k: Case<LanguageFeature>) =>
				({ patterns, texts }) =>
					Effect.sync(() => {
						const label = Formatter.format(patterns)
						const analyzed = analyzeText(patterns, loc)
						k.note(patterns.length === 2 ? "a pair" : "a triple")
						const members = Arr.map(patterns, (p) => analyzeText([p], loc))
						const ofAll = jsAll(patterns)
						if (!analyzed.ok) {
							if (Arr.every(members, (m) => m.ok)) {
								k.note("refused as matching no text")
								assert.equal(analyzed.error.reason._tag, "UnsupportedOperation", label)
								assert.ok(
									Arr.every(texts, (t) => !ofAll(t)),
									`${label} is refused as empty, and holds no drawn text`
								)
							}
							return
						}
						const r: TextRefinement = analyzed.value
						const regex = textInfo(r)
						const host = new CompilePatterns()
						const bounds = refinementBounds(r)
						if (
							bounds !== undefined &&
							Arr.some(members, (m) => m.ok && refinementBounds(m.value) === undefined)
						) {
							k.note("bounded where a member alone is not")
						}
						const ofFirst = jsAll([patterns[0]])
						for (const t of texts) {
							const expected = ofAll(t)
							const where = `${label} on ${Formatter.format(t)}`
							if (expected) {
								k.note("a text of the conjunction")
							} else if (ofFirst(t)) {
								k.note("a text the first member holds and the conjunction does not")
							}
							assert.equal(
								typeof regex === "string" || host.member(regex, t),
								expected,
								`${where}: the host`
							)
							if (r.known.kind === "automaton") {
								assert.equal(
									dfaAccepts(r.known.dfa, t),
									expected,
									`${where}: the intersection's DFA`
								)
							}
							if (expected && bounds !== undefined) {
								assert.ok(
									codePoints(t).length <= bounds.length && utf8Length(t) <= bounds.bytes,
									`${where}: within its proved bounds ${Formatter.format(bounds)}`
								)
							}
						}
						const other = analyzeText(reversed(patterns), loc)
						assert.ok(other.ok, `${label} in another order`)
						if (r.known.kind === "automaton") {
							k.note("keyed by the intersection's automaton")
							assert.equal(other.value.key, r.key, `${label}: one key in either order`)
						} else {
							k.note("keyed by its members past the bounds")
						}
						const [first] = patterns
						const alone = analyzeText([first], loc)
						if (alone.ok) {
							const twice = analyzeText([first, first], loc)
							const beside = analyzeText([first, wildcardPattern], loc)
							assert.equal(
								twice.ok && twice.value.key,
								alone.value.key,
								`${label}: its first member twice`
							)
							assert.equal(
								beside.ok && beside.value.key,
								alone.value.key,
								`${label}: its first member beside every text's pattern`
							)
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "ECMAScript's membership of every member (test/support/regex.ts jsMatcher)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/regex/matcher.ts",
					original: "\t\tregex.patterns.every((pattern) => matcherOf(pattern).matches(text))",
					replacement: "\t\tregex.patterns.some((pattern) => matcherOf(pattern).matches(text))",
					why: "The host takes a text any member of a conjunction matches; the language property fails."
				}
			]
		}
	)

/** A conjunction's inclusion holds exactly when no short text or inner walk holds every inner member and misses an outer one. Its budget is its suite's before it was a property (test/unit/text/conjunction.test.ts at 4ca3036a): 1500 runs and 1500 steered cases. */
export const aConjunctionsInclusionHoldsExactlyWhenNoShortTextOrInnerWalkHoldsEveryInnerMemberAndMissesAnOuterOne =
	property.explore(
		aimed<InclusionCase, InclusionFeature>(inclusionCaseGen, [
			["included by inner members together, by none alone", includedTogetherGen]
		]),
		{
			needs: {},
			budget: { runs: 1500, steered: 1500 },
			situations: [
				"included",
				"refuted",
				"included by inner members together, by none alone"
			] satisfies ReadonlyArray<Reached<InclusionFeature>>,
			check:
				(_, k: Case<InclusionFeature>) =>
				({ inner, outer, walks }) =>
					Effect.sync(() => {
						const innerNfas = Arr.getSomes(Arr.map(inner, nfaOf))
						const outerNfas = Arr.getSomes(Arr.map(outer, nfaOf))
						if (
							!Arr.isReadonlyArrayNonEmpty(innerNfas) ||
							!Arr.isReadonlyArrayNonEmpty(outerNfas) ||
							innerNfas.length !== inner.length ||
							outerNfas.length !== outer.length
						) {
							return
						}
						const label = `${Formatter.format(inner)} in ${Formatter.format(outer)}`
						const verdict = inclusion(
							Arr.map(innerNfas, minimal),
							Arr.map(outerNfas, minimal),
							regexDfaLimits
						)
						k.note(verdict.kind)
						const ofInner = jsAll(inner)
						const ofOuter = jsAll(outer)
						const outside = (t: string): boolean => ofInner(t) && !ofOuter(t)
						switch (verdict.kind) {
							case "included": {
								const counter = Arr.findFirst([...shortTexts, ...walks], outside)
								assert.ok(
									Option.isNone(counter),
									`${label}: ${Formatter.format(counter)} holds every inner member and misses an outer one`
								)
								if (
									inner.length > 1 &&
									Arr.every(
										innerNfas,
										(n) =>
											inclusion([minimal(n)], Arr.map(outerNfas, minimal), regexDfaLimits).kind !==
											"included"
									)
								) {
									k.note("included by inner members together, by none alone")
								}
								return
							}
							case "refuted":
								assert.ok(
									outside(verdict.witness),
									`${label}: the witness ${Formatter.format(verdict.witness)}`
								)
								return
							case "bounded":
								return
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "brute force over every short text, by ECMAScript's membership"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/text/conjunction.test.ts#aConjunctionsInclusionHoldsExactlyWhenNoShortTextOrInnerWalkHoldsEveryInnerMemberAndMissesAnOuterOne:4.2:0.1.0.0.0.0.0"
					),
					reason: "two inner members whose intersection, and neither alone, lies inside the outer",
					since: "2026-11-08"
				}
			],
			kills: [
				{
					file: "packages/text/src/regex/inclusion.ts",
					original: "\treturn (",
					replacement: '\treturn (\n\t\tverdicts.find((v) => v.kind === "included") ??',
					why: "An inclusion in one outer member is taken for inclusion in the outer conjunction; the inclusion property fails."
				}
			]
		}
	)

/** A match guard over a refined subject types its branch by the subject's patterns and the match's, so a parse in it compiles exactly when they lie inside the form. Its budget is its suite's before it was a property (test/unit/text/conjunction.test.ts at 4ca3036a): 600 runs and 600 steered cases. */
export const aMatchGuardOverARefinedSubjectTypesItsBranchByTheSubjectsPatternsAndTheMatchsSoAParseInItCompilesExactlyWhenTheyLieInsideTheForm =
	property.explore(
		aimed<GuardCase, GuardFeature>(guardCaseGen, [["admitted", digitsUnderLengthGen]]),
		{
			needs: {},
			budget: { runs: 600, steered: 600 },
			situations: ["admitted", "refused"] satisfies ReadonlyArray<Reached<GuardFeature>>,
			check:
				(_, k: Case<GuardFeature>) =>
				({ subject, guard }) =>
					Effect.sync(() => {
						const subjectPattern: PatternSource = { source: subject, flags: "u" }
						const guardPattern: PatternSource = { source: guard, flags: "u" }
						const patterns: Patterns = [subjectPattern, guardPattern]
						if (!analyzeText([subjectPattern], loc).ok || !analyzeText([guardPattern], loc).ok) {
							return
						}
						const label = Formatter.format(patterns)
						const checked = checkedIn(guardedParse(subject, guard))
						const together = analyzeText(patterns, loc)
						k.note(checked.ok ? "admitted" : "refused")
						if (!together.ok) {
							assert.equal(
								!checked.ok && checked.error.reason._tag,
								together.error.reason._tag,
								`${label}: a guard no subject text can pass`
							)
							return
						}
						const nfas = Arr.getSomes(Arr.map(patterns, nfaOf))
						const form = defined(
							Option.getOrUndefined(nfaOf({ source: smallintForm, flags: "u" })),
							"the form's NFA"
						)
						if (!Arr.isReadonlyArrayNonEmpty(nfas)) {
							return assert.fail(`${label} parses`)
						}
						const actual: GuardOutcome = checked.ok
							? { kind: "admitted" }
							: { kind: "refused", reason: checked.error.reason._tag }
						assert.deepEqual(
							actual,
							guardOutcome[inclusion(Arr.map(nfas, minimal), [minimal(form)], regexDfaLimits).kind],
							label
						)
						if (
							checked.ok &&
							Arr.every(
								nfas,
								(nfa) =>
									inclusion([minimal(nfa)], [minimal(form)], regexDfaLimits).kind !== "included"
							)
						) {
							k.note("admitted where neither pattern alone lies inside the form")
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "the inclusion of the two patterns' conjunction in smallint's form (scalar/regex/inclusion.ts)"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/text/conjunction.test.ts#aMatchGuardOverARefinedSubjectTypesItsBranchByTheSubjectsPatternsAndTheMatchsSoAParseInItCompilesExactlyWhenTheyLieInsideTheForm:1.0:0.0.0.3"
					),
					reason:
						"digits of any count, under a match of at most four characters: smallint's form holds both together",
					since: "2026-11-08"
				}
			],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original: "\t\t\tappendNonEmpty(own === undefined ? [] : own.patterns, {",
					replacement: "\t\t\tappendNonEmpty([], {",
					why: "A match guard's branch is typed by the guard's pattern alone, the subject's own patterns dropped; the match guard property fails."
				}
			]
		}
	)

/** A conjunction's CHECK prints in no more bytes than its members' own tests joined by AND. Its budget is its suite's before it was a property (test/unit/text/conjunction.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const aConjunctionsCHECKPrintsInNoMoreBytesThanItsMembersOwnTestsJoinedByAND =
	property.explore(sizeCaseGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: ["a regex check of several patterns", "an IN list"] satisfies ReadonlyArray<
			Reached<SizeFeature>
		>,
		check:
			(_, k: Case<SizeFeature>) =>
			({ patterns }) =>
				Effect.sync(() => {
					const analyzed = analyzeText(patterns, loc)
					if (!analyzed.ok) {
						return
					}
					const r = analyzed.value
					if (r.check.kind === "regex" && r.check.ares.length > 1) {
						k.note("a regex check of several patterns")
					}
					if (r.check.kind === "finite") {
						k.note("an IN list")
					}
					if (patterns.length > 4) {
						k.note("more than four patterns")
					}
					assert.ok(
						predicateBytes(r) <= memberBytes(r) + andBytes * (patterns.length - 1),
						`${Formatter.format(patterns)}: ${predicateBytes(r)} bytes`
					)
				}),
		oracle: {
			kind: "specification",
			name: "the sum of the members' own tests and their joins"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					"\t#close(value: object, kind: ContainerKind): void {\n\t\tthis.#frames.pop()\n\t\tthis.#ancestors.delete(value)",
				replacement:
					"\t#close(value: object, kind: ContainerKind): void {\n\t\t{}\n\t\tthis.#ancestors.delete(value)",
				why: "Operator mutant 8dfa3f6c6a at packages/engine/src/core/canonical.ts:811 in <module>: `this.#frames.pop()` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
