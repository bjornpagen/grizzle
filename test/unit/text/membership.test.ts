/**
 * Host membership and the bounded language proofs, against ECMAScript as the development oracle.
 *
 * - Membership: the host NFA agrees with `new RegExp(source, flags).test` on every admitted pattern and admitted string,
 *   the handwritten family patterns over their families' strings and walks of their own NFA, each pattern accepting
 *   and refusing, and generated patterns, an empty language matching none of its strings.
 * - Admitted text: no pattern accepts a string that is not admitted text (a NUL or a lone surrogate), and the tautology
 *   accepts every admitted one.
 * - Claimed facts: a tautology accepts every string, a finite language is exactly its members, each once, and a bound
 *   bounds every member.
 * - Keys: two patterns with one canonical key, the second drawn apart or as the first with one code point changed,
 *   have one digest and agree on every string; a finite language's pattern and the alternation of its members in any
 *   order have one key where both are keyed by their automaton, a spelling past the analysis bounds keyed by its IR
 *   or refused; its languages are drawn within spelledMembers, a search budget.
 *
 * Oracle: ECMAScript's RegExp test (generators.ts jsMatcher), which appears only here, never under src/; for the
 * spellings, the finite language's members its construction gives.
 *
 * Features: each family pattern accepting and refusing; admitted, empty and a witness; live text and each plant in the
 * middle; a tautology, a finite language and a bound; equal and distinct keys, distinct keys of patterns one code point
 * apart among them; one member, several, the empty text.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { refinementBounds } from "#test/support/text.ts"
import { jsMatcher, walk, walkLength } from "#test/unit/text/generators.ts"
import {
	acceptances,
	admittedPatterns,
	membershipCaseGen,
	codePointLength,
	type FamilyCase,
	familyCaseGen,
	type FamilyFeature,
	familyPatterns,
	type GeneratedFeature,
	keyedByIr,
	type KeyCase,
	keyCaseGen,
	type KeyFeature,
	testLoc,
	oneApart,
	oneLiteralChangedGen,
	patternSketchGen,
	refineOrEmpty,
	refusals,
	spelledMembers,
	type SpellingFeature,
	tautologies,
	twoSpellings,
	utf8Bytes
} from "#test/unit/text/membership.fixtures.ts"
import {
	plantedFault,
	type PlantedFeature,
	plantedFeature,
	plantedTextGen,
	plantedValue
} from "#test/unit/values/support.ts"

/** Host NFA membership equals ECMAScript on the handwritten family patterns, over their families' strings and walks of their own NFA, every pattern accepting and refusing. */
export const hostNFAMembershipEqualsECMAScriptOnTheHandwrittenFamilyPatternsOverTheirFamiliesStringsAndWalksOfTheirOwnNFAEveryPatternAcceptingAndRefusing =
	property.explore(
		aimed(familyCaseGen, [
			...Arr.map(
				acceptances,
				([p, subject]) => [`${p.label} accepts`, (): FamilyCase => [p, subject]] as const
			),
			...Arr.map(
				refusals,
				([p, subject]) => [`${p.label} refuses`, (): FamilyCase => [p, subject]] as const
			)
		]),
		{
			needs: {},
			situations: [
				...Arr.map(admittedPatterns, (p): FamilyFeature => `${p.label} accepts`),
				...Arr.map(refusals, ([p]): FamilyFeature => `${p.label} refuses`)
			] satisfies ReadonlyArray<Reached<FamilyFeature>>,
			check:
				(_, c: Case<FamilyFeature>) =>
				([p, subject]) =>
					Effect.sync(() => {
						if (subject.s === undefined) {
							return
						}
						const js = jsMatcher(p.source, p.flags)(subject.s)
						const label = `${p.label} on ${Formatter.format(subject.s)}`
						assert.equal(accepts(p.r, subject.s), js, label)
						if (subject.witness) {
							assert.equal(js, true, `${label}: a witness is a member`)
						}
						c.note(`${p.label} ${js ? "accepts" : "refuses"}`)
					}),
			oracle: { kind: "second-implementation", name: "ECMAScript's RegExp test (jsMatcher)" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/regex/match.ts",
					original:
						"\t\tcurrent = closure(nfa, next, { atStart: false, atEnd: i + 1 === n }, mark, stamp++)",
					replacement:
						"\t\tcurrent = closure(nfa, next, { atStart: false, atEnd: i + 2 === n }, mark, stamp++)",
					why: "The host NFA reads `$` one code point before the text's end; the membership and admitted text properties fail."
				}
			]
		}
	)

