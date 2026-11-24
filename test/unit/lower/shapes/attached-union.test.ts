/**
 * An attachment whose child is a union, read through a rule that matches it at the parent's key, reads the union at
 * each parent key inside its LATERAL (lower/shapes/share/keys.ts restrictionWalk, the parent key carried through the
 * child's region into the union, each arm at it, lower/shapes/union keyedUnion), so each arm reads the parent's rows
 * alone, never a CTE of the union: metis's assign 409 read-back, `activeAfter` with its status attached by number, a
 * union of five rules under DISTINCT, was derived whole for the statement (a HashAggregate over 104,025 rows, scans of
 * assignment and sitting_event) and joined to each parent row by its number, 147 ms under the series lock.
 *
 * The box, exhausted: the asked test's assignments, with each one's status attached by its number, or alone.
 *
 * Oracle: specification, no MATERIALIZED CTE holds the union, and with the attachment each arm reads the parent's key.
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
	unionPerParentKey,
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
					unionPerParentKey(sql),
					box.attached === "by the number",
					`${box.attached}: each arm of the status union read at the parent's number\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "no MATERIALIZED CTE holds the status union; with the attachment, each of its arms is read at the parent's number inside the attachment's LATERAL"
		},
		box: "the asked test's assignments, each with its status, a union of three rules, attached by number, or alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\tfor (const [source, columns] of bySource) {\n\t\t\t\t\tenter(\n",
				replacement:
					"\t\t\t\tfor (const [source, columns] of bySource.size < 0 ? bySource : []) {\n\t\t\t\t\tenter(\n",
				why: "The parent key stops at the child's region: the status union it reads is read as the statement's MATERIALIZED CTE, derived whole, and filtered by each parent's number beside it."
			}
		]
	})
