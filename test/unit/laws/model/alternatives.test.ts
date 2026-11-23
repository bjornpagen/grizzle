/**
 * An alternatives statement states plain containments (fin.md §7, ir/desc.ts expandAlternatives), with no residual law
 * and no head, the discriminator's roster domain typing it:
 *
 * - **forward**, per arm relation X serving the handles H: X's ids among the parents tagged by a handle of H;
 * - **reverse**, per armed handle h: the parents tagged h among its arm's ids.
 *
 * Every relation is keyed by its id and open inside the unit of it, so every containment joins within one unit, its
 * relations its declared unit's, and is judged whole over the units a transaction wrote (laws/model/plan.ts
 * containmentDischarge): the law model installs no foreign key and no law column for any of them.
 *
 * The oracle is fin.md §7's containments stated apart, a second statement of the same laws: the alternatives statement
 * states exactly their laws, each one identity (ir/dag.ts), and each is a whole rule.
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

/** Alternatives states its containments, each judged whole, every roster of 1 to 3 handles with every arm assignment. */
export const alternativesStatesItsContainmentsEachJudgedWholeEveryRosterOf1To3HandlesWithEveryArmAssignment =
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
			name: "fin.md §7's forward and reverse containments stated apart: the same laws, each a whole rule"
		},
		box: "every roster of 1 to 3 handles, each unarmed or armed by one of two arm relations",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\t\t\t\t"condition" in\n',
				replacement: '\t\t\t\t\ttrue ||\n\t\t\t\t\t"condition" in\n',
				why: "A containment over a mutable relation is native, as before, its declared unit unread: every containment of the alternatives over open relations installs its foreign key and law column, and none is a whole rule."
			},
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
