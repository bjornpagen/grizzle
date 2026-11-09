import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Order,
	pipe,
	Redacted,
	String as Str
} from "effect"
import type { TestContext } from "vitest"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { defineConfig } from "#adapter/config/define.ts"
import { compiledOpen } from "#adapter/db/open.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { migrationConnection } from "#cli/connection.ts"
import { migrate } from "#cli/migrate.ts"
import type { LedgerState } from "#compiler/deploy/ledger/ledger.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { servedDirectory } from "#compiler/served/forms.ts"
import { ledger, shopV1 } from "#test/pg/cli/fixture.ts"
import {
	bin,
	type ConfigSpec,
	cli,
	cliClock,
	configName,
	configOf,
	ownerOn,
	resolvedConfig,
	type SchemaSpec,
	workspace,
	writeConfig
} from "#test/pg/cli/support.ts"
import { openMigrator } from "#test/pg/migrate/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { loginLayerOf } from "#test/support/installed.ts"
import { caseHang } from "#test/support/limits.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * `grizzle generate`, `check` and `migrate` on PostgreSQL 19 over drawn configurations, in the cases the workflow model
 * (workflow.test.ts) does not draw: several declared schemas, the ledger fixture's alternatives and derived relation,
 * an Effect password, the bin itself, and a role that does not own the schema.
 *
 * A case is a configuration: one to three declared schemas, each the shop at version 1 with its full workload, without
 * its customer lookup or with none, or the ledger with its law, derived relation and workload; and where migrate connects,
 * the configuration's connection: as the migration identity with its password or an Effect yielding it, or as a role
 * that does not own the declared schemas, which exist. The loop runs in an application directory with the lean config,
 * every command through one executor: the bin, `node packages/grizzle/src/cli/main.ts`, as a child process whose
 * environment names another server, database, role, password and CA in the variables PostgreSQL clients read for a
 * connection, none of which the command line reads; or `runCli` in process. The property, by each schema's own model
 * (its directory, snapshot and ledger):
 * - generate, check and migrate exit 0; each schema's ledger records exactly its own folders, complete, its latest
 *   target its own committed snapshot's; an Effect password is evaluated for the connection;
 * - Db.open admits each schema as its writer and its reader, through its login's layer given its committed
 *   snapshot.json, which records the login's workload, a write is accepted and read back;
 * - a second migrate exits 0 and changes no ledger.
 * When the role migrate connects as does not own the declared schemas, which exist, migrate exits 1 at the stage
 * owner (the typed refusal, in process) and nothing runs in any of them.
 */
type Executor = "the bin" | "in process"
type Fixture =
	| { readonly fixture: "shop"; readonly workload: "full" | "withoutByName" | "none" }
	| { readonly fixture: "ledger" }
type Connection =
	| "the migration identity's password"
	| "an Effect password"
	| "a role that does not own the schemas"

interface ConfigSketch {
	readonly executor: Executor
	readonly schemas: ReadonlyArray<Fixture>
	readonly connection: Connection
}

const fixtureGen: Gen<Fixture> = oneOf<Fixture>([
	(source) => ({
		fixture: "shop",
		workload: source.draw(element(["full", "withoutByName", "none"] as const))
	}),
	constant({ fixture: "ledger" })
])

const configGen: Gen<ConfigSketch> = (source) => ({
	executor: source.draw(element<Executor>(["the bin", "in process"])),
	schemas: source.draw(array(fixtureGen, { min: 1, max: 3 })),
	connection: source.draw(
		element<Connection>([
			"the migration identity's password",
			"an Effect password",
			"a role that does not own the schemas"
		])
	)
})

type CliFeature =
	| `run by ${Executor}`
	| "several schemas"
	| "the ledger fixture"
	| `connected by ${Connection}`
	| "a role that does not own the schemas refused"

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The texts of a schema's committed snapshot files. */
const snapshotFilesOf = (dir: string, schema: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const snapshot = yield* fs.readFileString(`${dir}/migrations/${schema}/snapshot.json`)
		const manifest = yield* fs.readFileString(`${dir}/migrations/${schema}/manifest.json`)
		return { snapshot, manifest }
	})

const foldersOf = (dir: string, schema: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* fs.readDirectory(`${dir}/migrations/${schema}`)
		return Arr.sort(
			Arr.filter(
				entries,
				(n) =>
					n !== "snapshot.json" &&
					n !== "manifest.json" &&
					n !== servedDirectory &&
					!Str.startsWith(".")(n)
			),
			Order.String
		)
	})

/** The ledger of a schema, as grizzle migrate reads it. */
const ledgerOf = (schema: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, substrate.owner)
		return yield* readLedger(migrator, schema, succeeded(statementsFor(schema)))
	}).pipe(Effect.scoped)

/**
 * What the bin's environment names in the variables PostgreSQL clients read for a connection: another server,
 * database, role, password and CA, none of which exists. The command line reads none of them.
 */
const strayEnvironment: Readonly<Record<string, string>> = {
	DATABASE_URL:
		"postgresql://nobody:nothing@stray.invalid:1/nowhere?sslrootcert=/nonexistent/ca.crt",
	PGHOST: "stray.invalid",
	PGPORT: "1",
	PGDATABASE: "nowhere",
	PGUSER: "nobody",
	PGPASSWORD: "nothing",
	PGSSLMODE: "disable",
	PGSSLROOTCERT: "/nonexistent/ca.crt"
}

