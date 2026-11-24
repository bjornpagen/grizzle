/**
 * An attachment whose child is a union, read through a rule that matches it at the parent's key, computes the union at
 * the parent rows' keys (lower/shapes/share/keys.ts, an attachment's child keyed by its parent's rows through its
 * correlation): the union read LATERAL per key of a DISTINCT key set of the parents' numbers, each arm at the key, so
 * each arm reads the parent's rows alone: metis's assign 409 read-back, `activeAfter` with its status attached by
 * number, a union of five rules under DISTINCT, was derived whole for the statement (a HashAggregate over 104,025 rows,
 * scans of assignment and sitting_event) and joined to each parent row by its number, 147 ms under the series lock.
 *
 * The box, exhausted: the asked test's assignments, with each one's status attached by its number, or alone.
 *
 * Oracle: specification, no MATERIALIZED CTE holds the union whole, and with the attachment one holds it at the keys.
 *
 * Features: by the number; no attachment.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type Attached,
	boxGen,
	optimizedOf,
	unionAtKeys,
	wholeUnionCtes
} from "#test/unit/lower/shapes/attached-union.fixtures.ts"

/** An attachment whose child reads a union at the parent's key reads the union per parent key, never derived whole. */
export const anAttachmentWhoseChildReadsAUnionAtTheParentsKeyReadsItPerParentKeyNeverDerivedWhole =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: ["by the number", "no attachment"],
		check: (_, k: Case<Attached>) => (box) =>
			Effect.sync(() => {
				k.note(box.attached)
				const sql = optimizedOf(box)
				assert.equal(
					wholeUnionCtes(sql),
					0,
					`${box.attached}: no CTE holds the status union whole\n${sql}`
				)
				assert.equal(
					unionAtKeys(sql),
					box.attached === "by the number",
					`${box.attached}: the status union computed at the parents' numbers\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "no MATERIALIZED CTE holds the status union whole; with the attachment, one holds it at the parents' numbers"
		},
		box: "the asked test's assignments, each with its status, a union of three rules, attached by number, or alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\treturn reader.child === node\n",
				replacement: "\t\t\t\treturn false && reader.child === node\n",
				why: "An attachment's child keeps none of its parent's keys: the status union, read once per assignment, is derived whole for the statement as a MATERIALIZED CTE the LATERAL filters by the number."
			}
		]
	})
