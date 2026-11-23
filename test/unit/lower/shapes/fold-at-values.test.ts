/**
 * A fold every reader of a workload's read reads at a value of a grouping column is read where it stands at each
 * (lower/optimize/cte-policy perKeyReads, fixedAtValues, rule 5c), so PostgreSQL moves each reader's value below the
 * grouping, where two readers made it one MATERIALIZED CTE of the whole fold, filtered beside: edullm's
 * learning-commons crosswalk reader, a rule at the asked state and one at the asked hub over one fold of every pair of
 * supports, folded all 28,271 pairs for each call (7,986 and 9,235 ms, where inline each read 545 to 632 and 5.8 ms;
 * D11's reader median 66 ms against 13,092).
 *
 * The box, exhausted: a read of the pairs of ends with their counts of supporting components, by one rule at the asked
 * state, or by two, one at the asked state and one at the asked hub.
 *
 * Oracle: specification, no MATERIALIZED CTE of the whole fold, and Supports read once per rule, at its value.
 *
 * Features: two rules, a state's and a hub's; one rule, a state's.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	boxGen,
	optimizedOf,
	type Rules,
	supportScans,
	wholeFoldCtes
} from "#test/unit/lower/shapes/fold-at-values.fixtures.ts"

/** A fold every reader reads at a value of a grouping column is read inline at each, never one CTE of the whole fold. */
export const aFoldEveryReaderReadsAtAValueOfAGroupingColumnIsReadInlineAtEachNeverOneCteOfTheWholeFold =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: ["two rules, a state's and a hub's", "one rule, a state's"],
		check: (_, k: Case<Rules>) => (box) =>
			Effect.sync(() => {
				k.note(box.rules)
				const sql = optimizedOf(box)
				assert.equal(
					wholeFoldCtes(sql),
					0,
					`${box.rules}: no CTE holds the whole fold, each rule reads it at its value\n${sql}`
				)
				assert.equal(
					supportScans(sql),
					box.rules === "one rule, a state's" ? 1 : 2,
					`${box.rules}: Supports read once in each rule\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "no MATERIALIZED CTE of the whole fold, Supports read once in each rule that reads the fold at its value"
		},
		box: "a read of the pairs of ends with their counts of supports, by one rule at the asked state or by two, at the asked state and at the asked hub",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t\tconst at = filteredAtValues(node)\n",
				replacement: "\t\t\tconst at = undefined\n",
				why: "A fold two rules read at their values is MATERIALIZED for the statement, as before (rule 5, sharedExpensive): one CTE of the whole fold, every pair of supports, each rule's value applied beside it."
			}
		]
	})
