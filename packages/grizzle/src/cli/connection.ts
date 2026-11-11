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
 * PGOPTIONS or PGREPLICATION, which pg would send at the startup of each, since an owner's session sets no options of
 * its own and starts under its role's and its database's defaults.
 */
export const ownerEnvironment: Effect.Effect<void, CliError> = Effect.flatMap(
	Effect.sync(() => startupVariableSet("owner")),
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
 * Where `grizzle migrate`, `grizzle drift`, `grizzle roles` and `grizzle uninstall` connect: the configuration's
 * connection, called once here, the one place
 * a command calls it, in a process environment that sends no startup variable (ownerEnvironment).
 */
export const migrationConnection = (
	config: ResolvedConfig
): Effect.Effect<MigrationConnection, CliError> =>
	Effect.andThen(ownerEnvironment, Effect.fromResult(calledConnection(() => config.connection())))
