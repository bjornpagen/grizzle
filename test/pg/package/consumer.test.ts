import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Path,
	Redacted,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { writeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { caseHang, testConnectTimeout, testIdleTimeout } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld, loginLayer } from "#test/support/worlds.ts"
import { exitedCleanly, publishedProject, runChild } from "#test/unit/dev/published.ts"

/**
 * The published package against the dev cluster: a consumer's program, run by Node from a project whose node_modules
 * holds the built packages (test/unit/dev/published.ts), declares a schema, its full role and a login over it, builds
 * the login's DbLayer from the committed snapshot.json and the cluster's connection, opens a Db of the role with
 * Db.open, and reads every note once. The schema is installed through its first migration under an allocated name
 * (test/support/install-migrate.ts), which the consumer declares it under; the test writes each case's notes through a
 * Db of its own, and the consumer must read exactly every note written so far: a model of the table, the notes the
 * cases wrote.
 */
const Note = relation("Note", { id: uuid, n: pg.integer }, ["id"])

const declared = (name: string) => schema(name, { Note }, [])

/**
 * The consumer, as an application writes it against the published package: the same schema under the name it was
 * installed under, the same full role and login (test/support/worlds.ts fullWorld), and one read of every note.
 */
const consumerProgram = `import { readFileSync } from "node:fs"
import net from "node:net"
import { Effect, Redacted } from "effect"
import pgDriver from "pg"
import { Db, DbLayer, login, pg, query, relation, role, schema, uuid, v } from "@bjornpagen/grizzle"

const config = JSON.parse(readFileSync(process.argv[2], "utf8"))
const Note = relation("Note", { id: uuid, n: pg.integer }, ["id"])
const App = schema(config.schema, { Note }, [])
const app = role(App, "app", { Note }, { write: ["Note"] })
const server = login(App, "server", [app])
const notes = query(App).rule((r) => {
	const { id, n } = v(Note, "note")
	return r.match(Note, { id, n }).find({ id, n })
})
const layer = DbLayer.make({
	driver: pgDriver,
	transport: {
		kind: "sslRequest",
		host: config.host,
		port: config.port,
		open: () => new net.Socket(),
		ca: config.ca,
		servername: config.host
	},
	database: config.database,
	password: Redacted.make(config.password),
	connectTimeoutMs: config.connectTimeoutMs,
	pool: { max: 1, min: 0, idleTimeoutMs: config.idleTimeoutMs },
	login: server,
	snapshot: JSON.parse(readFileSync(config.snapshot, "utf8"))
})
const rows = await Effect.runPromise(
	Effect.gen(function* () {
		const db = yield* Db.open(server.roles.app, {})
		return yield* (yield* db.execute(notes, {})).collect
	}).pipe(Effect.provide(layer))
)
process.stdout.write(JSON.stringify(rows) + "\\n")
`

/** A note as the consumer reads it: its id and its number. */
interface NoteRow {
	readonly id: string
	readonly n: number
}

/** One to three notes' numbers. */
const numbersGen: Gen<ReadonlyArray<number>> = array(int(-1000, 1000), { min: 1, max: 3 })

/** The uuid of the `i`th note written. */
const noteId = (i: number): Uuid => `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(i))}`

type ConsumerFeature = "one note" | "several notes" | "a read after an earlier write"

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"the published package on the dev cluster",
	(it) => {
		it.effect(
			"opens a role of a login with the built package's Db.open and reads exactly every note written so far",
			(ctx) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const published = yield* publishedProject
					const Consumer = declared("Consumer")
					const world = fullWorld(Consumer)
					const installed = yield* installMigrated(Consumer, {
						ambient: ordinarySession,
						label: "consumer",
						logins: [world.server],
						extensions: []
					})
					const App = declared(installed.declared)
					const own = fullWorld(App)
					const snapshot = path.join(published.project, "snapshot.json")
					yield* fs.writeFileString(snapshot, succeeded(writeSnapshot(installed.snapshot)).snapshot)
					const program = path.join(published.project, "consumer.mjs")
					yield* fs.writeFileString(program, consumerProgram)
					const config = path.join(published.project, "config.json")
					yield* fs.writeFileString(
						config,
						jsonText({
							schema: installed.declared,
							host: pgPin.host,
							port: pgPin.port,
							ca: installed.cluster.caPem,
							database: installed.database,
							password: Redacted.value(installed.as(world.server).password),
							connectTimeoutMs: testConnectTimeout.value,
							idleTimeoutMs: testIdleTimeout.value,
							snapshot
						})
					)
					const written: Array<NoteRow> = []
					return yield* searched(
						ctx,
						explore(
							{
								suite: "package/consumer",
								draw: drawn(numbersGen),
								literal: Formatter.format,
								oracle: {
									kind: "specification",
									name: "the notes the cases wrote, each read once by the built package"
								},
								coverage: required<ConsumerFeature>(
									["one note", "several notes", "a read after an earlier write"],
									{ cases: 8, sense: notesOnly }
								),
								kept: [],
								runs: 2,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(numbers, c) =>
								Effect.gen(function* () {
									const notes = Arr.map(numbers, (n, i) => ({ id: noteId(written.length + i), n }))
									c.note(notes.length === 1 ? "one note" : "several notes")
									if (Arr.isReadonlyArrayNonEmpty(written)) {
										c.note("a read after an earlier write")
									}
									const outcome = yield* Effect.gen(function* () {
										const db = yield* Db.open(own.server.roles.app, {})
										return yield* db.apply(ChangeSet.empty(App).insert(Note, notes), {})
									}).pipe(withLayer(loginLayer(installed, own.server)))
									assert.equal(outcome.kind, "accepted")
									for (const note of notes) {
										written.push(note)
									}
									const read = yield* runChild(
										process.execPath,
										[program, config],
										published.project
									)
									assert.equal(read.exitCode, exitedCleanly, `the consumer: ${read.stderr}`)
									unorderedEqual(
										trustedJson<ReadonlyArray<NoteRow>>(Str.trim(read.stdout)),
										written
									)
								})
						)
					)
				})
		)
	}
)
