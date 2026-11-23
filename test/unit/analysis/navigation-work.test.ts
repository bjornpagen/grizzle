/**
 * Navigation's work over a chain of unions is linear in its depth (analysis/theory/navigate.ts): each level of the
 * chain navigated once for each set of values its rules read it at (Navigation `navigated`), and whether a rule over the
 * unions below it joins read off their rules once each (`RuleReads`, Navigation `reads`) without distributing it into
 * its conjunctions, where a chain sixteen deep took 28 s (GENMEM's handover): each level's two rules each navigated
 * the level below again, and a rule over the unions below it was distributed into one conjunction for each choice of a
 * rule at every level, to learn whether one of them joins. The work is counted, never timed (test/support/kernel/
 * calls.ts): every call of navigation's functions.
 *
 * Navigation's digesting of what it reads is linear in the depth too: every identity and import key navigation asks is
 * digested in the Descriptions' one set of identity digests (ir/desc.ts descIdentities), each query frozen before it is
 * digested, so each part of a query, the ones navigation builds among them, is digested once, where each identity and
 * key digested its query anew and every level digested the whole chain below it again. Its work is the calls of the
 * identity digests' functions (core/fingerprint.ts), the declared queries' parts digested before the count begins.
 *
 * Oracle: linearity, read off the chain: every level over a union is alike, so each costs navigation what the third
 * level added to the second.
 *
 * Features: a level reading the one below once and twice; a chain read whole and at a document; a chain sixteen deep.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	chainGen,
	digestedChain,
	judgedChain,
	type Reached
} from "#test/unit/analysis/navigation-work.fixtures.ts"

const situations = [
	"a level reading the one below once",
	"a level reading the one below twice",
	"a chain read whole",
	"a chain read at a document",
	"a chain sixteen deep"
] as const satisfies ReadonlyArray<ReachedOf<Reached>>

const box =
	"every chain of unions one to sixteen deep over Node, each level two rules reading the level below once or twice, read whole or at one document"

/** Navigating a chain of unions works what two levels of it do and, for each level more, what the third added, however deep it is. */
export const navigatingAChainOfUnionsWorksOnceALevelHoweverDeepTheChain = property.exhaust(
	finite(chainGen),
	{
		needs: {},
		situations,
		check: (_, c: Case<Reached>) => (chain) => judgedChain(chain, c.note),
		oracle: {
			kind: "universal",
			name: "linearity: the calls of navigation's functions over a chain d deep are its two levels' and d − 2 times what the third level added"
		},
		box,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst known = this.#navigations.get(identity)",
				replacement: "\t\tconst known = undefined",
				why: "Every read of a level navigates it again, as before: each level's two rules each navigate the level below, so a chain d deep navigates its leaf two to the d times; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst known = this.#overSteps.get(rule)",
				replacement: "\t\tconst known = undefined",
				why: "Whether a rule reads a chain of steps is asked again at every read of it, as 8e6462c59 had it (Navigation `overSteps`): the walk down each level's import of a union takes both of its rules, so a chain each rule of which reads the level below once is walked twice for each level more, 2^d; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst known = this.#reads.get(rule)",
				replacement: "\t\tconst known = undefined",
				why: "Each read of a union reads its rules again, as before: whether a rule over the unions below it joins walks each union's two rules at every read of it, every level once for every path down the chain to it; the property fails."
			}
		]
	}
)

/**
 * Navigating a chain of unions digests what two levels of it do and, for each level more, what the third added, however
 * deep it is: each part of what it reads digested once for the statement's navigation.
 */
export const navigatingAChainOfUnionsDigestsEachPartOnceHoweverDeepTheChain = property.exhaust(
	finite(chainGen),
	{
		needs: {},
		situations,
		check: (_, c: Case<Reached>) => (chain) => digestedChain(chain, c.note),
		oracle: {
			kind: "universal",
			name: "linearity: the calls of the identity digests' functions over a chain d deep are its two levels' and d − 2 times what the third level added"
		},
		box,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst identity = descIdentity(deepFreeze(query))",
				replacement: "\t\tconst identity = descIdentity(query)",
				why: "A navigated query is digested as navigation built it, unfrozen, so no token of a part it built is kept past the one identity: every level's identity digests the whole chain below it again; the property fails."
			}
		]
	}
)
