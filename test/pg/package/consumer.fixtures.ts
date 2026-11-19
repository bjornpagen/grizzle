/** What the properties of consumer.test.ts read: its spaces, models and helpers. */

import { array, type Gen, int } from "@bjornpagen/testing/gen"
import type { PgMember } from "@bjornpagen/testing/pg"
import { Array as Arr, Predicate, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { testConnectTimeout } from "#test/support/limits.ts"
import type { SubmoduleConsumer } from "#test/unit/dev/consumer.ts"

export const Note = relation("Note", { id: uuid, n: pg.integer }, ["id"])

export const declared = (name: string) => schema(name, [Note], [])

/** Every note, the one read the consumer's workload serves. */
export const notesOf = (base: ReturnType<typeof declared>) =>
	query(base).rule((r) => {
		const { id, n } = v(Note, "note")
		return r.match(Note, { id, n }).find({ id, n })
	})

/**
 * The connections the consumer opens on the cluster at once, which its run draws from the file's budget: its pool's
 * one session (`pool: { max: 1 }` below), and the CancelRequest's connection an interrupted statement of it opens.
 */
export const consumerConnections = ["the pool's session", "a cancel request"].length

/**
 * The consumer, as an application writes it against the package: the login's served file, served under the
 * login's name, its layer given its installation's live source (LiveSource.layer), the full role's Db of it
 * (test/support/worlds.ts fullWorld), and one read of every note through the workload's member. It loads the runtime
 * entry alone, so no schema module and none of the compiler runs. It reads by once alone, so its live source never
 * connects and never asks its decoder's credential, which the installation, migrated with no live source, holds none of.
 */
export const consumerProgram = `import { readFileSync } from "node:fs"
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
export interface NoteRow {
	readonly id: string
	readonly n: number
}

/** One to three notes' numbers. */
export const numbersGen: Gen<ReadonlyArray<number>> = array(int(-1000, 1000), { min: 1, max: 3 })

/** The uuid of the `i`th note written. */
export const noteId = (i: number): Uuid =>
	`00000000-0000-4000-8000-${Str.padStart(12, "0")(String(i))}`

export type ConsumerFeature = "one note" | "several notes" | "a read after an earlier write"

/** A program the project runs: it imports the pin through its link to grizzle-pg and prints it as JSON. */
export const pinProgram = `import { pin } from "@bjornpagen/grizzle-pg/pin"
process.stdout.write(JSON.stringify(pin))
`

/**
 * A program bash runs with the checkout and pin.env's names as its arguments: it sources scripts/pg/pin.env as the
 * build's scripts do, and prints each name's value as the shell holds it, one `<name>=<value>` line each.
 */
export const shellPin = `source "$1/scripts/pg/pin.env" || exit 1
shift
for name in "$@"; do
	printf '%s=%s\n' "$name" "\${!name}"
done
`

/** A value of the pin as the shell spells it: text as it is, a port in decimal, the patches joined by spaces. */
export const shellSpelling = (value: string | number | ReadonlyArray<string>): string =>
	Predicate.isString(value) ? value : Predicate.isNumber(value) ? `${value}` : Arr.join(value, " ")

/** The grizzle command line's entry point, through the consumer's link to grizzle. */
export const grizzleCli = (consumer: SubmoduleConsumer): string =>
	`${consumer.modules}/node_modules/@bjornpagen/grizzle/src/cli/bin.ts`

/**
 * The consumer's configuration: one relation, migrated into the owner's own database of the case's cluster, through
 * its TLS and the owner's password, which the configuration wraps in the project's Redacted, so grizzle reads it
 * only when its effect is the project's.
 */
export const consumerConfig = (member: PgMember): string => `import { readFileSync } from "node:fs"
import net from "node:net"
import { Effect, Redacted } from "effect"
import pgDriver from "pg"
import { defineConfig, pg, relation, schema, uuid } from "@bjornpagen/grizzle"

const Note = relation("Note", { id: uuid, n: pg.integer }, ["id"])
const Consumer = schema("Consumer", [Note], [])

export default defineConfig({
	schemas: [Consumer],
	logins: [],
	migrations: "migrations",
	connection: () => ({
		driver: pgDriver,
		transport: {
			kind: "sslRequest",
			host: "localhost",
			port: ${member.port},
			open: () => new net.Socket(),
			ca: readFileSync(${jsonText(member.caFile)}, "utf8"),
			servername: "localhost"
		},
		database: ${jsonText(member.owner)},
		role: ${jsonText(member.owner)},
		password: Effect.succeed(Redacted.make(readFileSync(${jsonText(member.passwordFile)}, "utf8").trim())),
		connectTimeoutMs: ${testConnectTimeout}
	})
})
`
