/**
 * The whole subset construction of a pattern and its minimization (scalar/regex/dfa.ts minimalDfa), the canonical DFA
 * every language proof and every pattern value's key reads (ir/pattern.ts admitSpelling), on alternations of words over
 * a wide alphabet, the shape of edullm's QTI schema's closed pattern values (KindByNameUnder, its names under their
 * namespaces), whose admission was 40% of its schema's compile (PANTRY-WRITERS' profile at grizzle 0194f0805).
 *
 * - Work: the construction reads each state's row whole (subset.ts SearchSubsets targets) and keys each of its distinct
 *   steps once, the step to its restart closure and one for each atom it steps on elsewhere, where the construction
 *   atom by atom keyed a target for every atom of every state; and it makes the states and is charged the work the
 *   atom-by-atom construction makes and is charged, so its limits cut where they cut. The keys are counted by V8's
 *   precise coverage (kernel/calls.ts callCounts): work, never time.
 * - Minimization: the canonical DFA of an alternation of words holds exactly its words, one state for each distinct
 *   right language of a prefix of a word (Myhill–Nerode), the minimization of its live states (dfa.ts liveClasses) the
 *   coarsest partition the transitions respect.
 *
 * Oracle: the construction atom by atom, as it ran at 0624a312c (construction.fixtures.ts atomByAtom), a second
 * implementation over the same subsets; the words themselves for the language and their right languages for its
 * states, the specification.
 *
 * Features: a flat alternation and words under prefixes; a word another word extends.
 */

import { membersWithin, minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import { buildNfa, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	type Alternation,
	alternationsGen,
	atomByAtom,
	rightLanguages,
	someWordExtendsAnother,
	sourceOf,
	wordsOf
} from "#test/unit/text/construction.fixtures.ts"

type Situation = "a flat alternation" | "words under prefixes" | "a word another word extends"

/** An alternation's NFA, its pattern parsed under the flags "u", which every drawn alternation's pattern parses. */
const nfaOf = (alternation: Alternation): Nfa => {
	const parsed = parsePattern(sourceOf(alternation), "u")
	assert.ok(parsed.ok, `${sourceOf(alternation)} parses`)
	return buildNfa(parsed.value)
}

/** The situations an alternation reaches. */
const noteAlternation = (c: Case<Situation>, alternation: Alternation): void => {
	c.note(
		Arr.some(alternation.groups, (g) => g.prefix !== "")
			? "words under prefixes"
			: "a flat alternation"
	)
	if (someWordExtendsAnother(wordsOf(alternation))) {
		c.note("a word another word extends")
	}
}

/** The whole construction keys each state's distinct steps once, and makes and is charged what the construction atom by atom makes and is charged. */
export const theWholeConstructionKeysEachStatesDistinctStepsOnceAndSpendsWhatTheConstructionAtomByAtomSpends =
	property.explore(alternationsGen, {
		needs: {},
		situations: [
			"a flat alternation",
			"words under prefixes",
			"a word another word extends"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (alternations) =>
			Effect.gen(function* () {
				for (const alternation of alternations) {
					noteAlternation(c, alternation)
					const nfa = nfaOf(alternation)
					const [outcome, counts] = yield* callCounts(
						Effect.sync(() => minimalDfa(nfa, regexDfaLimits)),
						{ keys: { file: "packages/text/src/regex/subset.ts", name: "subsetKey" } }
					)
					const atomic = atomByAtom(nfa)
					const label = sourceOf(alternation)
					assert.equal(outcome.kind, "minimal", `${label}: within the limits`)
					assert.deepEqual(
						outcome.spent,
						{ states: atomic.states, work: atomic.work },
						`${label}: the states and the work of the construction atom by atom`
					)
					assert.ok(
						counts.keys <= atomic.keys,
						`${label}: ${counts.keys} subset keys, at most ${atomic.keys}, one for each state's distinct steps, where atom by atom keys every atom of every state`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the subset construction atom by atom, as dfa.ts determinize ran it at 0624a312c (construction.fixtures.ts atomByAtom)"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/dfa.ts",
				original: "\t\t\tconst target = known >= 0 ? known : intern(step.to)\n",
				replacement: "\t\t\tconst target = intern(step.to)\n",
				why: "The construction interns the target of every atom of every state, keying its subset each time, as it did atom by atom; the keys are the states times the atoms, and the property fails."
			},
			{
				file: "packages/text/src/regex/subset.ts",
				original: "\t\t\tconst known = cell(stepOfGroup, group)\n",
				replacement: "\t\t\tconst known = -1\n",
				why: "Each atom of a state takes a step of its own, its closure taken and its subset keyed, where the atoms its set edges hold alike shared one; the keys are the states times the atoms, and the property fails."
			}
		]
	})

/** The canonical DFA of an alternation of words holds exactly its words, in one state for each distinct right language of a prefix of a word. */
export const theCanonicalDfaOfAnAlternationOfWordsHoldsExactlyItsWordsInOneStatePerRightLanguage =
	property.explore(alternationsGen, {
		needs: {},
		situations: [
			"a flat alternation",
			"words under prefixes",
			"a word another word extends"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (alternations) =>
			Effect.sync(() => {
				for (const alternation of alternations) {
					noteAlternation(c, alternation)
					const words = wordsOf(alternation)
					const label = sourceOf(alternation)
					const outcome = minimalDfa(nfaOf(alternation), regexDfaLimits)
					assert.ok(outcome.kind === "minimal", `${label}: within the limits`)
					assert.deepEqual(
						membersWithin(outcome.dfa, 0, Number.MAX_SAFE_INTEGER),
						Arr.sort(words, Order.String),
						`${label}: exactly its words`
					)
					assert.equal(
						outcome.dfa.states.length,
						rightLanguages(words),
						`${label}: one state for each distinct right language of a prefix of a word`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the drawn words, and the distinct right languages of their prefixes (Myhill–Nerode)"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/dfa.ts",
				original: "\t\tthis.#marked[s] = at(this.#marked, s) + 1",
				replacement: "\t\tthis.#marked[s] = at(this.#marked, s) + 2",
				why: "A mark counts each marked element twice, so a split cuts its set past its marked elements and moves unmarked states with them; the classes are no longer the language equivalence, and the property fails."
			},
			{
				file: "packages/text/src/regex/dfa.ts",
				original: "\t\t\tcords.split()\n",
				replacement: "",
				why: "The cords are never split by the blocks their transitions enter, so a cord splits the states only by the atom they step on; states of different right languages stay one class, and the property fails."
			}
		]
	})
