/**
 * One rewrite per table: a migration over a populated installation rewrites each table at most once, however many
 * stored generated columns it adds to it, converts or drops, on PostgreSQL 19.
 *
 * A case draws a populated first version, R(id, a, b, e, gone) and S(id, x), its rows, and a delta to a second
 * version: k ≤ 3 containments of R's rows selected by b = j into S's key, each a partial projection of a, which grizzle
 * stores as a STORED generated law column on R beside its foreign key; up to two generated fields of R over e; b
 * converted from integer to bigint, which the law columns read, so they go and come back around the conversion; a
 * field c added to R and gone dropped from it, as declared; a CHECK over c; and a new candidate key on S's x with R's e
 * contained in it, a foreign key onto a new UNIQUE. The rows keep every law of the second version by construction: a
 * and e name S rows, S's x values are distinct, and the reviewer gives c 0 and converts b by its cast.
 *
 * Oracle: PostgreSQL itself. A table_rewrite event trigger (test/support/migrate/rewrites.ts) records each table
 * PostgreSQL rewrites while the second version's folder applies, so the property is that no table of the installation
 * is rewritten twice; and the migrated catalog equals a fresh installation of the second version, both read from
 * PostgreSQL's catalog (test/support/pg/migrate/support.ts sameCatalog).
 *
 * Features: several stored generated columns added to one table; an add plus a drop on one table; a CHECK over a new
 * column; a cross-table foreign key onto a new UNIQUE; and a conversion beside generated columns over it. Each pending
 * one is aimed at by a case whose delta turns it on.
 *
 * The event trigger is the database's, so each case runs in a database of its own (Substrate.fresh).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseSteered,
	type Feature,
	features,
	rewriteCase
} from "#test/pg/migrate/rewrites.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** One rewrite per table on PostgreSQL a migration over a populated installation rewrites each table at most once, and its catalog is a fresh installation's. */
export const rewrites = property.explore(steered(caseSteered), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: features satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 6, coverage cases 2 * features.length (rewrites.test.ts at bf4f43bb). */
	budget: { runs: 6, steered: 2 * features.length },
	check:
		({ substrate }, notes: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(
				rewriteCase(c, notes),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's table_rewrite events during the migration, and its catalog of the migrated and of a fresh installation"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\tconst held = this.alterations[slot].get(key)\n\t\tif (held !== undefined) {\n\t\t\tappendAll(held.rest, altering)\n\t\t\treturn\n\t\t}\n",
			replacement: "",
			why: "The diff drafts one ALTER TABLE per subcommand again, so a table gaining two generated columns is rewritten twice."
		}
	]
})
