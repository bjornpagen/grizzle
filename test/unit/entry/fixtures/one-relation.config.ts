/**
 * A grizzle.config.ts over one relation, as README's "Migrations" writes one: its schema, a login whose workload reads
 * the relation, and where migrate connects, whose password Effect fails with CredentialError.
 */
import net from "node:net"
import * as g from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pgDriver from "pg"

const Slug = g.str.regex("^[a-z0-9-]{1,96}$")
const Note = g.relation("Note", { slug: Slug, title: g.str.regex("^.{1,200}$", "su") }, ["slug"])
const Notes = g.schema("Notes", [Note], [])
const reader = g.role(Notes, "reader", g.wholeEntriesOf(Notes))
const Web = g.login(Notes, "web", [reader], { workload: [] })

export default g.defineConfig({
	schemas: [Notes],
	logins: [Web],
	migrations: "migrations",
	rolePrefixBytes: 0,
	connection: () => ({
		driver: pgDriver,
		transport: {
			kind: "sslRequest",
			host: "db.internal",
			port: 5432,
			open: () => new net.Socket(),
			ca: "",
			servername: "db.internal"
		},
		database: "app",
		role: "app_owner",
		password: Config.Redacted("MIGRATION_PASSWORD").pipe(
			Effect.mapError((cause) => new g.CredentialError({ cause }))
		)
	})
})
