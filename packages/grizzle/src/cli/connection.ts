import { Effect, Option, Result } from "effect"
import { parseConnection, roleSettings } from "#adapter/connection/config.ts"
import { startupVariableSet } from "#adapter/connection/environment.ts"
import { ConnectionEnvironmentRefused } from "#adapter/errors/failures.ts"
import type { MigrationConnection } from "#adapter/migrate/session.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import {
	type CliError,
	ConnectionRefused,
	ConnectionThrew,
	cliError,
	thrownOf
} from "#cli/errors.ts"
import { prefixPastBound, type RolePrefixBound } from "#compiler/plan/common.ts"

/**
 * Where `grizzle migrate`, `grizzle drift`, `grizzle roles` and `grizzle uninstall` connect: the configuration's
 * connection, and nothing else. The command
 * line reads no environment for it, no URL, no password variable and no CA file; the only variables it reads are the
 * two of the process environment pg would send at an owner's session's startup by itself (ownerEnvironment).
 *
 * The configuration's typed connection, parsed with its role: defineConfig typed it, and a configuration written in
 * JavaScript is checked here all the same (connection/config.ts roleSettings). No refusal quotes a password.
 */
export const resolveConnection = (
	typed: MigrationConnectionConfig
): Result.Result<MigrationConnection, CliError> =>
	Result.mapError(parseConnection(typed, ["connection"], roleSettings), (fault) =>
		cliError(new ConnectionRefused(fault))
	)

/**
 * The process environment the migration identity's sessions would start in, read where pg reads it, never through the
 * ConfigProvider: refused when it sets a startup variable that reaches an owner's session (connection/environment.ts),
 * PGREPLICATION, which pg would send at the startup of each; PGOPTIONS reaches none, since an owner's session sets its
 * own options, generic plans (physical/ddl/roles.ts ownerStartupOptions).
 */
export const ownerEnvironment: Effect.Effect<void, CliError> = Effect.flatMap(
	Effect.sync(() => startupVariableSet()),
	Option.match({
		onNone: () => Effect.void,
		onSome: (startupVariable) =>
			Effect.fail(cliError(new ConnectionEnvironmentRefused({ variable: startupVariable })))
	})
)

/**
 * The connection the configuration's `connection` function returns, called once, then parsed (resolveConnection): a
 * function that throws is refused as ConnectionThrew, which holds what it threw, its cause Redacted, and states its name
 * and message (errors.ts Thrown), so an application's own refusal reaches the person running the command.
 */
export const calledConnection = (
	connect: () => MigrationConnectionConfig
): Result.Result<MigrationConnection, CliError> =>
	Result.flatMap(
		Result.try({
			try: connect,
			catch: (thrown) => cliError(new ConnectionThrew({ thrown: thrownOf(thrown) }))
		}),
		resolveConnection
	)

/**
 * The migration connection `connection`, refused where its role prefix is longer than `bound`, the configuration's
 * rolePrefixBytes (core/identity.ts prefixPastBound): its logins' and roles' PostgreSQL roles were held to PostgreSQL's
 * 63 bytes under a prefix of that length alone (config.ts), so under a longer one a migration could name a role
 * PostgreSQL cuts short.
 */
const withinBound = (
	connection: MigrationConnection,
	bound: RolePrefixBound
): Result.Result<MigrationConnection, CliError> => {
	const bytes = prefixPastBound(connection.roles, bound)
	return bytes === undefined
		? Result.succeed(connection)
		: Result.fail(
				cliError(
					new ConnectionRefused({
						setting: ["connection", "rolePrefix"],
						rule: { kind: "declaredPrefix", bytes, bound }
					})
				)
			)
}

/**
 * Where `grizzle migrate`, `grizzle drift`, `grizzle roles` and `grizzle uninstall` connect: the configuration's
 * connection, called once here, the one place a command calls it, in a process environment that sends no startup
 * variable (ownerEnvironment), under a role prefix within the configuration's rolePrefixBytes (withinBound).
 */
export const migrationConnection = (
	config: ResolvedConfig
): Effect.Effect<MigrationConnection, CliError> =>
	Effect.andThen(
		ownerEnvironment,
		Effect.fromResult(
			Result.flatMap(
				calledConnection(() => config.connection()),
				(connection) => withinBound(connection, config.rolePrefixBytes)
			)
		)
	)
