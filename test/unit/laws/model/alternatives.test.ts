/**
 * An alternatives statement lowers to plain containments' natives (fin.md §7, w4-w7 §2.5), with no residual law and no
 * head: the discriminator's roster domain types it. The oracle is fin.md §7 turned into a checker:
 *
 * - **forward**, per arm relation X serving the handles H: each X row's parent is a parent of a handle in H, a law
 *   column on the parent holding its id where its tag is in H, referenced by X's id. One handle's is the column the
 *   reverse containment of that handle references from, whose UNIQUE serves its probe too (laws/model/plan.ts
 *   `#reference`), so the arm holds no constant and the parent no UNIQUE over (id, tag);
 * - **reverse**, per armed handle h: each parent of tag h has its arm row, a law column on the parent holding its id
 *   where its tag is h, referencing X's id: one generated column per armed handle;
 * - **the arm's key**, per arm relation X: the forward containment carries X's key, its id, whole into the parent's,
 *   so X's id references the parent's id too (laws/model/plan.ts keyReferences), as the forward one is deferred; the
 *   reverse one, out of a law column null on a parent of another tag, implies none;
 * - every one of these foreign keys is deferred, since forward and reverse form a cycle, and no other is installed.
 *
 * A law column is told by what it holds, read by the reference evaluator on a parent of every tag: the handles whose
 * parents it is defined for, or the one handle a constant holds.
 *
 * Box: every roster of 1 to 3 handles, each handle unarmed or armed by one of two arm relations, at least one armed,
 * constructed by its first armed handle: 2 + 8 + 26 = 36 assignments, exhausted.
 *
 * Features: an arm of one handle, an arm of several handles, an unarmed handle, two arm relations.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	armsOf,
	assignmentGen,
	checkAssignment,
	type Feature,
	features
} from "#test/unit/laws/model/alternatives.fixtures.ts"

/** Alternatives lowers to its containments' natives every roster of 1 to 3 handles with every arm assignment. */
export const alternativesLowersToItsContainmentsNativesEveryRosterOf1To3HandlesWithEveryArmAssignment =
	property.exhaust(finite(assignmentGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (a) =>
			Effect.sync(() => {
				const arms = armsOf(a)
				if (Arr.some(arms, (x) => x.handles.length === 1)) {
					c.note("an arm of one handle")
				}
				if (Arr.some(arms, (x) => x.handles.length > 1)) {
					c.note("an arm of several handles")
				}
				if (Arr.contains(a, "none")) {
					c.note("an unarmed handle")
				}
				if (arms.length > 1) {
					c.note("two arm relations")
				}
				checkAssignment(a)
			}),
		oracle: {
			kind: "specification",
			name: "fin.md §7's forward and reverse containments as a checker"
		},
		box: "every roster of 1 to 3 handles, each unarmed or armed by one of two arm relations",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original:
					'\t\t\t\t: [{ kind: "contained", left: arm, right: discriminated(a, [first, ...rest]), loc: a.loc }]',
				replacement:
					'\t\t\t\t: [{ kind: "contained", left: arm, right: discriminated(a, [first]), loc: a.loc }]',
				why: "An arm of several handles is contained in its first handle's parents alone."
			}
		]
	})
