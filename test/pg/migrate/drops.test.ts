/**
 * Every column step a draft runs on a table it keeps is one PostgreSQL accepts, in an order of what reads what: a
 * migration whose second version drops generated fields with the fields they read, converts, sets aside or turns
 * generated fields a generated field reads, re-expresses generated fields, and drops the CHECKs, law columns and
 * foreign keys over dropped fields, applies over stored rows on PostgreSQL 19.
 *
 * A case draws a first version: R, keyed by id, with one to four integer fields its caller writes and up to three
 * fields PostgreSQL generates from them, the least or the greatest of one or more, all declared in a shuffled order;
 * up to two CHECKs over any of R's fields; up to two containments of a caller field in S's key, one of every row,
 * which grizzle installs as a foreign key, and one of the rows another caller field selects, which grizzle stores as a
 * generated law column beside its foreign key; and R's rows, each containment holding of every one. The second version
 * keeps, drops, widens to bigint (set aside, at the reviewer's cast), constrains to a contract over integer (converted
 * in place) or generates from the key each caller field; keeps, drops or re-expresses over other caller fields each
 * generated field; keeps or drops each CHECK and containment; and drops every one that reads a field it no longer
 * holds as its caller's, as it must. Every dropped field is declared (`--drop`).
 *
 * Oracle: PostgreSQL itself. The second version's folder applies by the real runner over the stored rows, which
 * PostgreSQL refuses where the draft drops a column a generated column still reads (2BP01), converts one a generated
 * column reads (0A000), adds a generated column before a column it reads (42703), or sets an expression in the ALTER
 * TABLE that converts a NOT NULL column (XX000); and the migrated catalog equals a fresh installation of the second
 * version, both read from PostgreSQL's catalog (test/support/pg/migrate/support.ts sameCatalog).
 *
 * Features: a dropped generated field declared after and before a dropped field it reads; a dropped generated field
 * over a field set aside, converted in place and turned generated; a kept generated field declared before a field set
 * aside it reads and over a field converted in place; a generated field re-expressed off a field set aside, converted
 * in place and turned generated, and beside a field converted in place; and a dropped CHECK, law column and foreign key
 * over a dropped field, each aimed at by a case that adds it to a drawn one.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { aims, caseGen, dropCase, type Feature, features } from "#test/pg/migrate/drops.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Column steps in dependency order migrate a second version that drops generated fields with the fields they read, converts or rewrites what they read, and drops what else reads them, over stored rows. */
export const drops = property.explore(aimed(caseGen, aims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: features satisfies ReadonlyArray<Reached<Feature>>,
	budget: { runs: 24, steered: 2 * features.length },
	check:
		({ substrate }, cx: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(
				dropCase(c, cx.note),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's acceptance of the drafted folder over stored rows, and its catalog of the migrated and of a fresh installation"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\t\t\t? dependencyOrder(columns, (read, reader) =>\n\t\t\t\t\t\tgenerationColumns(reader.generated).includes(read.name)\n\t\t\t\t\t)\n",
			replacement: "\t\t\t\t? columns\n",
			why: "A kept table's fields are dropped in column order again, so a generated field declared after a field it reads is dropped after it, which PostgreSQL refuses (2BP01)."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\t\t\t\t\t\t: [{ column: b.name, reads: generationColumns(b.generated), fate: droppedColumn }]\n",
			replacement: "\t\t\t\t\t\t\t: [{ column: b.name, reads: [], fate: droppedColumn }]\n",
			why: "A removed generated field over a field the migration replaces is dropped at the end, after Structure converts or drops the field under it (0A000, 2BP01)."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\t\t\t\t\tgenerationColumns(was.generated).some(changed("converted", "rewritten")) ||\n',
			replacement: "",
			why: "A generated field re-expressed off a field turned generated keeps its column, so structure.drop drops the field it still reads (2BP01)."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\t\t\t\t\tgenerationColumns(was.generated).some(changed("converted", "rewritten")) ||\n\t\t\t\t\t(change.kind === "reexpressed" && convertsInPlace))\n',
			replacement:
				'\t\t\t\t\tgenerationColumns(was.generated).some(changed("converted", "rewritten")))\n',
			why: "A generated field re-expressed on a table that converts another field in place sets its expression in the ALTER TABLE of the conversion, which PostgreSQL 19 fails (XX000)."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\tdependencyOrder(\n\t\t\tmapNonEmpty([a.first, ...a.rest], (x) => asideSubcommand(x, aside).alteration),\n\t\t\treadsAdded\n\t\t),\n",
			replacement:
				"\t\tmapNonEmpty([a.first, ...a.rest], (x) => asideSubcommand(x, aside).alteration),\n",
			why: "A table's alteration adds its columns as its fields are declared again, so a generated field declared before a field set aside adds its column over the set-aside one before it exists (42703)."
		}
	]
})
