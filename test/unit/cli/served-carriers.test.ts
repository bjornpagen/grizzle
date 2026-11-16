/**
 * A role holds TEMPORARY on the database exactly when its served workload creates a carrier, a temporary table: the
 * installation grants it to those roles and to no other role or login (physical/ddl/roles.ts addWorlds), the drift
 * check expects each login's and role's own TEMPORARY grant on the database to be exactly that (deploy/admission/roles.ts
 * roleExpectation), and a later migration grants and revokes it so that, applied after the first, the database holds it
 * for exactly the roles the second's served files create a carrier in.
 *
 * The box: one relation, R(k, v) keyed by k and mutable, and two drafts of its logins, the second migrating from the
 * first's snapshot: each the login `app` of one to three roles, beside it none or a second login `other` of one role, a
 * role named by its login and its place, so a role the second draft holds no more is dropped. Every role holds R whole
 * and writes it, and owns a drawn change member: none, an insert of R, or a put of R from a query over a relation
 * parameter, whose displacing deletion and insert both read the query's rows from a carrier, every member supplied by
 * the call.
 *
 * Oracle: the texts each role's served file holds, as `grizzle generate` writes them (draftSchema, then servedFiles): a
 * role creates a carrier exactly when one of them is a CREATE TEMPORARY TABLE, whatever step, staged form or variant
 * sends it. Of each draft, the installation's grants of TEMPORARY on the database, its manifest's, go to exactly those
 * roles, and each login's and role's expectation holds the database's TEMPORARY exactly for them. The migration model
 * (test/support/migrate/interpret.ts), PostgreSQL's catalog as the migrations change it, runs the first draft's folder
 * from nothing and then the second's: each runs, no role dropped while it holds a privilege on the database, and after
 * each the roles holding a privilege on the database hold TEMPORARY alone and are exactly its draft's carrier roles.
 *
 * Features: a role whose served file creates a carrier, a role whose does not, one login holding both, a second login,
 * a role with no change member; and the second migration granting TEMPORARY to a role that held none, revoking it from a
 * role that keeps standing, and dropping a role that held it.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { assert } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { emptyState } from "#test/support/migrate/interpret.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import {
	caseGen,
	drafted,
	type Feature,
	migrated,
	temporaryHolders
} from "#test/unit/cli/served-carriers.fixtures.ts"

/**
 * TEMPORARY on the database is granted to exactly the roles whose served workload creates a carrier, expected of
 * exactly them, and migrated to them.
 *
 * Budget: its suite's count before the conversion (unit/cli/served-carriers: 16 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (a migration
 * granting TEMPORARY to a role that held none, a migration revoking TEMPORARY from a role that stands; toolchain-test
 * run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200, which it stops short of once every
 * situation is reached.
 */
export const tEMPORARYOnTheDatabaseIsGrantedToExactlyTheRolesWhoseServedWorkloadCreatesACarrierExpectedOfExactlyThemAndMigratedToThem =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a role whose served file creates a carrier",
			"a role whose served file creates none",
			"one login holding both",
			"a second login",
			"a role with no change member",
			"a migration granting TEMPORARY to a role that held none",
			"a migration revoking TEMPORARY from a role that stands",
			"a migration dropping a role that held TEMPORARY"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				const first = yield* drafted(
					c.first,
					(configured) =>
						emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
					noDeclarations,
					notes
				)
				const second = yield* drafted(
					c.second,
					() => first.draft.snapshot,
					{
						renames: [],
						drops:
							Arr.isReadonlyArrayNonEmpty(c.first.other) &&
							!Arr.isReadonlyArrayNonEmpty(c.second.other)
								? [{ kind: "login", login: parsedName("other") }]
								: []
					},
					notes
				)
				const once = migrated(first, emptyState)
				assert.deepEqual(
					temporaryHolders(once, first.declared),
					first.carriers,
					"after the first migration, the roles holding TEMPORARY on the database are its carrier roles"
				)
				const twice = migrated(second, once)
				const declared = new Map([...first.declared, ...second.declared])
				assert.deepEqual(
					temporaryHolders(twice, declared),
					second.carriers,
					"after the second migration, the roles holding TEMPORARY on the database are its carrier roles"
				)
				const standing = new Set(second.declared.values())
				for (const role of first.carriers) {
					if (!standing.has(role)) {
						notes.note("a migration dropping a role that held TEMPORARY")
					} else if (!Arr.contains(second.carriers, role)) {
						notes.note("a migration revoking TEMPORARY from a role that stands")
					}
				}
				if (Arr.some(second.carriers, (role) => !Arr.contains(first.carriers, role))) {
					notes.note("a migration granting TEMPORARY to a role that held none")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the CREATE TEMPORARY TABLE texts each role's served file holds"
		},
		budget: { runs: 16, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: "\tif (carriers) {",
				replacement: "\t{",
				why: "Every role is granted TEMPORARY, its carriers or none."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					'\tif (carriers) {\n\t\tprivileges.push(grant(["TEMPORARY"], { kind: "DATABASE" }))\n\t}\n',
				replacement: "",
				why: "No role is granted TEMPORARY."
			},
			{
				file: "packages/engine/src/deploy/admission/roles.ts",
				original: '\t\t\treturn [{ object: "", schema: "", name: "" }]',
				replacement: "\t\t\treturn []",
				why: "The drift check's expectation leaves the database's grant out."
			}
		]
	})
