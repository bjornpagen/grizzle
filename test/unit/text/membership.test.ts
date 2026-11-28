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
 * - Work: a matcher's work over a text is linear in it, whatever the pattern, a pattern a backtracker takes exponentially
 *   many steps over among them, and a text it read is read again for nothing: each pattern's search language is
 *   determinized where texts reach it and kept (scalar/regex/match.ts Matcher).
 *
 * Oracle: ECMAScript's RegExp test (test/support/regex.ts jsMatcher), which appears only here, never under src/; for the
 * spellings, the finite language's members its construction gives; for the work, its bound, the subset construction's
 * charge (scalar/regex/subset.ts Step), counted, never timed.
 *
 * Features: each family pattern accepting and refusing; admitted, empty and a witness; live text and each plant in the
 * middle; a tautology, a finite language and a bound; equal and distinct keys, distinct keys of patterns one code point
 * apart among them; one member, several, the empty text; a written pattern a backtracker takes exponentially many steps
 * over and a drawn one of nested quantifiers, each over a text it matches, one it refuses and one of over a thousand code
 * points.
 */

import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa, configurationsOf } from "@bjornpagen/grizzle-text/regex/nfa"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { analyzeText } from "#compiler/text/refinement.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { refinementBounds } from "#test/support/text.ts"
import { walk, walkLength } from "#test/support/unit/text/generators.ts"
import {
	plantedFault,
	type PlantedFeature,
	plantedFeature,
	plantedTextGen,
	plantedValue
} from "#test/support/unit/values/support.ts"
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
	runLengths,
	spelledMembers,
	type SpellingFeature,
	tautologies,
	twoSpellings,
	utf8Bytes,
	workCaseGen,
	type WorkFeature
} from "#test/unit/text/membership.fixtures.ts"

/** Host NFA membership equals ECMAScript on the handwritten family patterns, over their families' strings and walks of their own NFA, every pattern accepting and refusing. Its budget is its suite's before it was a property (test/unit/text/membership.test.ts at 4ca3036a): 6000 runs and 6000 steered cases. */
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
			budget: { runs: 6000, steered: 6000 },
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
					file: "packages/text/src/regex/subset.ts",
					original:
						"[this.#configs.plain(this.nfa.start), ...targets], {\n\t\t\tatStart: false,\n\t\t\tatEnd: false",
					replacement:
						"[this.#configs.plain(this.nfa.start), ...targets], {\n\t\t\tatStart: false,\n\t\t\tatEnd: true",
					why: "The host's search reads `$` as holding past every code point, not only at the text's end; the membership properties fail."
				}
			]
		}
	)

/** Host NFA membership equals ECMAScript on generated patterns. Its budget is its suite's before it was a property (test/unit/text/membership.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const hostNFAMembershipEqualsECMAScriptOnGeneratedPatterns = property.explore(
	patternSketchGen,
	{
		needs: {},
		budget: { runs: 2000, steered: 2000 },
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
				file: "packages/text/src/regex/subset.ts",
				original: "[this.#configs.plain(this.nfa.start), ...targets], {",
				replacement: "targets, {",
				why: "The host's search goes on only from the paths it is on, never starting a match again at a later code point while one is under way; the membership property fails."
			},
			{
				file: "packages/text/src/regex/subset.ts",
				original:
					"[this.#configs.plain(this.nfa.start), ...targets], {\n\t\t\tatStart: false,\n\t\t\tatEnd: false",
				replacement:
					"[this.#configs.plain(this.nfa.start), ...targets], {\n\t\t\tatStart: false,\n\t\t\tatEnd: true",
				why: "The host's search reads `$` as holding past every code point, not only at the text's end; the membership properties fail."
			}
		]
	}
)

/** Host NFA membership equals ECMAScript accepts no string that is not admitted text, under every family's patterns, and the tautology every admitted one. Its budget is its suite's before it was a property (test/unit/text/membership.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const hostNFAMembershipEqualsECMAScriptAcceptsNoStringThatIsNotAdmittedTextUnderEveryFamilysPatternsAndTheTautologyEveryAdmittedOne =
	property.explore(
		(source) => [source.draw(plantedTextGen), source.draw(element(familyPatterns))] as const,
		{
			needs: {},
			budget: { runs: 1000, steered: 1000 },
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
					file: "packages/text/src/regex/match.ts",
					original:
						"\t\t\tif (atom === undefined) {\n\t\t\t\treturn false\n\t\t\t}\n\t\t\tstate = this.#step(state, atom)",
					replacement: "\t\t\tstate = atom === undefined ? state : this.#step(state, atom)",
					why: "The host's matcher reads a NUL or a lone surrogate as no code point, so it matches a text holding one; the admitted text property fails."
				}
			]
		}
	)

/** Every claimed fact holds on the samples tautologies accept, finite languages are exactly their members, bounds bound. Its budget is its suite's before it was a property (test/unit/text/membership.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const everyClaimedFactHoldsOnTheSamplesTautologiesAcceptFiniteLanguagesAreExactlyTheirMembersBoundsBound =
	property.explore(membershipCaseGen, {
		needs: {},
		budget: { runs: 2000, steered: 2000 },
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
				file: "packages/text/src/regex/dfa.ts",
				original: "\t\t\tout.push(codePointsText(prefix))",
				replacement:
					"\t\t\tout.push(codePointsText(prefix))\n\t\t\tout.push(codePointsText(prefix))",
				why: "A finite language's members list each member twice; the claimed facts property fails."
			}
		]
	})

/** Every claimed fact holds on the samples equal canonical keys never disagree. Its budget is its suite's before it was a property (test/unit/text/membership.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const everyClaimedFactHoldsOnTheSamplesEqualCanonicalKeysNeverDisagree = property.explore(
	aimed<KeyCase, KeyFeature>(keyCaseGen, [
		["distinct keys of patterns one code point apart", oneLiteralChangedGen]
	]),
	{
		needs: {},
		budget: { runs: 2000, steered: 2000 },
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
				file: "packages/text/src/regex/dfa.ts",
				original:
					"\tJSON.stringify(dfa.states.map((s) => [s.accept ? 1 : 0, s.edges.map((e) => [e.set, e.to])]))",
				replacement:
					"\tJSON.stringify(dfa.states.map((s) => [s.accept ? 1 : 0, s.edges.map((e) => e.to)]))",
				why: "A minimal DFA's key leaves out its edges' sets; the keys property fails."
			}
		]
	}
)

/** Language-equivalent spellings share one canonical key gives a finite language's pattern and the alternation of its members in any order one key, where both are keyed by their automaton. Its budget is its suite's before it was a property (test/unit/text/membership.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const languageEquivalentSpellingsShareOneCanonicalKeyGivesAFiniteLanguagesPatternAndTheAlternationOfItsMembersInAnyOrderOneKeyWhereBothAreKeyedByTheirAutomaton =
	property.explore(twoSpellings, {
		needs: {},
		budget: { runs: 400, steered: 400 },
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
		kills: [
			{
				file: "packages/engine/src/scalar/compute/types.ts",
				original:
					"a === undefined || b === undefined ? a === b : compatible(a.endpoint, b.endpoint)",
				replacement: "false",
				why: "Operator mutant 8ab20ec726 at packages/engine/src/scalar/compute/types.ts:231 in sameEndpoint: `a === undefined || b === undefined ? a === b : compatible(a.endpoint, b.endpoint)` becomes `false`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/**
 * A matcher's work over a text is linear in the text and a text read again costs nothing: over runs of `a` doubling in
 * length and a last code point, each read by a matcher of its own, the work a matcher is charged (Matcher.spent) is at
 * most its initial subset's and, for each code point, one transition's, which reads a subset and reaches one, each at
 * most the configurations the NFA's counters let its states take (nfa.ts configurationsOf); reading the text again
 * charges none. Its budget is the runner's default.
 */
