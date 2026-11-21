/**
 * Navigation's work over a chain of unions is linear in its depth (analysis/theory/navigate.ts): each level of the
 * chain navigated once for each set of values its rules read it at (Interned `navigated`), and whether a rule over the
 * unions below it joins read off their rules once each (`RuleReads`, Interned `reads`) without distributing it into
 * its conjunctions, where a chain sixteen deep took 28 s (GENMEM's handover): each level's two rules each navigated
 * the level below again, and a rule over the unions below it was distributed into one conjunction for each choice of a
 * rule at every level, to learn whether one of them joins. The work is counted, never timed (test/support/kernel/
 * calls.ts): every call of navigation's functions.
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
				original: "\t\t\tif (!splits(rule) || !someConjunctionJoins(interned.reads(rule))) {",
				replacement:
					"\t\t\tif (!splits(rule) || !conjunctions([rule], columns).some((conjunction) => joins(interned.reads(conjunction)))) {",
				why: "Whether a rule over a union joins is asked of its conjunctions, as before: the rule is distributed into one conjunction for each choice of a rule at every level below it, each level's union of two rules doubling them, so a chain each rule of which reads the level below once, where none joins, builds every one; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst known = this.#navigations.get(identity)",
				replacement: "\t\tconst known = undefined",
				why: "Every read of a level navigates it again, as before: each level's two rules each navigate the level below, so a chain d deep navigates its leaf two to the d times; the property fails."
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
