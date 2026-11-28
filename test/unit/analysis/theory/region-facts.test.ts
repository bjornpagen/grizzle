/**
 * A whole rule's region reads the containments the schema states, and those they compose to (analysis/theory/unit.ts
 * regionFactsOf), as facts of every committed state: a proof that an occurrence's gained rows open a fact only where
 * they replace a row rests on each (unit.ts proofsOf), so each must hold wherever the schema's laws do.
 *
 * The box: four relations A to D of naturals k, x and y, each keyed by k or by (k, x); one to five containments
 * between two of them, each of one or two pairs, a field of one side paired with any field of the other, a source term a field or its predecessor, either side selected by a
 * field at a value or among two, or not at all; at most one counted family of one under another; and at most a tree T
 * over itself, rooted at k; and at most a derived relation V(k, x) of one or two rules, each matching one of them at
 * two of its fields, with one or two containments into it. Each case draws three instances: rows of each relation, each statement's containment then
 * made to hold by adding the target rows it misses.
 *
 * Oracle: the laws themselves. Each instance holds every containment law the theory states, as its violation query
 * reads it under the reference evaluator (test/support/oracle/reference), so it is a state every law of containment
 * holds in, and each region fact must hold of it: every row of the fact's source its selection admits meets a row of
 * its target at every pair.
 *
 * Features: a stated containment read at its pairs; a composition, one projected onto the pairs its first containment
 * reaches, one carrying its first's selection and one of three containments, a chain the closure follows to its end; a
 * family's group into its owner's key; a tree's parent into its starts; a derived relation into the relation its every
 * rule reads; and a containment into a derived relation composed into a relation it reads.
 *
 * The closure's work, counted, never timed (kernel/calls.ts callCounts): the theory of k disjoint copies of a box
 * (region-facts.fixtures.ts schemaOfCopies) compares values canonically and tries compositions as each copy's theory
 * alone does, summed, a containment held compared only with those alike at its relations and pairs, and composed only with the stated
 * containments out of its target; and a box's theory with its laws' violation queries makes its region facts once.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { callCounts } from "#test/support/kernel/calls.ts"
import { theoryOf } from "#test/support/unit/analysis/theory/support.ts"
import {
	type Box,
	boxGen,
	breaches,
	containmentsHold,
	type Feature,
	featureOf,
	type Instance,
	instanceGen,
	schemaOfBox,
	schemaOfCopies
} from "#test/unit/analysis/theory/region-facts.fixtures.ts"

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
			"a derived relation into the relation its every rule reads",
			"a containment into a derived relation composed into a relation it reads",
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
						const missed = breaches(drawn.box, instance, fact)
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
				original: "\t\tconst pairs = rest.reduce(",
				replacement: "\t\tconst pairs = [].reduce(",
				why: "A derived relation is read into the relation its first rule matches, as if every rule did, so a row of V a second rule derives from another relation is said to stand in the first's, which an instance refutes."
			},
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

/**
 * The closure's work (analysis/theory/unit.ts regionFactsOf): a pair of values canonical equality compares
 * (core/canonical.ts memberPairs), and a composition tried (unit.ts composed).
 */
const closureWork = Object.freeze({
	compared: { file: "packages/engine/src/core/canonical.ts", name: "memberPairs" },
	composed: { file: "packages/engine/src/analysis/theory/unit.ts", name: "composed" }
})

/** What a box's theory reaches of the counted work: a canonical comparison, and a composition tried. */
type ClosureWork = "a canonical comparison" | "a composition"

/**
 * The theory of disjoint copies of a box does the closure's work once per copy: over k copies of a box, k = 1, 2 and 3
 * (region-facts.fixtures.ts schemaOfCopies), the theory's canonical comparisons and the compositions its closure tries
 * (closureWork) are each the sum of those of each copy's theory alone, where a containment compared with every one held,
 * or composed with every one stated, does work across the copies, in k². A copy's work is its own: its statements stand
 * in the order of their identity digests (schema/own.ts), so a copy's containments are tried in an order of their own,
 * and two copies of one box may each do the work of the order they stand in; the sum is exact, the counts of any two
 * copies need not agree, so the work is linear in k without being the same for each copy.
 */
