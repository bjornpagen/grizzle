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
	/**
	 * Each twin installs under its clone's database name as its role prefix (twins.ts twinOf): the repository's prefix,
	 * `c_`, its owner's 16 hex digits, `_` and the owner's serial for it (vendor/toolchain names.ts cloneName), a serial
	 * being a safe integer of at most 16 digits.
	 *
	 * @formatConstant `gz_` (3, test/support/runner.ts) + `c_` (2) + 16 + `_` (1) + 16 = 38 bytes
	 */
	rolePrefixBytes: 38,
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
