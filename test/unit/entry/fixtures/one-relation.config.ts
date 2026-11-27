/**
 * A grizzle.config.ts over one relation, as README's "Migrations" writes one: its schema, a login whose workload reads
 * the relation, and where migrate connects, whose password Effect fails with CredentialError.
 */
import net from "node:net"
import {
	CredentialError,
	defineConfig,
	login,
	relation,
	role,
	schema,
	str,
	wholeEntriesOf
} from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pgDriver from "pg"

const Slug = str.regex("^[a-z0-9-]{1,96}$")
const Note = relation("Note", { slug: Slug, title: str.regex("^.{1,200}$", "su") }, ["slug"])
const Notes = schema("Notes", [Note], [])
const reader = role(Notes, "reader", wholeEntriesOf(Notes))
const Web = login(Notes, "web", [reader], { workload: [] })

export default defineConfig({
	contracts: [],
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
			Effect.mapError((cause) => new CredentialError({ cause }))
		)
	})
})
