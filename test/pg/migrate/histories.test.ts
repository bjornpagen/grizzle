/**
 * Rename histories on PostgreSQL 19, run as a commands program against a pure model of identity.
 *
 * The model holds the declared objects, and for each installed one the declaration it stands for (its origin): the
 * relations and their fields, among them a field of the closed relation Tier; Tier's handles; the context the worlds
 * read and its fields; the roles, each holding relations whole or entries over the context, a relation named by its
 * place; and the logins, each holding its roles. Each command is one schema edit:
 *
 * - a relation renamed, two relations' names swapped, a field renamed, a field renamed with its type changed, or a
 *   relation removed and one of its shape added under another name (a new identity: the old one dropped); programs
 *   chain them, so a rename followed by another is a chain A→B→C, and one back to an earlier name A→B→A;
 * - a login renamed, or renamed while its roles change (a role added to it, or taken from another login), each rename
 *   declared (`--rename @old=@new`), so the login keeps its PostgreSQL role, renamed in place;
 * - an entry added to a role or removed from it, a field of the context renamed or added, or the context renamed;
 * - a login's and a role's names exchanged, the login declared dropped (`--drop @<login>`): one PostgreSQL role would
 *   turn from a login into a role, which the draft refuses by name (loginRoleExchange), at the PostgreSQL role of one of
 *   the two, applying nothing.
 *
 * Each step drafts the edit from the snapshot before (`grizzle generate`), declaring by the model's identity map what
 * it renames and drops (`--rename`, `--drop`): a relation renamed exactly when the step keeps its origin under another
 * name, a field renamed exactly when a kept relation keeps its origin under another name, a login renamed exactly when
 * the step keeps its origin under another name, and every relation and field whose origin the step no longer holds
 * dropped. It checks the review reads back as made (the read-back oracle), and
 * migrates it with the runner, whose admission checks the catalog against the snapshot (drift). After every step:
 *
 * - the installed catalog is a fresh install's of the step's version, its worlds included: roles, memberships, views,
 *   policies, functions and grants;
 * - every login is the PostgreSQL role its origin was installed as, and every role the one of its name: a renamed login
 *   keeps its OID under its new name, its old name held by no role, and no role is created again;
 * - the facts written before the first step read back through the renamed objects: every relation of the step holds
 *   the rows the carry model of the model's identity map says, against a fresh install loaded with them.
 *
 * What a single-step suite cannot see, a rename that loses its identity across steps, fails here: the model says which
 * object is which, and PostgreSQL must agree.
 *
 * Oracle: the identity model, a second implementation of which object each name stands for, judged by PostgreSQL:
 * the catalog of a fresh install of each version, the OIDs of every login and role, and the rows read back.
 *
 * Features: every command kind, chains of renames, a relation renamed back, a world entry over a renamed relation,
 * renames and drops declared by identity, and a renamed login kept in place.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type Feature, history, stepsSteered } from "#test/pg/migrate/histories.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Rename histories on PostgreSQL every step of a rename history migrates to a fresh install's catalog, its worlds included, every login and role keeps its PostgreSQL role, and the rows follow the model's identity map.
 *
 * Its pre-conversion budget: runs 4, coverage cases 24 (test/pg/migrate/histories.test.ts at d8eed1786).
 */
export const renameHistoriesOnPostgreSQLEveryStepOfARenameHistoryMigratesToAFreshInstallsCatalogItsWorldsIncludedEveryLoginAndRoleKeepsItsPostgreSQLRoleAndTheRowsFollowTheModelsIdentityMap =
	property.explore(steered(stepsSteered), {
		needs: { substrate: Substrate.fresh },
		situations: [
			"a relation renamed",
			"two relations' names swapped",
			"a field renamed",
			"a field renamed with its type changed",
			"a relation removed and one of its shape added",
			"a login renamed",
			"a login renamed while its roles change",
			"a login's and a role's names exchanged, refused",
			"an entry added to a role",
			"an entry removed from a role",
			"a context field renamed",
			"a context field added",
			"the context renamed",
			"a chain of renames",
			"a relation renamed back",
			"a world entry over a renamed relation",
			"a rename declared by identity",
			"a drop declared by identity",
			"a renamed login kept in place"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c: Case<Feature>) =>
			(steps) =>
				Effect.provideServiceEffect(
					history(steps, (f) => c.note(f)),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the identity model, judged by a fresh install's catalog, every login's and role's OID, and the rows read back"
		},
		budget: { runs: 4, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: '\tif (lead === asideSegment) {\n\t\treturn "aside"\n\t}\n',
				replacement: "",
				why: "864eefdb2's fix reverted: a login's name set aside while a migration renames it is no role a drafted statement names, so migrate refuses every login rename at stage input as unknownVariable."
			}
		]
	})
