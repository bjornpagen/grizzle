/** What the properties of cli.test.ts read: its spaces, models and helpers. */

import { array, constant, element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Option, pipe, String as Str } from "effect"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { Db } from "#adapter/public/db.ts"

import { assert } from "@bjornpagen/testing/assert"
import { readLedger } from "#adapter/migrate/apply.ts"
import { ledger, shopV1 } from "#test/pg/cli/fixture.ts"
import { bin, cli, harnessCaVariable, servedFromFile } from "#test/pg/cli/support.ts"
import { openMigrator } from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { writeAnswerOf, oneOf as oneRowOf } from "#test/support/calls.ts"
import { chunked } from "#test/support/chunked.ts"
import { type IdValue, toId } from "#test/support/ids.ts"
import { migrationFolders } from "#test/support/migrate/kit.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const executors = ["the bin", "in process"] as const

type Executor = (typeof executors)[number]

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

export const configGen: Gen<ConfigSketch> = (source) => ({
	executor: source.draw(element<Executor>(executors)),
	schemas: source.draw(array(fixtureGen, { min: 1, max: 3 })),
	connection: source.draw(
		element<Connection>([
			"the migration identity's password",
			"an Effect password",
			"a role that does not own the schemas"
		])
	)
})

/**
 * The configurations aimed at a refusal by an executor, each by its situation: the drawn configuration run by that
 * executor and connected as a role that does not own the schemas, which a case whose turn aims at the refusal draws
 * (aimed). The steered phase reaches each refusal so, which a draw of the executor and the connection apart reaches
 * rarely.
 */
export const refusalAims: ReadonlyArray<readonly [CliFeature, Gen<ConfigSketch>]> = Arr.map(
	executors,
	(executor): readonly [CliFeature, Gen<ConfigSketch>] => [
		`a role that does not own the schemas refused, run by ${executor}`,
		map(configGen, (sketch) => ({
			...sketch,
			executor,
			connection: "a role that does not own the schemas"
		}))
	]
)

export type CliFeature =
	| `run by ${Executor}`
	| "several schemas"
	| "the ledger fixture"
	| `connected by ${Connection}`
	| `a role that does not own the schemas refused, run by ${Executor}`

const id = (n: number): IdValue =>
	toId(`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`)

/** The texts of a schema's committed snapshot files. */
export const snapshotFilesOf = (dir: string, schema: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const snapshot = yield* fs.readFileString(`${dir}/migrations/${schema}/snapshot.json`)
		const manifest = yield* fs.readFileString(`${dir}/migrations/${schema}/manifest.json`)
		return { snapshot: chunked(snapshot), manifest: chunked(manifest) }
	})

export const foldersOf = (dir: string, schema: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* fs.readDirectory(`${dir}/migrations/${schema}`)
		return migrationFolders(entries)
	})

/** The ledger of a schema, as grizzle migrate reads it. */
export const ledgerOf = (schema: string) =>
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

/**
 * A command line run by the case's executor, its exit code: the bin's under strayEnvironment, with `caFile`, the case's
 * member's CA, named for the test's own reads of the cluster in it (support.ts harnessCaVariable).
 */
export const runner =
	(executor: Executor, dir: string, caFile: string) => (argv: ReadonlyArray<string>) =>
		executor === "in process"
			? Effect.map(cli(dir, argv), (r) => r.code)
			: Effect.map(
					bin(dir, argv, { ...strayEnvironment, [harnessCaVariable]: caFile }),
					(r) => r.status
				)

/**
 * A customer written as the writer and read back as the reader, through the login's served file generate wrote in the
 * workspace `dir`, served and laid over the database as an application serves it (support.ts servedFromFile): the
 * writer's `addCustomer` with the customer as its call's facts, then the reader's `customer` by its id, for a shop or a
 * ledger.
 */
export const roundTrip = (dir: string, name: string, fixture: Fixture, n: number) =>
	Effect.gen(function* () {
		if (fixture.fixture === "shop") {
			const s = yield* servedFromFile(dir, name, shopV1(name, fixture.workload).server)
			const outcome = yield* Effect.scoped(
				Effect.flatMap(Db.open(s.login.roles.writer, {}), (db) =>
					writeAnswerOf(
						db.workload.addCustomer.once({
							params: {},
							facts: { insert: { Customer: [{ id: id(n), name: "ada" }] } }
						})
					)
				)
			).pipe(withLayer(s.layer))
			assert.equal(outcome.kind, "accepted")
			const row = yield* Effect.scoped(
				Effect.flatMap(Db.open(s.login.roles.reader, {}), (db) =>
					oneRowOf(db.workload.customer.once({ params: { id: id(n) }, facts: {} }))
				)
			).pipe(withLayer(s.layer))
			assert.deepEqual(
				Option.map(row, (r) => r.id),
				Option.some(id(n))
			)
			return
		}
		const l = yield* servedFromFile(dir, name, ledger(name).server)
		const outcome = yield* Effect.scoped(
			Effect.flatMap(Db.open(l.login.roles.writer, {}), (db) =>
				writeAnswerOf(
					db.workload.addCustomer.once({
						params: {},
						facts: { insert: { Customer: [{ id: id(n), name: "ada" }] } }
					})
				)
			)
		).pipe(withLayer(l.layer))
		assert.equal(outcome.kind, "accepted")
		const row = yield* Effect.scoped(
			Effect.flatMap(Db.open(l.login.roles.reader, {}), (db) =>
				oneRowOf(db.workload.customer.once({ params: { id: id(n) }, facts: {} }))
			)
		).pipe(withLayer(l.layer))
		assert.deepEqual(
			Option.map(row, (r) => r.id),
			Option.some(id(n))
		)
	})