/** Host NFA membership equals ECMAScript on generated patterns. */
export const hostNFAMembershipEqualsECMAScriptOnGeneratedPatterns = property.explore(
	patternSketchGen,
	{
		needs: {},
		situations: ["admitted", "empty", "witness"] satisfies ReadonlyArray<Reached<GeneratedFeature>>,
		check:
			(_, c: Case<GeneratedFeature>) =>
			({ source, flags, strings, walks }) =>
				Effect.sync(() => {
					const r = refineOrEmpty(source, flags)
					if (r === "bound") {
						return
					}
					c.note(r === "empty" ? "empty" : "admitted")
					const ofPattern = jsMatcher(source, flags)
					for (const s of strings) {
						const expected = ofPattern(s)
						if (r === "empty") {
							assert.equal(expected, false)
						} else {
							assert.equal(accepts(r, s), expected)
						}
					}
					if (r === "empty") {
						return
					}
					for (const tape of walks) {
						const w = walk(buildNfa(r.members[0].ir), tape, walkLength)
						if (w === undefined) {
							continue
						}
						c.note("witness")
						assert.equal(ofPattern(w), true)
						assert.equal(accepts(r, w), true)
					}
				}),
		oracle: { kind: "second-implementation", name: "ECMAScript's RegExp test (jsMatcher)" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/match.ts",
				original: "\t\tconst next = [...current.flatMap((s) => stepsOn(nfa, s, c)), nfa.start]",
				replacement: "\t\tconst next = current.flatMap((s) => stepsOn(nfa, s, c))",
				why: "The host NFA tries a match only from the text's start, never restarting at a later code point; the membership property fails."
			},
			{
				file: "packages/engine/src/scalar/regex/match.ts",
				original:
					"\t\tcurrent = closure(nfa, next, { atStart: false, atEnd: i + 1 === n }, mark, stamp++)",
				replacement:
					"\t\tcurrent = closure(nfa, next, { atStart: false, atEnd: i + 2 === n }, mark, stamp++)",
				why: "The host NFA reads `$` one code point before the text's end; the membership and admitted text properties fail."
			}
		]
	}
)

/** Host NFA membership equals ECMAScript accepts no string that is not admitted text, under every family's patterns, and the tautology every admitted one. */
export const hostNFAMembershipEqualsECMAScriptAcceptsNoStringThatIsNotAdmittedTextUnderEveryFamilysPatternsAndTheTautologyEveryAdmittedOne =
	property.explore(
		(source) => [source.draw(plantedTextGen), source.draw(element(familyPatterns))] as const,
		{
			needs: {},
			situations: [
				"live",
				"nul middle",
				"lone high middle",
				"lone low middle",
				"reversed pair middle"
			] satisfies ReadonlyArray<Reached<PlantedFeature>>,
			check:
				(_, c: Case<PlantedFeature>) =>
				([planted, [source, flags]]) =>
					Effect.sync(() => {
						const value = plantedValue(planted)
						if (typeof value !== "string") {
							return
						}
						c.note(plantedFeature(planted))
						const admitted = plantedFault(planted) === undefined
						for (const tautology of tautologies) {
							assert.equal(accepts(tautology, value), admitted, tautology.members[0].source)
						}
						const r = refineOrEmpty(source, flags)
						if (!admitted && typeof r !== "string") {
							assert.equal(accepts(r, value), false, `/${source}/${flags}`)
						}
					}),
			oracle: {
				kind: "specification",
				name: "admitted text: no NUL and no lone surrogate (values/support.ts plantedFault)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/regex/match.ts",
					original:
						"\t\tcurrent = closure(nfa, next, { atStart: false, atEnd: i + 1 === n }, mark, stamp++)",
					replacement:
						"\t\tcurrent = closure(nfa, next, { atStart: false, atEnd: i + 2 === n }, mark, stamp++)",
					why: "The host NFA reads `$` one code point before the text's end; the membership and admitted text properties fail."
				},
				{
					file: "packages/engine/src/scalar/regex/match.ts",
					original: "\treturn points.every((c) => isAdmittedCodePoint(c)) ? points : undefined",
					replacement: "\treturn points",
					why: "The host NFA matches a text holding a NUL or a lone surrogate; the admitted text property fails."
				}
			]
		}
	)

/** Every claimed fact holds on the samples tautologies accept, finite languages are exactly their members, bounds bound. */
export const everyClaimedFactHoldsOnTheSamplesTautologiesAcceptFiniteLanguagesAreExactlyTheirMembersBoundsBound =
	property.explore(membershipCaseGen, {
		needs: {},
		situations: ["tautology", "finite", "bounded"] satisfies ReadonlyArray<
			Reached<"tautology" | "finite" | "bounded">
		>,
		check:
			(_, c: Case<"tautology" | "finite" | "bounded">) =>
			({ source, flags, strings }) =>
				Effect.sync(() => {
					const r = refineOrEmpty(source, flags)
					if (r === "empty" || r === "bound") {
						return
					}
					const check = r.check
					const ofPattern = jsMatcher(source, flags)
					if (check.kind === "tautology") {
						c.note("tautology")
						for (const s of strings) {
							assert.equal(ofPattern(s), true)
						}
					}
					if (check.kind === "finite") {
						c.note("finite")
						for (const m of check.members) {
							assert.equal(ofPattern(m), true)
						}
						for (const s of strings) {
							assert.equal(check.members.includes(s), ofPattern(s))
						}
						assert.equal(new Set(check.members).size, check.members.length)
					}
					const bounds = refinementBounds(r)
					if (bounds !== undefined) {
						c.note("bounded")
						for (const s of strings) {
							if (ofPattern(s)) {
								assert.ok(codePointLength(s) <= bounds.length)
								assert.ok(utf8Bytes(s) <= bounds.bytes)
							}
						}
					}
				}),
		oracle: { kind: "second-implementation", name: "ECMAScript's RegExp test (jsMatcher)" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/dfa.ts",
				original: "\t\t\tout.push(codePointsText(prefix))",
				replacement:
					"\t\t\tout.push(codePointsText(prefix))\n\t\t\tout.push(codePointsText(prefix))",
				why: "A finite language's members list each member twice; the claimed facts property fails."
			}
		]
	})

