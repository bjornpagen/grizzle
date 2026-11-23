/**
 * Two families over one member table, added to stored rows: the migration's backfill draws both families' columns of
 * the member table in one UPDATE, so each member row takes one new version, not one per family, on PostgreSQL 19.
 *
 * A case draws one to three owners of each family, Owner by g and Other by h, and up to six members, each in one group
 * of each, keyed apart and written in a drawn order. The second version counts Member under Owner and again under
 * Other, each a counted family that draws its hidden index on Member and its count on its owner.
 *
 * Oracle: the drafted Structure file, as the runner applied it, holds exactly one UPDATE of Member's table, since
 * neither family's member backfill reads a column the other draws (deploy/diff/backfill.ts merged); each owner's drawn
 * count is the number of its members, counted here over the written rows; and VALIDATE, which judges every native of
 * both families over the backfilled rows, the hidden indexes among them, leaves no constraint NOT VALID.
 *
 * Features: an owner with no member, an owner of several members, members written out of their key order; each pending
 * one aimed at by a case constructed to reach it.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aimedGen,
	type Feature,
	features,
	sharedCase
} from "#test/pg/migrate/backfill-shared.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Two families over one member table, backfilled draw both families' member columns in one UPDATE, each owner's count its members'. */
export const sharedMembers = property.explore(steered(aimedGen), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: features satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 6, coverage cases 2 * features.length (backfill-shared.test.ts at bf4f43bb). */
	budget: { runs: 6, steered: 2 * features.length },
	check:
		({ substrate }, notes: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(
				sharedCase(c, notes),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "the applied Structure file's UPDATEs of the member table, each owner's drawn count against its members counted over the written rows, and VALIDATE of both families' natives"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original: "\t\tconst key = nameKey(n.derivation.table)",
			replacement: `\t\tconst key = \`\${nameKey(n.derivation.table)}\\u0000\${n.name}\``,
			why: "No member part joins its table's UPDATE, each derivation written by an UPDATE of its own, so Member takes two."
		}
	]
})
