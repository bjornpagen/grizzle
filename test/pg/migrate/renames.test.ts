/**
 * Declared renames through grizzle's migrations, on PostgreSQL 19, generated: every rename and drop a migration
 * makes is declared (`--rename R=S`, `--rename R.f=S.g`, `--rename Roster#old=new`, `--drop`), and a declared rename is
 * drafted as a rename, so the stored data migrates with it.
 *
 * A case draws one or two relations, keyed by an integer and holding integer fields and a roster's codes, the rows
 * stored in them, and what the next version does to each name: a relation renamed or kept, each field renamed, dropped
 * or kept, a roster's handle renamed or none, and another of its handles removed or none, whose code no stored row
 * holds. The model of declared identities is the oracle, PostgreSQL the judge: a relation keeps its table (its OID) and
 * every row; a field renamed or kept keeps its column (its attribute number) and every value; a field dropped is gone
 * from the table's live columns; a renamed handle keeps its code, so a stored row of the old handle reads as the new
 * one, the old handle gone from the snapshot's codes; a removed handle's code is a hole, and every other handle keeps
 * its own. An undeclared drop is refused at the draft: the declared-identity model of test/unit/deploy/renames.test.ts
 * and the command line's project suite (test/unit/cli/project.test.ts) hold that.
 *
 * The next version serves a login whose one role holds every relation whole and reads each, every field it keeps, and
 * every stored row is read back through the login's served file (test/support/served-db.ts withServedDb), its codes
 * decoded by the codes the file holds (served/json.ts RosterWire): each row is the model's, its codes the handles the
 * next version names them by. Where a handle was removed below a code a stored row holds ("a served roster with a
 * hole"), a code after a hole is decoded end to end, so a file whose codes shift past a hole reads another handle.
 *
 * - **Property:** after the declared migration each relation keeps its table and every row, each field renamed or kept
 *   its attribute number and values, exactly the fields the schema keeps stand, every handle kept keeps its code (a
 *   renamed one its old one's), the renamed and removed handles are gone from the snapshot's codes, and every stored
 *   row reads back through the next version's served file as the model's.
 * - **Oracle:** the model of declared identities, judged by PostgreSQL's OIDs, attribute numbers and stored values, and
 *   by the served read of the stored rows.
 * - **Features:** a relation renamed, a field renamed, a field of a renamed relation renamed, a field dropped, a handle
 *   renamed, a stored code under its renamed handle, a handle removed, a served roster with a hole, and two relations.
 *   Swaps and chains of relations, fields and handles are family-renames' and histories' (test/pg/migrate), a field
 *   renamed with its type changed histories' and paths'.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { planGen, type RenameFeature, renamesCase } from "#test/pg/migrate/renames.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Declared renames through grizzle's migrations on PostgreSQL 19 a declared rename keeps the table, the column and the code it renames, with every stored value, and a declared drop leaves exactly the fields that stand. */
export const renames = property.explore(planGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a relation renamed",
		"a field renamed",
		"a field of a renamed relation renamed",
		"a field dropped",
		"a handle renamed",
		"a stored code under its renamed handle",
		"a handle removed",
		"a served roster with a hole",
		"two relations"
	] satisfies ReadonlyArray<Reached<RenameFeature>>,
	/** Its pre-conversion budget: runs 4, coverage cases 16 (renames.test.ts at bf4f43bb). */
	budget: { runs: 4, steered: 16 },
	check:
		({ substrate }, c: Case<RenameFeature>) =>
		(value) =>
			Effect.provideServiceEffect(
				renamesCase(value, c),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "a model of declared identities, judged by PostgreSQL's OIDs, attribute numbers and stored values"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/ir/codes.ts",
			original:
				"\t\tconst codes = rosterCodes(before, renames.get(roster.closed) ?? noHandleRenames, roster)",
			replacement: "\t\tconst codes = rosterCodes(before, noHandleRenames, roster)",
			why: "The codebook draft ignores a declared handle rename, so the renamed handle takes a new code."
		}
	]
})
