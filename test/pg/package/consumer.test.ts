/**
 * The package as a submodule consumer takes it, against the dev cluster: a consumer's program, run by plain Node from a
 * project whose node_modules links the package's source as a pnpm workspace does (test/unit/dev/consumer.ts), serves
 * its login's committed served file with the runtime entry's served(file, name), builds the login's DbLayer of it and the cluster's connection, opens a Db of the role with
 * Db.open, and reads every note once through its workload's member. The schema is installed under an allocated name as
 * `grizzle generate` drafts and serves it with its login (test/support/install-migrate.ts installGenerated), and the
 * login's served file is the one generate wrote, written as generate writes it. The test writes each case's notes through a Db of its own, and the consumer must read exactly
 * every note written so far: a model of the table, the notes the cases wrote, compared as a set.
 *
 * Features: a case of one note and one of several, and a read after an earlier case's write.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): package-role-misnamed (the runtime entry's served(file, name) serves
 * each role under a name the file does not hold).
 */
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
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { pgPin } from "#test/support/env.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { caseHang, testConnectTimeout, testIdleTimeout } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import { consumerProject, exitedCleanly, runChild } from "#test/unit/dev/consumer.ts"

const Note = relation("Note", { id: uuid, n: pg.integer }, ["id"])

const declared = (name: string) => schema(name, [Note], [])

/** Every note, the one read the consumer's workload serves. */
const notesOf = (base: ReturnType<typeof declared>) =>
	query(base).rule((r) => {
		const { id, n } = v(Note, "note")
		return r.match(Note, { id, n }).find({ id, n })
	})

/**
 * The consumer, as an application writes it against the package: the login's served file, served under the
 * login's name, its layer given its installation's live source (LiveSource.layer), the full role's Db of it
 * (test/support/worlds.ts fullWorld), and one read of every note through the workload's member. It loads the runtime
 * entry alone, so no schema module and none of the compiler runs. It reads by once alone, so its live source never
 * connects and never asks its decoder's credential, which the installation, migrated with no live source, holds none of.
 */
const consumerProgram = `import { readFileSync } from "node:fs"
import net from "node:net"
import { Effect, Layer, Redacted } from "effect"
import pgDriver from "pg"
import { Db, DbLayer, LiveSource, served } from "@bjornpagen/grizzle/runtime"

const config = JSON.parse(readFileSync(process.argv[2], "utf8"))
const server = served(JSON.parse(readFileSync(config.served, "utf8")), "server")
const connection = {
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
	connectTimeoutMs: config.connectTimeoutMs
}
const layer = Layer.provide(
	DbLayer.make({
		...connection,
		password: Redacted.make(config.password),
		pool: { max: 1, min: 0, idleTimeoutMs: config.idleTimeoutMs },
		login: server
	}),
	LiveSource.layer({
		...connection,
		password: Effect.die(new Error("the consumer reads by once, so its live source asks no decoder")),
		login: server
	})
)
const rows = await Effect.runPromise(
	Effect.gen(function* () {
		const db = yield* Db.open(server.roles.app, {})
		return [...(yield* db.workload.notes.once({ params: {}, facts: {} }))]
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
	"the package as a submodule consumer takes it, on the dev cluster",
	(it) => {
		it.effect(
			"opens a role of a login with the linked package's Db.open and reads exactly every note written so far",
			(ctx) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const consumer = yield* consumerProject
					const generated = yield* installGenerated(
						(name) => {
							const at = declared(name)
							return { schema: at, logins: [fullWorld(at, { notes: notesOf(at) }).server] }
						},
						{ label: "consumer", ambient: ordinarySession }
					)
					const installed = generated.installed
					const App = declared(installed.declared)
					const own = fullWorld(App, { notes: notesOf(App) })
					const file = defined(
						generated.served.get(own.server.name),
						`the served file of login ${own.server.name}`
					)
					const served = path.join(consumer.project, "server.json")
					yield* fs.writeFileString(
						served,
						succeeded(servedText(servedFile(file)), "the login's served file's text")
					)
					const program = path.join(consumer.project, "consumer.mjs")
					yield* fs.writeFileString(program, consumerProgram)
					const config = path.join(consumer.project, "config.json")
					yield* fs.writeFileString(
						config,
						jsonText({
							host: pgPin.host,
							port: pgPin.port,
							ca: installed.cluster.caPem,
							database: installed.database,
							password: Redacted.value(installed.as(own.server).password),
							connectTimeoutMs: testConnectTimeout.value,
							idleTimeoutMs: testIdleTimeout.value,
							served
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
									name: "the notes the cases wrote, each read once by the linked package"
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
									const outcome = yield* withServedDb(
										installed,
										own.server.roles.app,
										{},
										({ serve }) =>
											Effect.flatMap(
												serve({ add: ChangeSet.empty(App).insert(Note, []) }),
												(served) =>
													answered(
														writeOnce(member(served, "add"))({
															params: {},
															facts: { insert: { Note: notes } }
														})
													)
											)
									).pipe(Effect.scoped)
									assert.equal(outcome.kind, "accepted")
									for (const note of notes) {
										written.push(note)
									}
									const read = yield* runChild(
										process.execPath,
										[program, config],
										consumer.project
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
