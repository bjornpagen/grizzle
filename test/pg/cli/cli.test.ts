/**
 * `grizzle generate`, `check` and `migrate` on PostgreSQL 19 over drawn configurations, in the cases the workflow model
 * (workflow.test.ts) does not draw: several declared schemas, the ledger fixture's plan arms and derived relation,
 * an Effect password, the bin itself, and a role that does not own the schema.
 *
 * A case is a configuration: one to three declared schemas, each the shop at version 1 with its full workload, without
 * its customer lookup or with none, or the ledger with its law, derived relation and workload; and where migrate connects,
 * the configuration's connection: as the migration identity with its password or an Effect yielding it, or as a role
 * that does not own the declared schemas, which exist. The loop runs in an application directory with the lean config,
 * every command through one executor: the bin, `node packages/grizzle/src/cli/bin.ts`, as a child process whose
 * environment names another server, database, role, password and CA in the variables PostgreSQL clients read for a
 * connection, none of which the command line reads; or `runCli` in process. The property, by each schema's own model
 * (its directory, snapshot and ledger):
 * - generate, check and migrate exit 0; each schema's ledger records exactly its own folders, complete, its latest
 *   target its own committed snapshot's; an Effect password is evaluated for the connection;
 * - Db.open admits each schema as its writer and its reader, through its login's served file generate wrote, served
 *   as an application serves it, and the writer's served insert is accepted and the reader's served key reads it back;
 * - a second migrate exits 0 and changes no ledger.
 * When the role migrate connects as does not own the declared schemas, which exist, migrate exits 1 at the stage
 * owner (the typed refusal, in process) and nothing runs in any of them.
 *
 * The oracle is each schema's own model: its directory, its committed snapshot and its ledger.
 *
 * Features: each executor, several schemas, the ledger fixture, each connection, and the refusal of a role that does not
 * own the schemas by each executor, so in process its typed refusal at stage owner is read; the generator draws a case
 * whose turn aims at a refusal run by its executor as that role (aimed).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Redacted } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { defineConfig } from "#adapter/config/define.ts"
import { migrationConnection } from "#cli/connection.ts"
import { migrate, readTargets } from "#cli/migrate.ts"
import type { LedgerState } from "#compiler/deploy/ledger/ledger.ts"
import {
	type CliFeature,
	configGen,
	foldersOf,
	ledgerOf,
	refusalAims,
	roundTrip,
	runner,
	snapshotFilesOf
} from "#test/pg/cli/cli.fixtures.ts"
import {
	commandConnections,
	configName,
	configOf,
	connectionOf,
	type MemberConnection,
	ownerOn,
	resolvedConfig,
	type SchemaSpec,
	workspace,
	writeConfig
} from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Grizzle generate, check and migrate over drawn configurations every declared schema keeps its own directory, snapshot and ledger, is admitted and round-trips, by every executor and connection. */
export const configurations = property.explore(aimed(configGen, refusalAims), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"run by the bin",
		"run by in process",
		"several schemas",
		"the ledger fixture",
		"connected by the migration identity's password",
		"connected by an Effect password",
		"a role that does not own the schemas refused, run by the bin",
		"a role that does not own the schemas refused, run by in process"
	] satisfies ReadonlyArray<Reached<CliFeature>>,
	/** Its pre-conversion budget: runs 3, coverage cases 32 (cli.test.ts at bf4f43bb). */
	budget: { runs: 3, steered: 32 },
	check:
		({ caseSubstrate }, c: Case<CliFeature>) =>
		(sketch) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						c.note(`run by ${sketch.executor}`)
						c.note(`connected by ${sketch.connection}`)
						if (sketch.schemas.length > 1) {
							c.note("several schemas")
						}
						if (Arr.some(sketch.schemas, (s) => s.fixture === "ledger")) {
							c.note("the ledger fixture")
						}
						const intruding = sketch.connection === "a role that does not own the schemas"
						const names = yield* Effect.forEach(sketch.schemas, () =>
							substrate.schema({ create: intruding, label: "cliconf" })
						)
						const specs = Arr.map(sketch.schemas, (f, i): SchemaSpec =>
							f.fixture === "ledger"
								? { name: defined(names[i], "a schema name"), fixture: "ledger" }
								: {
										name: defined(names[i], "a schema name"),
										fixture: "shop",
										version: 1,
										workload: f.workload
									}
						)
						const intruder = intruding
							? yield* Effect.asSome(
									Effect.flatMap(substrate.schema({ create: false, label: "cliother" }), (other) =>
										substrate.role(other, "intruder")
									)
								)
							: Option.none()
						const connection: MemberConnection = Option.match(intruder, {
							onNone: (): MemberConnection => ({
								...ownerOn(substrate.cluster, substrate.database),
								as: {
									kind: "migration identity",
									password: sketch.connection === "an Effect password" ? "effect" : "owner"
								}
							}),
							onSome: (role): MemberConnection => ({
								...ownerOn(substrate.cluster, substrate.database),
								as: { kind: "role", role: role.role, password: Redacted.value(role.password) }
							})
						})
						const ws = yield* workspace("conf")
						yield* substrate.cluster.budget.within(commandConnections)
						yield* writeConfig(ws, { schemas: specs, connection })
						const run = runner(sketch.executor, ws, substrate.cluster.tls.caFile)

						const generateExit = yield* run(["generate", configName])
						assert.equal(generateExit, 0, "generate")
						const checkExit = yield* run(["check", configName])
						assert.equal(checkExit, 0, "check")
						if (Option.isSome(intruder)) {
							c.note(`a role that does not own the schemas refused, run by ${sketch.executor}`)
							const migrateExit = yield* run(["migrate", configName])
							assert.equal(migrateExit, 1, "migrate as a role that does not own the schemas")
							if (sketch.executor === "in process") {
								const config = yield* resolvedConfig(
									defineConfig(
										configOf({ schemas: specs, connection }, () =>
											connectionOf(substrate.cluster, connection)
										)
									),
									`${ws}/${configName}`
								)
								const resolved = succeeded(config)
								const intruderConnection = yield* migrationConnection(resolved)
								const targets = yield* readTargets(resolved)
								const refused = yield* Effect.flip(migrate(targets, intruderConnection))
								assert.equal(refused.stage, "owner")
							}
							for (const name of names) {
								const catalog = yield* readCatalog(substrate.admin, [name])
								assert.ok(catalog.kind === "present", `the schema ${name} exists`)
								assert.deepEqual(catalog.catalog.tables, [], `nothing ran in ${name}`)
							}
							return
						}
						const migrateExit = yield* run(["migrate", configName])
						assert.equal(migrateExit, 0, "migrate")
						const ledgers: Array<LedgerState> = []
						for (const [i, name] of names.entries()) {
							const state = yield* ledgerOf(name)
							const folders = yield* foldersOf(ws, name)
							assert.deepEqual(
								Arr.map(state.complete, (f) => f.folder),
								folders,
								`${name}'s ledger records its own folders`
							)
							assert.equal(state.partial, undefined, `${name}'s ledger records no partial folder`)
							const files = yield* snapshotFilesOf(ws, name)
							assert.equal(state.latest, succeeded(readSnapshot(files)).snapshot.fingerprint)
							yield* roundTrip(ws, name, defined(sketch.schemas[i], "the schema's fixture"), i + 1)
							ledgers.push(state)
						}
						const secondMigrateExit = yield* run(["migrate", configName])
						assert.equal(secondMigrateExit, 0, "a second migrate")
						for (const [i, name] of names.entries()) {
							const ledger = yield* ledgerOf(name)
							assert.deepEqual(
								ledger,
								defined(ledgers[i], `${name}'s ledger after the first migrate`),
								`the second migrate leaves ${name}'s ledger`
							)
						}
					})
				),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "each schema's own model: its directory, committed snapshot and ledger"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original:
				"\t\tif (owner !== undefined && owner !== user) {\n\t\t\treturn yield* Result.fail(stopped(new OwnedByAnother({ schema, owner, user })))\n\t\t}\n",
			replacement: "",
			why: "migrate's owner stage passes a schema another role owns, so in process the refusal of a role that does not own the schemas comes at a later stage than owner."
		}
	]
})
