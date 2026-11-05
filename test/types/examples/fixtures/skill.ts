import net from "node:net"
import { CredentialError, defineConfig } from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pgDriver from "pg"
import { Blog, EtlJob, Web } from "#test/types/examples/fixtures/readme.ts"

/** The CA bundle the block's "./src/db.ts" exports beside the README's program. */
declare const caPem: string

/**
 * packages/grizzle/skills/grizzle/SKILL.md's grizzle.config.ts example, checked: test/types/examples/blocks.test.ts holds each line of
 * the block here, in order. Its "./src/db.ts" is the README's program, with the CA declared above. Typechecked, never
 * executed.
 */
export default defineConfig({
	/** Required: each declared schema, in its own PostgreSQL schema. */
	schemas: [Blog],
	/** Required: every login, and through them every role a Db opens and every workload whose access paths earn indexes. */
	logins: [Web, EtlJob],
	/** Required: the migrations directory, relative to this file. */
	migrations: "migrations",
	/** Required: where grizzle migrate and grizzle drift connect, as the role that owns the schemas. */
	connection: {
		driver: pgDriver,
		transport: {
			kind: "sslRequest",
			host: "db.internal",
			port: 5432,
			open: () => new net.Socket(),
			ca: caPem,
			servername: "db.internal"
		},
		database: "app",
		role: "app_owner",
		password: Config.Redacted("MIGRATION_PASSWORD").pipe(
			Effect.mapError((cause) => new CredentialError({ cause }))
		),
		connectTimeoutMs: 10_000
	}
})
