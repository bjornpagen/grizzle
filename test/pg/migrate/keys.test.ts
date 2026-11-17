/**
 * A relation's primary key moved between its fields over stored rows, migrated on PostgreSQL 19 by the real runner. A
 * primary key is named by its relation alone, so a migration that moves it to another field changes it under its own
 * name: on a table that may hold rows the new key's index is built concurrently under a temporary swap name, then
 * attached as the key (deploy/diff/diff.ts ownConstraint, swapName). A build over rows that repeat the new key is
 * refused by PostgreSQL with 23505, reporting the swap name as its constraint, which no snapshot's constraint-to-law map
 * holds: the folder's own laws (its meta.json's FolderLaws) hold it, under its table, as the moved key's law.
 *
 * A case draws three versions of Item, each keyed by one of its fields `id`, `a` and `b`, and rows of Item, stored
 * after the first version, those its key refuses left out. Each later version is drafted from the snapshot before, as
 * a history drafts it (install-migrate.ts draftVersion), and applied by the real runner as `grizzle migrate` applies
 * it, the drift check and the installed-catalog checker admitting every apply; or the last two together, as one apply
 * of two pending folders. The steered phase aims at a key moved over rows that keep it, over rows that repeat it, and
 * over rows that repeat it in the first of two pending folders.
 *
 * The oracle is the key restated over the stored rows: a version's key holds exactly when no two rows share its field.
 * A migration applies exactly when the rows keep the key of every version it reaches. A refused one names the folder of
 * the first version whose key the rows break, and that version's key law (migrate's StatementFailed or
 * FileCommitRefused `law`). After every apply the migrated catalog is a fresh install's of the version
 * (install-migrate.ts expectFreshCatalog).
 *
 * Features: a key moved over rows that keep it, over rows that repeat it, and over rows that repeat it in the first of
 * two pending folders, each a steered case constructs while it is pending.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { aims, caseGen, type Feature, walk } from "#test/pg/migrate/keys.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A primary key moved over stored rows migrate a primary key to another field exactly when the stored rows keep it, naming its law when they do not. */
export const movedKeys = property.explore(aimed(caseGen, aims), {
	needs: { substrate: Substrate.installing },
	situations: [
		"a primary key moved over rows that keep it",
		"a primary key moved over rows that repeat it, refused naming its law",
		"a primary key moved over rows that repeat it in the first of two pending folders, refused naming its law"
	] satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 12, coverage cases 30 (keys.test.ts at bf4f43bb). */
	budget: { runs: 12, steered: 30 },
	check:
		({ substrate }, cx: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(Effect.scoped(walk(c, cx.note)), Substrate, substrate),
	oracle: {
		kind: "specification",
		name: "the key restated over the stored rows: a migration applies exactly when no two rows share the key of any version it reaches, and a refused one names that version's key law"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original: "\t\tthis.swaps.push({ table: table.name, name: swap, of: name })\n",
			replacement: "",
			why: "A key's index built under its swap name is no Swap of the plan, so a refused build names no law."
		}
	]
})
