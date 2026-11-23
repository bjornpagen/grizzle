/**
 * An attachment whose child is a union, read through a rule that matches it at the parent's key, reads the union per
 * parent key inside its LATERAL (lower/optimize/cte-policy probedByKey through the region that reads the union as it
 * stands, attachmentRead `perKey`, perKeyReads, rule 5c), where PostgreSQL moves the key into every arm, so each arm
 * reads the parent's rows alone: metis's assign 409 read-back, `activeAfter` with its status attached by number, a
 * union of five rules under DISTINCT, was derived whole for the statement (a HashAggregate over 104,025 rows, scans of
 * assignment and sitting_event) and joined to each parent row by its number, 147 ms under the series lock.
 *
 * The box, exhausted: the asked test's assignments, with each one's status attached by its number, or alone.
 *
 * Oracle: specification, no MATERIALIZED CTE holds the union, which the attachment reads inside its LATERAL.
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
	unionCtes,
	unionInsideLateral
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
				assert.equal(unionCtes(sql), 0, `${box.attached}: no CTE holds the status union\n${sql}`)
				assert.equal(
					unionInsideLateral(sql),
					box.attached === "by the number",
					`${box.attached}: the status union read inside the attachment's LATERAL\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "no MATERIALIZED CTE holds the status union, which the attachment reads per number inside its LATERAL"
		},
		box: "the asked test's assignments, each with its status, a union of three rules, attached by number, or alone",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\tif (renamed !== undefined && renamed.occurrence.source.kind !== "Base") {\n',
				replacement: "\t\tif (false) {\n",
				why: "A region that reads the union as it stands binds the key by no stored relation, as before: the attachment reads its child once, the status union derived whole for the statement as a MATERIALIZED CTE and joined to each assignment by its number."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original:
					'\t\t} else if (node.kind === "Attach" && attachmentRead(node).kind === "perKey") {\n',
				replacement: "\t\t} else if (false) {\n",
				why: "An attachment read per key leaves its child's union one read once per row of another, so a workload's read derives it whole once (rule 5b), a MATERIALIZED CTE the LATERAL filters by the number."
			}
		]
	})
