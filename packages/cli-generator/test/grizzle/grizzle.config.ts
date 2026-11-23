/**
 * The grizzle tier's configuration (twins.ts): the login of world.ts, drafted by `grizzle generate` into the migrations
 * directory EOCG_GRIZZLE_MIGRATIONS names (a twin's scratch directory), and installed by `grizzle migrate` into the
 * database EOCG_GRIZZLE_DATABASE names under the role prefix EOCG_GRIZZLE_ROLE_PREFIX, as the cluster's owner,
 * EOCG_GRIZZLE_ROLE, reached on EOCG_GRIZZLE_PORT with the CA EOCG_GRIZZLE_CA and the password EOCG_GRIZZLE_PASSWORD.
 * `grizzle generate` never calls the connection, so it reads none of the connection's variables.
 */
import net from "node:net"
import { CredentialError, defineConfig } from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pg from "pg"
import { serverName } from "#test/grizzle/connection.ts"
import { Items, Server } from "#test/grizzle/world.ts"

export default defineConfig({
	schemas: [Items],
	logins: [Server],
	migrations: Effect.runSync(Config.String("EOCG_GRIZZLE_MIGRATIONS")),
	rolePrefixBytes: 0,
	connection: () => ({
		driver: pg,
		transport: {
			kind: "sslRequest",
			host: serverName,
			port: Effect.runSync(Config.Port("EOCG_GRIZZLE_PORT")),
			open: () => new net.Socket(),
			ca: Effect.runSync(Config.String("EOCG_GRIZZLE_CA")),
			servername: serverName
		},
		database: Effect.runSync(Config.String("EOCG_GRIZZLE_DATABASE")),
		role: Effect.runSync(Config.String("EOCG_GRIZZLE_ROLE")),
		rolePrefix: Effect.runSync(Config.String("EOCG_GRIZZLE_ROLE_PREFIX")),
		password: Config.Redacted("EOCG_GRIZZLE_PASSWORD").pipe(
			Effect.mapError((cause) => new CredentialError({ cause }))
		)
	})
})
