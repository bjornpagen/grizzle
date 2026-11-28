/**
 * The tree theorem through the theory (trees.md §2, w4-w7 §2.2) for a tree keyed by its root field and its start: a
 * tree's law, its family's lemmas over every row but its roots and T2 to T6 with the root pin, beside its relation's
 * primary key (r, start), evaluated by the reference evaluator, is violated exactly on the states that are not, for
 * each value of the root field, one tree with pre-order intervals. The oracle is a direct pre-order numbering
 * (test/support/families/tree.ts lawful); the box is every forest of at most four rows over two root values, and every
 * single mutation of one field in range, which holds a row under another tree, a parent after its child and a second
 * root.
 *
 * Features: lawful forests, and each mutation kind's verdict.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { lawful } from "#test/support/families/tree.ts"
import {
	type HostFacts,
	lawOfShape,
	uuidOf,
	violates
} from "#test/support/unit/analysis/theory/support.ts"
import {
	namedOf,
	rOf,
	rowsOf,
	structureOf,
	t,
	type TreeFeature,
	treeState
} from "#test/unit/analysis/theory/tree.fixtures.ts"

/** A tree's law is violated exactly when the rows of some r are no one tree with pre-order intervals. */
export const aTreesLawIsViolatedExactlyWhenTheRowsOfSomeRAreNoOneTreeWithPreOrderIntervals =
	property.exhaust(finite(treeState), {
		needs: {},
		situations: [
			"lawful",
			"unlawful",
			"parent mutated",
			"r mutated",
			"at mutated",
			"children mutated",
			"start mutated",
			"end mutated",
			"a parent after its child",
			"a second root",
			"a row under another tree"
		] satisfies ReadonlyArray<Reached<TreeFeature>>,
		check: (_, k: Case<TreeFeature>) => (s) =>
			Effect.sync(() => {
				const rows = rowsOf(s)
				const isLawful = lawful(rows, structureOf)
				k.note(isLawful ? "lawful" : "unlawful")
				for (const named of namedOf(s)) {
					k.note(named)
				}
				const facts: HostFacts = {
					T: Arr.map(rows, (row) => ({
						doc: uuidOf(1000 + Number(rOf(row))),
						parent: BigInt(row.parent),
						at: BigInt(row.at),
						children: BigInt(row.children),
						start: BigInt(row.start),
						end: BigInt(row.end)
					}))
				}
				assert.equal(
					violates(t, lawOfShape(t, "tree"), facts) || violates(t, lawOfShape(t, "pk"), facts),
					!isLawful,
					`${Formatter.format(rows)} is ${isLawful ? "one tree per r" : "no tree"}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "trees.md §2's theorem by a direct pre-order numbering"
		},
		box: "every forest of one or two trees of at most four rows, r over two values, and every single mutation of one field in range",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original: "\t\tw(lemma(b, env, s.next, loc)),\n\t\tw(lemma(b, env, s.close, loc))",
				replacement: "\t\tw(lemma(b, env, s.next, loc))",
				why: "The tree's violation omits T5, each parent's end its last child's end (analysis/theory/laws.ts treeArms); the property fails."
			}
		]
	})
