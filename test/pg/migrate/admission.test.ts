/**
 * The drift check after `grizzle migrate`: the catalog is compared with the target
 * snapshot and drift is refused: edits are allowed, drift is not, and a hand edit that diverges from the schema is
 * caught at deploy time rather than at the first failing query.
 *
 * The property, over drawn hand edits of a drawn folder's reviewed files: an edit that reaches the same state by
 * another route (a reviewer's comment, a statement with no effect, a scratch index built and dropped again on a drawn
 * column) is admitted; one that changes the state is refused at the stage drift after its files committed, and the
 * ledger records the folder, its latest target the folder's; one that adds a statement that raises, at the head of the
 * second folder's first file, stops the apply at that statement, StatementFailed naming the folder, the file and
 * statement 1, and the ledger's latest target stays the first folder's. The state-changing edits are drawn over every statement
 * of their kind the draft holds: an extra index on a drawn column, a drawn table taken from a drawn grant (or the grant
 * deleted), the EXECUTE grant of a drawn function deleted, a drawn index rebuilt over one more drawn column under its
 * drafted name, a CHECK predicate's constant raised by a drawn amount, a drawn VALIDATE CONSTRAINT deleted from a
 * Validate file (which leaves the constraint NOT VALID). Each edit of a drafted statement is its own printed text
 * replaced by its edited copy's, both printed from the typed plan. The history is the shop's first version, or its
 * first and second, the edit made in the second folder; a VALIDATE and a CHECK the draft adds NOT VALID are the
 * second's. Each version is installed with the fixture's worlds (`fixtureLogin`), whose roles
 * hold the grants the grant edits pick from. Drift made outside a migration is the admission suite's.
 *
 * Oracle: the specification of admission, by the class each edit is constructed in: an edit of the same state is
 * admitted, an edit of the state refused at drift after its files committed, and a raising statement stops at itself.
 *
 * Features: each edit kind with its outcome, admitted or refused.
 */

import { defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	applyEdited,
	type EditFeature,
	editGen,
	editKinds,
	featureOf,
	historyOf,
	inSecond,
	outcomeOf,
	reviewerOf
} from "#test/pg/migrate/admission.fixtures.ts"
import { openMigrator } from "#test/support/pg/migrate/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { shopV1, shopV2 } from "#test/support/unit/deploy/schemas.ts"

/** Post-apply admission refuses drift a hand edit may change how the state is reached, never the state. */
export const admission = property.explore(steered(editGen), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: Arr.map(editKinds, featureOf) satisfies ReadonlyArray<Reached<EditFeature>>,
	/** Its pre-conversion budget: runs 6, coverage cases 120 (admission.test.ts at bf4f43bb). */
	budget: { runs: 6, steered: 120 },
	check:
		({ caseSubstrate }, c: Case<EditFeature>) =>
		(edit) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const m = yield* openMigrator(substrate, substrate.owner)
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const schema = yield* substrate.schema({ create: false, label: "hand_edit" })
							const folders = historyOf(inSecond(edit) ? [shopV1, shopV2] : [shopV1], schema)
							const reviewer = reviewerOf(
								edit,
								defined(folders[folders.length - 1]),
								defined(folders[0])
							)
							c.note(featureOf(edit.kind))
							yield* applyEdited(m, schema, folders, reviewer, outcomeOf(edit.kind))
						})
					)
				}),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "an edit reaching the same state is admitted, one changing it refused at drift, a raising statement stops at itself"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/admission/drift.ts",
			original:
				'\tfor (const [key, have] of installed) {\n\t\tif (!expected.has(key)) {\n\t\t\tout.push({ kind: "unexpected", fact: fact(key, have) })\n\t\t}\n\t}\n',
			replacement: "",
			why: "The drift check reports what the snapshot requires and the catalog lacks, never what the catalog holds beyond it, so an extra index is admitted."
		}
	]
})