export const aMatchersWorkOverATextIsLinearInTheTextWhateverThePatternAndATextReadAgainCostsNothing =
	property.explore(workCaseGen, {
		needs: {},
		situations: [
			"a written pattern a backtracker takes exponentially many steps over",
			"a drawn pattern of nested quantifiers",
			"a text it matches",
			"a text it refuses",
			"a text of over a thousand code points"
		] satisfies ReadonlyArray<Reached<WorkFeature>>,
		check:
			(_, c: Case<WorkFeature>) =>
			({ source, drawn, last }) =>
				Effect.sync(() => {
					const r = refineOrEmpty(source, "u")
					if (typeof r === "string") {
						assert.ok(drawn, `/${source}/u, written by hand, is admitted with a member`)
						return
					}
					c.note(
						drawn
							? "a drawn pattern of nested quantifiers"
							: "a written pattern a backtracker takes exponentially many steps over"
					)
					const nfa = buildNfa(r.members[0].ir)
					const states = configurationsOf(nfa)
					for (const n of runLengths) {
						const text = `${Str.repeat(n)("a")}${last}`
						const length = codePointLength(text)
						const matcher = Matcher.of(nfa)
						const initial = matcher.spent
						const matched = matcher.matches(text)
						const spent = matcher.spent
						const label = `/${source}/u over ${length} code points`
						assert.ok(initial <= states, `${label}: the initial subset charged ${initial}`)
						assert.ok(
							spent - initial <= length * 2 * states,
							`${label}: charged ${spent - initial}, past ${length} transitions of at most ${2 * states} each`
						)
						assert.equal(matcher.matches(text), matched, `${label}: read again alike`)
						assert.equal(matcher.spent, spent, `${label}: read again for nothing`)
						c.note(matched ? "a text it matches" : "a text it refuses")
						if (length > 1000) {
							c.note("a text of over a thousand code points")
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the subset construction's charge, linear in the text: a transition a code point, each at most twice the configurations the NFA's states take"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/match.ts",
				original: "\tmatches(value: string): boolean {\n\t\tlet state = 0\n",
				replacement:
					'\tmatches(value: string): boolean {\n\t\tconst points = Array.from(value, (p) => p.codePointAt(0) ?? 0)\n\t\tconst tried = (s: number, i: number): boolean => {\n\t\t\tthis.#spent += 1\n\t\t\treturn s === this.nfa.accept || entry(this.nfa.edges, s).some((e) => e.kind === "eps" ? tried(e.to, i) : e.kind === "start" ? i === 0 && tried(e.to, i) : e.kind === "end" ? i === points.length && tried(e.to, i) : i < points.length && e.set.some(([lo, hi]) => lo <= entry(points, i) && entry(points, i) <= hi) && tried(e.to, i + 1))\n\t\t}\n\t\tif (points.some((_, i) => tried(this.nfa.start, i)) || tried(this.nfa.start, points.length)) {\n\t\t\treturn true\n\t\t}\n\t\tlet state = 0\n',
				why: "A backtracking matcher, which tries every path of the NFA from every position: its work over a run of `a`s a pattern's alternation or nested repetition reads two ways doubles with each `a`, past the linear bound at a short run."
			},
			{
				file: "packages/text/src/regex/match.ts",
				original: "\t\tfrom.next[atom] = target\n",
				replacement: "",
				why: "A matcher keeps no transition it built, so every code point of every text builds its transition again, as a matcher compiled per call would: reading a text again charges its transitions again."
			}
		]
	})
