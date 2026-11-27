/**
 * A foreign key whose deferral alone changes is altered in place (deploy/diff/diff.ts deferralAlone), on PostgreSQL 19
 * by the real runner, over stored rows: ALTER TABLE ... ALTER CONSTRAINT ... [NOT] DEFERRABLE in Publish, a catalog
 * update that reads no row, where a drop, a NOT VALID addition and a VALIDATE would read every row of its table again.
 *
 * The box, exhausted: Child, keyed by its id, its parent contained in Parent's key, a foreign key in every version since
 * it joins across units; Parent keyed by its id alone, so the key is immediate, or with a field PostgreSQL generates
 * beside it, so the deferral rule defers it (laws/model/model.ts #deferral); the first version installed over stored
 * parents and children, the second drafted from its snapshot and applied.
 *
 * The oracle is the specification and PostgreSQL: where the deferral changes, the one statement of the folder that
 * names the foreign key is its ALTER CONSTRAINT in Publish, to the target's deferral; where it does not, none names it;
 * and the migrated catalog is a fresh install's of the second version (install-migrate.ts expectFreshCatalog).
 *
 * Features: immediate then deferred, deferred then immediate, its deferral kept.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, walk } from "#test/pg/migrate/deferral.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A foreign key whose deferral alone changes is altered in place in Publish, the migrated catalog a fresh install's. */
export const aForeignKeyWhoseDeferralAloneChangesIsAlteredInPlaceInPublish = property.exhaust(
	finite(caseGen),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"immediate then deferred",
			"deferred then immediate",
			"its deferral kept"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, cx: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(walk(c, cx.note)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the folder's one statement naming the foreign key, its ALTER CONSTRAINT in Publish, and PostgreSQL's catalog of the migrated against a fresh installation"
		},
		box: "Parent keyed alone or beside a generated field, then the same or the other, Child's parent in its key, over stored rows",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\tif (this.deferralAlone(old, c)) {",
				replacement: "\t\t\tif (false) {",
				why: "A foreign key whose deferral alone changes is dropped, added again NOT VALID and validated, reading every row again; the one statement naming it is no ALTER CONSTRAINT."
			}
		]
	}
)