export const theTheoryOfDisjointCopiesOfABoxComparesAndComposesOnceForEachCopyAsEachCopyAlone =
	property.explore(boxGen, {
		needs: {},
		situations: ["a canonical comparison", "a composition"] satisfies ReadonlyArray<
			Reached<ClosureWork>
		>,
		check: (_, k: Case<ClosureWork>) => (box) =>
			Effect.gen(function* () {
				const countsOf = (suffixes: Arr.NonEmptyReadonlyArray<string>) =>
					Effect.map(
						callCounts(
							Effect.sync(() => theoryOf(schemaOfCopies(box, suffixes))),
							closureWork
						),
						([, counts]) => counts
					)
				const alone = yield* Effect.forEach(["_1", "_2", "_3"] as const, (suffix) =>
					countsOf([suffix])
				)
				for (const suffixes of [["_1"], ["_1", "_2"], ["_1", "_2", "_3"]] as const) {
					const together = yield* countsOf(suffixes)
					const copies = suffixes.length
					const each = Arr.take(alone, copies)
					assert.deepEqual(
						together,
						{
							compared: Arr.reduce(each, 0, (n, c) => n + c.compared),
							composed: Arr.reduce(each, 0, (n, c) => n + c.composed)
						},
						`${copies} copies: the theory's work is each copy's alone, summed`
					)
				}
				const [first] = alone
				if (first.compared > 0) {
					k.note("a canonical comparison")
				}
				if (first.composed > 0) {
					k.note("a composition")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the closure's comparisons and compositions, counted (kernel/calls.ts callCounts), over k copies the sum of each copy's alone"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tif (alike.some((held) => canonicalEquals(held, c))) {",
				replacement: "\t\tif (containments.some((held) => canonicalEquals(held, c))) {",
				why: "A containment is compared with every one held, each copy's with every other copy's, so the comparisons over copies pass the sum of each copy's alone, growing as k² (a fresh qti-database generate, 896 statements, spent 152.9 s of its 326 s profile in the closure)."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tfor (const second of everyRowOf.get(first.to) ?? []) {",
				replacement: "\t\tfor (const second of stated) {",
				why: "A containment held is composed with every one stated, each copy's with every other copy's, so the compositions tried over copies pass the sum of each copy's alone, growing as k²."
			}
		]
	})

/** The calls a theory's closure is counted by: its region facts made (analysis/theory/unit.ts regionFactsOf). */
const closures = Object.freeze({
	made: { file: "packages/engine/src/analysis/theory/unit.ts", name: "regionFactsOf" }
})

/** Whether a box's theory holds a region fact. */
type Held = "a region fact" | "no region fact"

/**
 * A schema's theory and its laws' violation queries make its region facts once: the theory makes them where it is built
 * (theory.ts buildTheory), and the violation queries' writer resolves its laws' sides in the sides' environment alone
 * (theory.ts lawSides), which holds none, so a box's theory built and its violation queries written (support.ts
 * theoryOf) make its closure exactly once.
 */
export const aSchemasTheoryAndItsLawsViolationQueriesMakeItsRegionFactsOnce = property.explore(
	boxGen,
	{
		needs: {},
		situations: ["a region fact", "no region fact"] satisfies ReadonlyArray<Reached<Held>>,
		check: (_, k: Case<Held>) => (box) =>
			Effect.gen(function* () {
				const [t, counts] = yield* callCounts(
					Effect.sync(() => theoryOf(schemaOfBox(box))),
					closures
				)
				k.note(t.regionFacts.containments.length > 0 ? "a region fact" : "no region fact")
				assert.equal(
					counts.made,
					1,
					"a box's theory and its laws' violation queries make its region facts once"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the theory's closures, counted (kernel/calls.ts callCounts), one per statement set"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original:
					"export const lawSides = (checked: CheckedSchema): LawSides => new LawSides(sidesEnvOf(checked))",
				replacement:
					"export const lawSides = (checked: CheckedSchema): LawSides => new LawSides(new Builder(checked).env())",
				why: "The violation queries' writer resolves its laws' sides in a theory builder's whole environment, as lawSides did, which makes the region facts again: a fresh qti-database generate made its target's closure twice, once for its law model and once for its law checks."
			}
		]
	}
)
