/**
 * Dropping a role on PostgreSQL 19 ends exactly the sessions that hold a temporary object of it, whether a migration
 * drops it or `grizzle uninstall` does (sql/ast.ts EndHolders, the one statement both send before DROP ROLE).
 *
 * A write's carrier is a temporary table of its session, ON COMMIT PRESERVE ROWS, owned by the role whose transaction
 * made it, beside its emptying, a function of the session's temporary schema, and both stand until the session ends;
 * PostgreSQL refuses DROP ROLE (2BP01) while one does. A case installs a login, `desk`, with two roles, `scribe` and
 * `reader`, through its migration; opens sessions of `desk`, each resting as a pooled session rests between
 * transactions, after a transaction as a role that stood up a write's carrier by grizzle's own stand-up: the holder of
 * `scribe`'s carrier; where the case says so, a session holding a carrier of each role; one holding `reader`'s carrier;
 * and one that ran a transaction as `reader` and made nothing. Then it drops roles: by the migration to a version whose
 * `desk` holds `reader` alone, run by the real runner, which drops `scribe`; or by `grizzle uninstall`, which drops
 * every role of the installation.
 *
 * Oracle: PostgreSQL's own catalog and activity. The drop commits; a session is gone exactly when it held an object of
 * a dropped role, and every other one still answers and keeps its carriers; and nothing of a dropped role remains, no
 * role of its name and no object it owns or shared dependency on it.
 *
 * The box, exhausted: each drop, and a session holding both roles' carriers or none.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { box, type RoleDropFeature, roleDropCase } from "#test/pg/migrate/role-drop.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Dropping a role ends exactly the sessions that hold a temporary object of it, and the drop commits leaving nothing of the role. */
export const droppingARoleEndsExactlyTheSessionsThatHoldATemporaryObjectOfItAndLeavesNothingOfTheRole =
	property.exhaust(finite(box), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a holder of a carrier ended",
			"a holder of two roles' carriers ended",
			"a holder of the kept role's carrier ran on",
			"a session holding nothing ran on",
			"uninstall ended every holder"
		] satisfies ReadonlyArray<Reached<RoleDropFeature>>,
		check:
			({ substrate }, c: Case<RoleDropFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					roleDropCase(k, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's catalog and activity: the drop's commit, each session's backend, and every role, object and shared dependency of a dropped role"
		},
		box: "each drop (a migration, uninstall), and a session holding both roles' carriers or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\tdrop(kind, statement({ kind: "endHolders", roles: [name] }))\n',
				replacement: "",
				why: "A migration drops a role while a resting session holds its carrier: PostgreSQL refuses DROP ROLE (2BP01) and the migration rolls back."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/uninstall.ts",
				original:
					'\t\t\t\tsent({ kind: "endHolders", roles: names }),\n\t\t\t\tsent({ kind: "dropOwned", roles: names }),\n',
				replacement:
					'\t\t\t\tsent({ kind: "dropOwned", roles: names }),\n\t\t\t\tsent({ kind: "endHolders", roles: names }),\n',
				why: "Uninstall ends the holders after DROP OWNED, which dropped their carriers under them and left nothing to find them by: they run on, their buffers of the dropped carriers failing their next temporary work."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: ' || "b"."proc")',
				replacement: ' || "b"."proc" OR true)',
				why: "The end matches no backend to its own temporary schema, so it ends every backend of the database, the sessions that hold nothing among them."
			}
		]
	})
