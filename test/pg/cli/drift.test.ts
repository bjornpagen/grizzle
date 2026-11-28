/**
 * `grizzle drift` against changes made by hand to the objects a world installs, on PostgreSQL 19, searched: drift
 * passes on a fresh installation; once any set of objects is changed by hand it refuses with Drifted, a mismatch of
 * which names each changed object; once the changes are undone it passes again.
 *
 * The installation is the worlds fixture (fixture.ts): `editor` reads Doc and inserts into Mine, the notes of the
 * documents its session's subject owns, under row security, through a filter that reads Doc beside Note; `viewer` reads
 * Doc; `keeper` writes Doc through a put whose flight fills a carrier, in its transaction's settings, so no role holds
 * TEMPORARY on the database; all in the login `desk`. It is generated and migrated through the command line once. Each case draws, for
 * every operator below, whether it plants a change and where, its target picked among what the installed catalog holds,
 * and makes every drawn change at once as the cluster's superuser:
 *
 * - a role's view loses or gains its security barrier;
 * - row security is disabled on a table a role writes under it;
 * - a role's policy is widened to PUBLIC;
 * - a function a world reads changes its volatility;
 * - a role or the login is granted a table privilege, of PostgreSQL's, it holds neither on the table nor on any of its
 *   columns, so revoking it again restores the catalog exactly (a REVOKE on a table revokes that privilege on every
 *   column too);
 * - a role or the login stores a setting;
 * - a role or the login gains an attribute the snapshot denies it, of PostgreSQL's role attributes the test's
 *   administrator may set;
 * - one role becomes a member of the other;
 * - a table is created in a schema of views, a role's or the schema of whole views;
 * - a role or the login is granted TEMPORARY on the database, which no installation grants any role.
 *
 * A grant or revoke on the database runs under the lock every installation's does (test/support/substrate/substrate.ts
 * underDatabaseLock), since the files of a run share the database's one pg_database row.
 *
 * The oracle is PostgreSQL's catalog as the drift check reads it: drift refuses exactly when a change was made, its
 * mismatches naming every changed object, and passes once every change is undone.
 *
 * Features: every operator planted, nothing planted, several at once, and a privilege granted beside the role's
 * column grants, which the generator constructs for a case whose turn aims at it: the editor's first privilege on Note,
 * whose columns the editor holds SELECT on.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { defineConfig } from "#index.ts"
import {
	aimedPlantsGen,
	type Change,
	changeOf,
	type DriftFeature,
	type DriftNames,
	pickedTables,
	plantedOf,
	plantsFeatures
} from "#test/pg/cli/drift.fixtures.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { worlds } from "#test/support/pg/cli/fixture.ts"
import {
	cliOver,
	configName,
	connectionOf,
	driftMismatches,
	ownerOn,
	workspace
} from "#test/support/pg/cli/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Grizzle drift over a world's objects passes on a fresh installation, refuses any set of hand changes to a world's objects naming each, and passes once they are undone. */
export const drift = property.explore(steered(aimedPlantsGen), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a view's security barrier",
		"row security disabled",
		"a policy widened",
		"a function's volatility",
		"a privilege granted",
		"a role's setting",
		"a role's attribute",
		"a membership granted",
		"a table in a schema of views",
		"a TEMPORARY grant beyond the snapshot",
		"a privilege granted beside the role's column grants",
		"nothing planted",
		"several planted"
	] satisfies ReadonlyArray<Reached<DriftFeature>>,
	/** Its pre-conversion budget: runs 4, coverage cases 16 (drift.test.ts at bf4f43bb). */
	budget: { runs: 4, steered: 16 },
	check:
		({ caseSubstrate }, c: Case<DriftFeature>) =>
		(plants) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const name = yield* substrate.schema({ create: false, label: "drift" })
					const w = worlds(name)
					const ws = yield* workspace("drift")
					const config = defineConfig({
						schemas: [w.schema],
						logins: [w.desk],
						migrations: "migrations",
						rolePrefixBytes: 0,
						connection: () =>
							connectionOf(substrate.cluster, ownerOn(substrate.cluster, substrate.database))
					})
					const run = (command: string) => cliOver(ws, config, [command, configName])
					const fresh = yield* Effect.forEach(["generate", "migrate", "drift"], (command) =>
						Effect.map(run(command), (ran) => ({ command, ran }))
					)
					for (const { command, ran } of fresh) {
						assert.equal(ran.code, 0, `grizzle ${command} on a fresh installation: ${ran.stderr}`)
					}
					const installation = identity.schema(parsedSchemaName(name))
					/** The installation's schemas of views: the editor's, of its query entries, and the schema of whole views,
					 * which every role reads the documents it holds whole through; the viewer, holding them whole alone, has
					 * none of its own. */
					const editorSchema = identifierOf(
						identity.roleSchema(identity.role(installation, parsedName("editor")))
					)
					const names: DriftNames = {
						database: substrate.database,
						schema: identifierOf(installation),
						tables: Arr.map(pickedTables, (t) => identifierOf(identity.table(parsedName(t)))),
						editor: roleNameOf(w.editor, {}),
						viewer: roleNameOf(w.viewer, {}),
						keeper: roleNameOf(w.keeper, {}),
						login: roleNameOf(w.desk, {}),
						viewSchemas: [
							editorSchema,
							identifierOf(identity.wholeSchema(identifierOf(installation)))
						]
					}

					c.noteAll(plantsFeatures(plants))
					const planted = plantedOf(plants)
					const changes = yield* Effect.forEach(planted, ([kind, picks]) =>
						changeOf(kind, picks, names)
					)
					c.noteAll(Arr.flatMap(changes, (change) => change.reaches))
					const made: Array<Change> = []
					const plant = Effect.forEach(
						changes,
						(change) =>
							Effect.andThen(
								Effect.forEach(change.plant, (sql) => substrate.admin.query(sql, []), {
									discard: true
								}),
								Effect.sync(() => {
									made.push(change)
								})
							),
						{ discard: true }
					)
					const undo = Effect.suspend(() =>
						Effect.flatMap(
							Effect.forEach(Arr.reverse(Arr.flatMap(made, (change) => change.undo)), (sql) =>
								Effect.result(substrate.admin.query(sql, []))
							),
							(results) =>
								Effect.orDie(Effect.forEach(results, Effect.fromResult, { discard: true }))
						)
					)
					const drifted = yield* Effect.ensuring(
						Effect.flatMap(plant, () => run("drift")),
						undo
					)
					if (changes.length === 0) {
						assert.equal(drifted.code, 0, `nothing planted: ${drifted.stderr}`)
						return
					}
					assert.equal(drifted.code, 1, drifted.stdout)
					const mismatches = driftMismatches(drifted)
					for (const change of changes) {
						assert.ok(
							Arr.some(mismatches, (m) => Str.includes(change.named)(m)),
							`a mismatch names ${change.named}: ${Arr.join(mismatches, "; ")}`
						)
					}
					const undone = yield* run("drift")
					assert.equal(undone.code, 0, `undone: ${undone.stderr}`)
				}).pipe(Effect.scoped),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "the catalog PostgreSQL holds after the changes by hand, as the drift check reads it"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original:
				"\tconst mismatches = [...ledgerMismatches(snapshot, ledger), ...verdict.mismatches]",
			replacement: "\tconst mismatches = [...ledgerMismatches(snapshot, ledger)]",
			why: "The drift check compares no catalog fact, so drift passes over every change made by hand."
		}
	]
})
