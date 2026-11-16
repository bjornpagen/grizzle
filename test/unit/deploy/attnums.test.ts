/**
 * A table's attribute numbers across migrations, drafted with no database: every program of at most six commands (add
 * a field, drop one, rename one) on one table, each against a column bound drawn small, from 2 to 6 (testing doctrine
 * rule 10: PostgreSQL's is 1600, a constant no test reaches by adding columns), exhausted.
 *
 * The oracle is a model of pg_attribute's attribute numbers: a table created with n columns has used n, each added
 * column takes the next, and a dropped or renamed one gives its number back to nothing. Each step's snapshot records
 * the model's count, which only grows, and the draft's attribute numbers are refused under the drawn bound exactly
 * when the model's count passes it, an addition past the bound counting the dropped columns.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	boxGen,
	draftsByPrefix,
	type Feature,
	FEATURES,
	judge
} from "#test/unit/deploy/attnums.fixtures.ts"

/** A table's attribute numbers grow by one per added column and never shrink, every program of at most six adds, drops and renames, an addition past a small bound refused. */
export const aTablesAttributeNumbersGrowByOnePerAddedColumnAndNeverShrinkEveryProgramOfAtMostSixAddsDropsAndRenamesAnAdditionPastASmallBoundRefused =
	property.exhaust(finite(boxGen), {
		needs: { drafts: draftsByPrefix },
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check: (resources, c: Case<Feature>) => (box) =>
			Effect.map(resources.drafts, (drafts) => judge(drafts, box, (feature) => c.note(feature))),
		oracle: {
			kind: "second-implementation",
			name: "a model of pg_attribute's attribute numbers"
		},
		box: "every program of one to six commands (add a field, drop the first, rename the first), each under a column bound from 2 to 6",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\t\t\t\t? was.attnums + (added.get(r.ident) ?? 0)",
				replacement: "\t\t\t\t? r.attnums",
				why: "A table's attribute numbers are read from the target alone, the columns its earlier migrations added and dropped forgotten (snapshot/build.ts withAttnums)."
			}
		]
	})