/** Every claimed fact holds on the samples equal canonical keys never disagree. */
export const everyClaimedFactHoldsOnTheSamplesEqualCanonicalKeysNeverDisagree = property.explore(
	aimed<KeyCase, KeyFeature>(keyCaseGen, [
		["distinct keys of patterns one code point apart", oneLiteralChangedGen]
	]),
	{
		needs: {},
		situations: [
			"equal keys",
			"distinct keys",
			"distinct keys of patterns one code point apart"
		] satisfies ReadonlyArray<Reached<KeyFeature>>,
		check:
			(_, c: Case<KeyFeature>) =>
			({ a, b, flags, strings, walks }) =>
				Effect.sync(() => {
					const x = refineOrEmpty(a, flags)
					const changed = analyzeText([{ source: b, flags }], testLoc)
					if (x === "empty" || x === "bound" || !changed.ok) {
						return
					}
					const y = changed.value
					if (x.key !== y.key) {
						c.note("distinct keys")
						if (oneApart(a, b)) {
							c.note("distinct keys of patterns one code point apart")
						}
						return
					}
					c.note("equal keys")
					assert.equal(x.digest, y.digest)
					const ofA = jsMatcher(a, flags)
					const ofB = jsMatcher(b, flags)
					const members = Arr.flatMap([x, y], (r) =>
						Arr.flatMap(walks, (tape) => {
							const w = walk(buildNfa(r.members[0].ir), tape, walkLength)
							return w === undefined ? [] : [w]
						})
					)
					for (const s of [...strings, ...members]) {
						assert.equal(
							ofA(s),
							ofB(s),
							`/${a}/${flags} and /${b}/${flags} on ${Formatter.format(s)}`
						)
					}
				}),
		oracle: { kind: "second-implementation", name: "ECMAScript's RegExp test (jsMatcher)" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/dfa.ts",
				original:
					"\tJSON.stringify(dfa.states.map((s) => [s.accept ? 1 : 0, s.edges.map((e) => [e.set, e.to])]))",
				replacement:
					"\tJSON.stringify(dfa.states.map((s) => [s.accept ? 1 : 0, s.edges.map((e) => e.to)]))",
				why: "A minimal DFA's key leaves out its edges' sets; the keys property fails."
			}
		]
	}
)

/** Language-equivalent spellings share one canonical key gives a finite language's pattern and the alternation of its members in any order one key, where both are keyed by their automaton. */
export const languageEquivalentSpellingsShareOneCanonicalKeyGivesAFiniteLanguagesPatternAndTheAlternationOfItsMembersInAnyOrderOneKeyWhereBothAreKeyedByTheirAutomaton =
	property.explore(twoSpellings, {
		needs: {},
		situations: [
			"one member",
			"several members",
			"the empty text a member"
		] satisfies ReadonlyArray<Reached<SpellingFeature>>,
		check:
			(_, c: Case<SpellingFeature>) =>
			({ language, members, count, withEmpty }) =>
				Effect.sync(() => {
					c.note(count === 1 ? "one member" : "several members")
					if (withEmpty) {
						c.note("the empty text a member")
					}
					const label = `/${language.source}/${language.flags} and /${members.source}/${members.flags}`
					assert.ok(count <= spelledMembers, `${label}: a language drawn within its budget`)
					const spellings = [
						analyzeText([language], testLoc),
						analyzeText([members], testLoc)
					] as const
					const [byLanguage, byMembers] = spellings
					if (!byLanguage.ok || !byMembers.ok) {
						for (const spelling of spellings) {
							if (!spelling.ok) {
								assert.equal(spelling.error.reason._tag, "ResourceBound", label)
							}
						}
						c.note("a spelling past the analysis bounds")
						return
					}
					if (keyedByIr(byLanguage.value.key) || keyedByIr(byMembers.value.key)) {
						c.note("a spelling past the analysis bounds")
						return
					}
					assert.equal(byLanguage.value.key, byMembers.value.key, label)
				}),
		oracle: {
			kind: "specification",
			name: "a finite language's members, which its pattern's construction gives"
		},
		kept: [],
		kills: []
	})