/** A command line run by the case's executor, its exit code. */
const runner = (executor: Executor, dir: string) => (argv: ReadonlyArray<string>) =>
	executor === "in process"
		? Effect.map(cli(dir, argv, nextNow()), (r) => r.code)
		: Effect.map(bin(dir, argv, strayEnvironment), (r) => r.status)

/**
 * A customer written as the writer and read back as the reader, through the login's layer given the committed
 * snapshot, for a shop or a ledger.
 */
const roundTrip = (name: string, fixture: Fixture, snapshot: string, n: number) =>
	Effect.gen(function* () {
		const committed = snapshotJson(snapshot)
		if (fixture.fixture === "shop") {
			const s = shopV1(name, fixture.workload)
			const loginLayer = yield* loginLayerOf(s.server, committed)
			const outcome = yield* Effect.scoped(
				Effect.flatMap(compiledOpen(s.server.roles.writer, {}), (db) =>
					db.apply(ChangeSet.empty(s.schema).insert(s.Customer, [{ id: id(n), name: "ada" }]), {})
				)
			).pipe(withLayer(loginLayer))
			assert.equal(outcome.kind, "accepted")
			const rows = yield* Effect.scoped(
				Effect.flatMap(compiledOpen(s.server.roles.reader, {}), (db) =>
					Effect.flatMap(db.execute(s.customersByName, { name: "ada" }), (r) => r.collect)
				)
			).pipe(withLayer(loginLayer))
			assert.deepEqual(
				Arr.map(rows, (r) => r.id),
				[id(n)]
			)
			return
		}
		const l = ledger(name)
		const loginLayer = yield* loginLayerOf(l.server, committed)
		const outcome = yield* Effect.scoped(
			Effect.flatMap(compiledOpen(l.server.roles.writer, {}), (db) =>
				db.apply(ChangeSet.empty(l.schema).insert(l.Customer, [{ id: id(n), name: "ada" }]), {})
			)
		).pipe(withLayer(loginLayer))
		assert.equal(outcome.kind, "accepted")
		const rows = yield* Effect.scoped(
			Effect.flatMap(compiledOpen(l.server.roles.reader, {}), (db) =>
				Effect.flatMap(db.execute(l.customersByName, { name: "ada" }), (r) => r.collect)
			)
		).pipe(withLayer(loginLayer))
		assert.deepEqual(
			Arr.map(rows, (r) => r.id),
			[id(n)]
		)
	})

const configurations = (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				oracle: { kind: "unstated" },
				suite: "cli/configurations",
				draw: drawn(configGen),
				literal: Formatter.format,
				kept: [],
				runs: 3,
				shrink: { kind: "bounded", candidates: 10 },
				concurrency: 1,
				steerEvery: 16,
				caseHang,
				coverage: required<CliFeature>(
					[
						"run by the bin",
						"run by in process",
						"several schemas",
						"the ledger fixture",
						"connected by the migration identity's password",
						"connected by an Effect password",
						"a role that does not own the schemas refused"
					],
					{ cases: 32, sense: notesOnly }
				)
			},
			(sketch, c) =>
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
						const connection: ConfigSpec["connection"] = Option.match(intruder, {
							onNone: (): ConfigSpec["connection"] => ({
								...ownerOn(substrate.database),
								as: {
									kind: "migration identity",
									password: sketch.connection === "an Effect password" ? "effect" : "owner"
								}
							}),
							onSome: (role): ConfigSpec["connection"] => ({
								...ownerOn(substrate.database),
								as: { kind: "role", role: role.role, password: Redacted.value(role.password) }
							})
						})
						const ws = yield* workspace("conf")
						yield* writeConfig(ws, { schemas: specs, connection })
						const run = runner(sketch.executor, ws)

						const generateExit = yield* run(["generate", configName])
						assert.equal(generateExit, 0, "generate")
						const checkExit = yield* run(["check", configName])
						assert.equal(checkExit, 0, "check")
						if (Option.isSome(intruder)) {
							c.note("a role that does not own the schemas refused")
							const migrateExit = yield* run(["migrate", configName])
							assert.equal(migrateExit, 1, "migrate as a role that does not own the schemas")
							if (sketch.executor === "in process") {
								const config = yield* resolvedConfig(
									defineConfig(configOf(substrate.cluster, { schemas: specs, connection })),
									`${ws}/${configName}`
								)
								const resolved = succeeded(config)
								const intruderConnection = yield* migrationConnection(resolved)
								const refused = yield* Effect.flip(migrate(resolved, intruderConnection))
								assert.ok(refused._tag === "MigrateError", `a MigrateError, not ${refused._tag}`)
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
							yield* roundTrip(
								name,
								defined(sketch.schemas[i], "the schema's fixture"),
								files.snapshot,
								i + 1
							)
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
				)
		)
	)

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"grizzle generate, check and migrate over drawn configurations",
	(it) => {
		it.effect(
			"every declared schema keeps its own directory, snapshot and ledger, is admitted and round-trips, by every executor and connection",
			configurations
		)
	}
)
