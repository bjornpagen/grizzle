/**
 * A whole rule's region reads the containments the schema states, and those they compose to (analysis/theory/unit.ts
 * regionFactsOf), as facts of every committed state: a proof that an occurrence's gained rows open a fact only where
 * they replace a row rests on each (unit.ts proofsOf), so each must hold wherever the schema's laws do.
 *
 * The box: four relations A to D of naturals k, x and y, each keyed by k or by (k, x); one to five containments
 * between two of them, each of one or two pairs, a field of one side paired with any field of the other, a source term a field or its predecessor, either side selected by a
 * field at a value or among two, or not at all; at most one counted family of one under another; and at most a tree T
 * over itself, rooted at k. Each case draws three instances: rows of each relation, each statement's containment then
 * made to hold by adding the target rows it misses.
 *
 * Oracle: the laws themselves. Each instance holds every containment law the theory states, as its violation query
 * reads it under the reference evaluator (test/support/oracle/reference), so it is a state every law of containment
 * holds in, and each region fact must hold of it: every row of the fact's source its selection admits meets a row of
 * its target at every pair.
 *
 * Features: a stated containment read at its pairs; a composition, one projected onto the pairs its first containment
 * reaches, one carrying its first's selection and one of three containments, a chain the closure follows to its end; a
 * family's group into its owner's key; and a tree's parent into its starts.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	type Box,
	boxGen,
	breaches,
	containmentsHold,
	type Feature,
	featureOf,
	type Instance,
	instanceGen,
	schemaOfBox
} from "#test/unit/analysis/theory/region-facts.fixtures.ts"
import { theoryOf } from "#test/unit/analysis/theory/support.ts"

/** A box's schema and three instances drawn over it, those its containments could all be made to hold over. */
const caseGen: Gen<{ readonly box: Box; readonly instances: ReadonlyArray<Instance> }> = (s) => {
	const box = s.draw(boxGen)
	return {
		box,
		instances: Arr.flatMap(s.draw(array(instanceGen(box), { min: 3, max: 3 })), (i) =>
			i === undefined ? [] : [i]
		)
	}
}

/**
 * Every containment a whole rule's region reads holds in every state the schema's containment laws hold in.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const everyContainmentAWholeRulesRegionReadsHoldsInEveryStateTheSchemasContainmentLawsHoldIn =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a stated containment",
			"a composition",
			"a composition projected onto the pairs its first reaches",
			"a composition carrying its first's selection",
			"a composition of three containments",
			"a family's group into its owner's key",
			"a tree's parent into its starts"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (drawn) =>
			Effect.sync(() => {
				const t = theoryOf(schemaOfBox(drawn.box))
				const facts = t.regionFacts.containments
				for (const fact of facts) {
					k.note(featureOf(drawn.box, fact))
				}
				for (const instance of drawn.instances) {
					assert.ok(
						containmentsHold(t, instance),
						`the instance holds every containment law: ${Formatter.format(instance)}`
					)
					for (const fact of facts) {
						const missed = breaches(instance, fact)
						assert.equal(
							missed.length,
							0,
							`${Formatter.format(fact)} holds of every row of ${fact.from} it admits, but not of ${Formatter.format(missed)} in ${Formatter.format(instance)}`
						)
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "every containment law, as the reference evaluator reads its violation query, holding over each instance; each region fact holding there"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tfor (let at = 0; at < containments.length; at++) {",
				replacement: "\tfor (let at = 0; at < stated.length; at++) {",
				why: "The closure composes only a stated containment with another, one step, so a chain of three stated containments composes no fact of its ends, and that situation is never reached."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\tisNonEmpty(pairs) &&\n\t\t\t\tpairs.length === s.pairs.length",
				replacement: "\t\t\t\tisNonEmpty(pairs)",
				why: "A stated containment with a pred term is read at its field pairs alone, as if it held of every row its selection admits, where it holds only of those whose predecessor is defined, so a row whose field is 0 breaks the fact."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\treturn from === undefined ? [] : [{ from: from.from, to: p.to }]",
				replacement:
					"\t\treturn from === undefined ? [{ from: p.from, to: p.to }] : [{ from: from.from, to: p.to }]",
				why: "A composition keeps a pair of its second containment its first reaches no field of, as if the first's source held the middle relation's field of that name, so it states that a row of E holds at that field a value of N's it need not hold, which an instance refutes."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t? { from: first.from, to: second.to, pairs, selection: first.selection }",
				replacement: "\t\t? { from: first.from, to: second.to, pairs, selection: [] }",
				why: "A composition holds of every row of E, where its first containment holds only of the rows of E its selection admits, so a row it refuses breaks the composed fact."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\treturn isNonEmpty(pairs)\n\t\t? { from: first.from, to: second.to, pairs, selection: first.selection }",
				replacement:
					"\treturn isNonEmpty(pairs) && pairs.length === second.pairs.length\n\t\t? { from: first.from, to: second.to, pairs, selection: first.selection }",
				why: "A composition holds only where its first containment reaches every pair of its second, so no composition is projected onto the pairs its first reaches, and that situation is never reached."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\tconst term = group[j]",
				replacement: "\t\t\t\tconst term = group[group.length - 1 - j]",
				why: "A family's group is paired with its owner's key from the other end, so a group of two fields holds its first at the key's last, which an instance whose two values differ refutes."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\t\t\t\t...s.member.terms.slice(0, 1)",
				replacement: "\t\t\t\t\t\t\t...s.member.terms.slice(1, 2)",
				why: "A tree's member is paired with its starts at its index in place of its parent, so a member's index is said to be some row's start, which an instance refutes."
			}
		]
	})
