/**
 * The plan-shape law reads every scan of a rule judge's statement, a scan inside a SubPlan among them
 * (test/support/pg/physical/plan-bindings.ts judgeScans, scanBindings): PostgreSQL keeps a judge's NOT EXISTS as a correlated
 * SubPlan beneath the scan whose Filter runs it, as it plans LC-WRITERS' whole judge, and a law that read only the
 * scan would never see how the SubPlan reads the other side.
 *
 * - **Property:** over a fixed plan of a judge's statement, the law finds the SubPlan's read of R0 by doc alone, f_0
 *   matched in a Filter after, binding one column of R0's key where (doc, f_0) binds two, and nothing in the same plan
 *   whose SubPlan binds (doc, f_0) by its index condition.
 * - **Oracle:** the specification: the law's judgment of a scan (plan-bindings.ts judged), stated for each plan.
 * - **Box, exhausted:** the SubPlan's read of R0, bound, bound with f_0's equality printed by its operator's schema
 *   (`OPERATOR(ext.=)`, as PostgreSQL prints a vector extension's outside the search path), or under-bound.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	problemsOf,
	type SubPlanRead,
	subPlanBox
} from "#test/unit/physical/judge-scans.fixtures.ts"

/** The problems the law finds with each plan, by the specification. */
const expected: { readonly [C in SubPlanRead]: ReadonlyArray<string> } = {
	bound: [],
	boundQualified: [],
	underBound: [
		"the judge's scan of r_0 as r15 reads r_0_pk, binding 1 of its columns where an index of the relation binds 2"
	]
}

/** The law reads a scan a SubPlan runs: one that under-binds is a problem, one that binds its coordinates none. */
export const theLawReadsAScanASubPlanRunsAndFindsOneThatUnderBinds = property.exhaust(
	finite(subPlanBox),
	{
		needs: {},
		situations: ["bound", "boundQualified", "underBound"] satisfies ReadonlyArray<
			Reached<SubPlanRead>
		>,
		check: (_, k: Case<SubPlanRead>) => (c) =>
			Effect.sync(() => {
				assert.deepEqual(problemsOf(c), expected[c], `the law over a SubPlan ${c}`)
				k.note(c)
			}),
		oracle: {
			kind: "specification",
			name: "the law's judgment of each scan of a fixed plan, stated for each plan"
		},
		box: "a judge's plan whose SubPlan reads R0 by (doc, f_0), f_0's equality spelled by its operator's schema or not, or by doc alone",
		kept: [],
		kills: [
			{
				file: "test/support/pg/physical/plan-bindings.ts",
				original:
					"\t\t\t\t...Arr.flatMap(node.children, (sub) => (plansApart(sub) ? visit(sub, []) : []))\n",
				replacement: "",
				why: "A scan's SubPlans are skipped, as before: the law never reads the SubPlan's scan of R0, so its read by doc alone passes."
			},
			{
				file: "test/support/pg/physical/plan-bindings.ts",
				original: '\t\tconst sides = splitTop(Str.replaceAll(qualifiedEquality, " = ")(c), " = ")',
				replacement: '\t\tconst sides = splitTop(c, " = ")',
				why: "An equality PostgreSQL prints by its operator's schema read as no equality, as before: the SubPlan's index condition on f_0 binds nothing, and serving's key lookup on a vector key read through its key's B-tree was judged to bind no column of it (serving's generated-workload red at e42937e8b, Rel0x0 keyed by a vector)."
			}
		]
	}
)
