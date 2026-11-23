/**
 * `grizzle upgrade` on PostgreSQL 19, through the command line (cli/upgrade.ts): a live installation rebased onto this
 * grizzle's compile of the source it was deployed from, whatever format its committed snapshot is.
 *
 * - **Property:** the box's roster's whole history (test/pg/cli/upgrade.fixtures.ts kinds): Kind of a, b and c, then
 *   b removed (a hole), then c renamed d, then a and d swapping names, each version generated and migrated through the
 *   command line, items stored at each, holding codes. Then each set of the changes a format's change of what
 *   grizzle installs makes, done by hand: a function renamed, its trigger calling it under its old name; a stray
 *   constant; a function defined otherwise; format 7's leftovers, the database's default isolation SERIALIZABLE, as
 *   format 7 and every format before it set it, and a replication slot named as its leader named one, by its decoder
 *   login. snapshot.json is set to another format, so no command reads it. `grizzle upgrade`, then `check`, `migrate`
 *   and `drift`, each succeed. The migrations directory's snapshot and served files are byte for byte the ones generate
 *   wrote at the last version, a fresh draft of the same history under this grizzle; with no change by hand, nothing
 *   else is written (a rebase of the snapshot alone), and with any, one folder `<timestamp>_upgrade`. The stored items
 *   hold the codes they held. The database holds no default isolation after the fresh install, as grizzle sets none,
 *   and none after the upgrade, which resets a former one; and no slot of a former leader stands after it, which drops
 *   it.
 * - **Oracle:** the history itself: generate's own files at the last version, and the drift check, which judges the
 *   database by them after the upgrade's migrate.
 * - **Kills:** the drift identity check skipped (a stale object read as held, never replaced); the codes minted from the
 *   source alone (a roster with a hole, a renamed handle or a swap names no live constant, refused); a former database
 *   default read as none (left, never reset); a former leader's slot read as none (left, holding its WAL).
 * - **Box, exhausted:** each subset of the four changes over the whole history, sixteen cases.
 * - **Features:** each change, none, a hole, a renamed handle, a handle swap, a rebase of the snapshot alone, an
 *   upgrade folder.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem } from "effect"
import { artifactFormat } from "#compiler/core/format.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { defineConfig } from "#index.ts"
import { at } from "#test/pg/cli/drift.fixtures.ts"
import { cliOver, configName, connectionOf, ownerOn, workspace } from "#test/pg/cli/support.ts"
import {
	caseGen,
	committedFiles,
	databaseIsolation,
	declaredAt,
	formerSlotOf,
	filesUnder,
	historyFeatures,
	itemRows,
	kinds,
	otherFormat,
	sameFiles,
	shiftStatements,
	slotDropped,
	slotsNamed,
	storeItems,
	type UpgradeFeature,
	upgradeFolders,
	type Version
} from "#test/pg/cli/upgrade.fixtures.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** An upgrade rebases a live installation of any roster history onto this grizzle's compile, its snapshot and served files generate's own, a folder only where the database holds the compile otherwise, and every stored code kept. */
export const anUpgradeRebasesALiveInstallationOfAnyRosterHistoryOntoThisGrizzlesCompileItsSnapshotAndServedFilesGeneratesOwnAFolderOnlyWhereTheDatabaseHoldsTheCompileOtherwiseAndEveryStoredCodeKept =
	property.exhaust(finite(caseGen), {
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		box: "the roster's whole history, a hole, a renamed handle and a swap, under each subset of the four shifts, the empty one included",
		situations: [
			"a function renamed",
			"a stray constant",
			"a function defined otherwise",
			"format 7's leftovers",
			"no shift",
			"a hole",
			"a renamed handle",
			"a handle swap",
			"a rebase of the snapshot alone",
			"an upgrade folder"
		] satisfies ReadonlyArray<Reached<UpgradeFeature>>,
		check:
			({ caseSubstrate }, c: Case<UpgradeFeature>) =>
			(x) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const fs = yield* FileSystem.FileSystem
						const name = yield* substrate.schema({ create: false, label: "upgrade" })
						const ws = yield* workspace("upgrade")
						const configAt = (version: Version) => {
							const box = kinds(name, version)
							return defineConfig({
								schemas: [box.schema],
								logins: [box.server],
								migrations: "migrations",
								rolePrefixBytes: 0,
								connection: () =>
									connectionOf(substrate.cluster, ownerOn(substrate.cluster, substrate.database))
							})
						}
						const run = (version: Version, argv: ReadonlyArray<string>) =>
							cliOver(ws, configAt(version), argv, at)
						const schemaName = identifierOf(identity.schema(parsedSchemaName(name)))
						const versions = Arr.filter([1, 2, 3, 4] as const, (v) => v <= x.version)
						for (const version of versions) {
							const generated = yield* run(version, [
								"generate",
								configName,
								...declaredAt[version]
							])
							assert.equal(generated.code, 0, `generate version ${version}: ${generated.stderr}`)
							const migrated = yield* run(version, ["migrate", configName])
							assert.equal(migrated.code, 0, `migrate version ${version}: ${migrated.stderr}`)
							yield* substrate.admin.pipeline(storeItems(schemaName, version))
						}
						const installedIsolation = yield* databaseIsolation(substrate.database)
						assert.deepEqual(
							installedIsolation,
							[],
							"a fresh install sets no default isolation: every session grizzle does not open starts at the server's"
						)
						c.noteAll(historyFeatures(x.version))
						const directory = `${ws}/migrations/${schemaName}`
						const generatedFiles = yield* filesUnder(directory)
						const stored = yield* itemRows(schemaName)
						const formerSlot = formerSlotOf(schemaName)
						yield* Effect.addFinalizer(() => slotDropped(formerSlot))
						for (const shift of x.shifts) {
							for (const sql of yield* shiftStatements(shift, schemaName, substrate.database)) {
								yield* substrate.admin.query(sql, [])
							}
							c.note(shift)
						}
						if (x.shifts.length === 0) {
							c.note("no shift")
						}
						const snapshotPath = `${directory}/snapshot.json`
						const text = yield* Effect.orDie(fs.readFileString(snapshotPath))
						yield* Effect.orDie(
							fs.writeFileString(snapshotPath, otherFormat(text, artifactFormat - 1))
						)
						for (const command of ["upgrade", "check", "migrate", "drift"]) {
							const ran = yield* run(x.version, [command, configName])
							assert.equal(ran.code, 0, `grizzle ${command} after the upgrade: ${ran.stderr}`)
						}
						const upgraded = yield* filesUnder(directory)
						sameFiles(
							committedFiles(upgraded),
							generatedFiles,
							"the snapshot and served files the upgrade writes are generate's"
						)
						const folders = upgradeFolders(upgraded)
						if (x.shifts.length === 0) {
							assert.deepEqual(
								folders,
								[],
								"a database holding the compile whole: the snapshot alone"
							)
							c.note("a rebase of the snapshot alone")
						} else {
							assert.equal(
								folders.length,
								1,
								"a database holding the compile otherwise: one folder"
							)
							c.note("an upgrade folder")
						}
						const upgradedIsolation = yield* databaseIsolation(substrate.database)
						assert.deepEqual(
							upgradedIsolation,
							[],
							"after the upgrade the database holds no default isolation: a former one is reset"
						)
						const leftSlots = yield* slotsNamed(formerSlot)
						assert.deepEqual(
							leftSlots,
							[],
							"after the upgrade no slot a former leader made stands: the upgrade drops it"
						)
						const kept = yield* itemRows(schemaName)
						assert.deepEqual(kept, stored, "every stored code is kept")
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "generate's own files at the history's last version, and the drift check judging the database by them"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: "\t\t\tstale.add(object)",
				replacement: "\t\t\theld.add(object)",
				why: "The drift identity check skipped: a function or trigger the database defines otherwise is read as held and never replaced, and migrate's drift check refuses the database."
			},
			{
				file: "packages/engine/src/deploy/upgrade/history.ts",
				original: "\t\t\tconst codec = rosterCodec(roster.closed, c.names.map(slotOf))",
				replacement:
					'\t\t\tconst codec = rosterCodec(\n\t\t\t\troster.closed,\n\t\t\t\troster.handles.map((handle): CodeSlot => ({ kind: "live", handle }))\n\t\t\t)',
				why: "The codes minted from the source alone re-code every stored value: a history with a hole, a renamed handle or a swap names no live constant, and the upgrade is refused."
			},
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: "\tif (found.formerDefault) {",
				replacement: "\tif (!found.formerDefault) {",
				why: "A former database default read as none: the upgrade leaves SERIALIZABLE as the database's default, and resets one where none is held, a folder where the database holds the compile whole."
			},
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: "\tfor (const name of found.formerSlots) {",
				replacement: "\tfor (const name of []) {",
				why: "A former leader's slot read as none: the upgrade leaves it standing, holding its WAL on the server, where nothing else drops it."
			}
		]
	})
