import { rootCertificates } from "node:tls"
import {
	Config,
	Effect,
	FileSystem,
	Option,
	Path,
	type PlatformError,
	Redacted,
	Result,
	String as Str
} from "effect"
import { parseConnection } from "#adapter/connection/config.ts"
import type { MigrationConnection } from "#adapter/migrate/session.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import { noPassword } from "#adapter/wire/session.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import {
	CaRefused,
	CaUnread,
	type CliError,
	ConnectionRefused,
	ConnectionUnnamed,
	DatabaseUrlRefused,
	EnvironmentUnread,
	cliError
} from "#cli/errors.ts"

/**
 * Where `grizzle migrate` connects.
 *
 * The environment says where grizzle deploys. Only migrate connects, and only migrate reads this:
 *
 * - With no `connection` in grizzle.config.ts, the migration identity connects with `DATABASE_URL`:
 *
 *       postgresql://<role>[:<password>]@<host>[:<port>]/<database>[?sslrootcert=<path>]
 *
 *   `postgres://` is the same. The role, password, host and database are percent-decoded; the port is 5432 by default; a
 *   URL without a password takes PGPASSWORD's, else none. TLS is always verify-full: the server certificate must chain
 *   to the CA and name the host. The CA is the file `sslrootcert=` names (relative to the directory grizzle runs in),
 *   else the file PGSSLROOTCERT names, else the system trust store (also `sslrootcert=system`). `sslmode` may only be
 *   `verify-full`: a weaker mode is refused, since there is never a plaintext or unverified connection.
 *   Any other parameter is refused, so a misspelt one is never ignored.
 * - With `connection`, its typed block: host, port, database, role, a password that is a Redacted or an Effect
 *   evaluated for each attempt (an RDS IAM token, a secret manager's lookup), and tls with ca and an optional
 *   servername. Nothing else is configurable.
 *
 * No refusal here quotes the URL or a password: a URL is named by its parts.
 *
 * The configuration's typed connection, checked: defineConfig typed it, and a configuration written in JavaScript is
 * checked here all the same (connection/config.ts).
 */
export const resolveConnection = (
	typed: MigrationConnectionConfig
): Result.Result<MigrationConnection, CliError> =>
	Result.mapBoth(parseConnection(typed, "connection", "role"), {
		onFailure: (detail) => cliError(ConnectionRefused.make({ detail })),
		onSuccess: (parsed) => ({ ...parsed, role: typed.role })
	})

/**
 * The environment variables `grizzle migrate` and `grizzle drift` read, each none when unset or empty: an empty
 * variable names nothing.
 */
export interface ConnectionEnv {
	readonly DATABASE_URL: Option.Option<string>
	readonly PGPASSWORD: Option.Option<string>
	readonly PGSSLROOTCERT: Option.Option<string>
}

const variable = (name: string): Effect.Effect<Option.Option<string>, CliError> =>
	Config.option(Config.String(name)).pipe(
		Effect.mapBoth({
			onSuccess: Option.filter(Str.isNonEmpty),
			onFailure: (cause) => cliError(EnvironmentUnread.make({ variable: name, cause }))
		})
	)

/**
 * The environment `grizzle migrate` and `grizzle drift` read, through the ConfigProvider.
 *
 * @internal
 */
export const connectionEnv: Effect.Effect<ConnectionEnv, CliError> = Effect.all({
	DATABASE_URL: variable("DATABASE_URL"),
	PGPASSWORD: variable("PGPASSWORD"),
	PGSSLROOTCERT: variable("PGSSLROOTCERT")
})

const urlError = (fault: DatabaseUrlRefused["fault"]): CliError =>
	cliError(DatabaseUrlRefused.make({ fault }))

const decoded = (
	text: string,
	part: "role" | "password" | "host" | "database"
): Result.Result<string, CliError> =>
	Result.try({
		try: () => decodeURIComponent(text),
		catch: () => urlError({ kind: "encoding", part })
	})

/**
 * The CA bundle of a path `source` names, relative to `cwd`; `system` is the system trust store. A path that does not
 * exist, cannot be read or holds nothing is refused with its file.
 */
const caFrom = Effect.fn("caFrom")(function* (
	path: string,
	source: "sslrootcert" | "PGSSLROOTCERT",
	cwd: string
): Effect.fn.Return<string | ReadonlyArray<string>, CliError, FileSystem.FileSystem | Path.Path> {
	if (path === "system") {
		return [...rootCertificates]
	}
	const fs = yield* FileSystem.FileSystem
	const file = (yield* Path.Path).resolve(cwd, path)
	const unread = (cause: PlatformError.PlatformError): CliError =>
		cliError(CaUnread.make({ source, file, cause }))
	if (!(yield* Effect.mapError(fs.exists(file), unread))) {
		return yield* cliError(CaRefused.make({ source, file, fault: "missing" }))
	}
	const text = yield* Effect.mapError(fs.readFileString(file), unread)
	if (Str.trim(text).length === 0) {
		return yield* cliError(CaRefused.make({ source, file, fault: "empty" }))
	}
	return text
})

/** A DATABASE_URL's parts, each percent-decoded, and the CA file its `sslrootcert` names, if any. */
interface UrlParts {
	readonly host: string
	readonly port: number
	readonly database: string
	readonly role: string
	readonly password: string
	readonly sslrootcert: Option.Option<string>
}

/** The parts of a DATABASE_URL, or its refusal. */
const urlParts = (text: string): Result.Result<UrlParts, CliError> => {
	const parsed = Result.try({
		try: () => new URL(text),
		catch: () => urlError({ kind: "notUrl" })
	})
	if (Result.isFailure(parsed)) {
		return Result.fail(parsed.failure)
	}
	const url = parsed.success
	if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
		return Result.fail(urlError({ kind: "protocol", protocol: url.protocol }))
	}
	if (url.hash !== "") {
		return Result.fail(urlError({ kind: "fragment" }))
	}
	const role = decoded(url.username, "role")
	if (Result.isFailure(role)) {
		return Result.fail(role.failure)
	}
	if (role.success.length === 0) {
		return Result.fail(urlError({ kind: "noRole" }))
	}
	const urlPassword = decoded(url.password, "password")
	if (Result.isFailure(urlPassword)) {
		return Result.fail(urlPassword.failure)
	}
	const host = decoded(
		Str.startsWith("[")(url.hostname) && Str.endsWith("]")(url.hostname)
			? Str.slice(1, -1)(url.hostname)
			: url.hostname,
		"host"
	)
	if (Result.isFailure(host)) {
		return Result.fail(host.failure)
	}
	if (host.success.length === 0) {
		return Result.fail(urlError({ kind: "noHost" }))
	}
	const port = url.port === "" ? 5432 : Number(url.port)
	if (port < 1) {
		return Result.fail(urlError({ kind: "port", port }))
	}
	/** One path segment, the database name, in which an encoded slash is a character like any other. */
	const path = Str.slice(1)(url.pathname)
	const database = decoded(path, "database")
	if (Result.isFailure(database)) {
		return Result.fail(database.failure)
	}
	if (database.success.length === 0 || Str.includes("/")(path)) {
		return Result.fail(urlError({ kind: "noDatabase" }))
	}
	let sslrootcert = Option.none<string>()
	for (const [key, value] of url.searchParams) {
		if (key === "sslmode") {
			if (value !== "verify-full") {
				return Result.fail(urlError({ kind: "sslmode", mode: value }))
			}
			continue
		}
		if (key === "sslrootcert") {
			sslrootcert = Option.some(value)
			continue
		}
		return Result.fail(urlError({ kind: "parameter", parameter: key }))
	}
	return Result.succeed({
		host: host.success,
		port,
		database: database.success,
		role: role.success,
		password: urlPassword.success,
		sslrootcert
	})
}

/**
 * The migration identity's connection from DATABASE_URL and the environment: the URL's password, else PGPASSWORD's,
 * else none; the CA its `sslrootcert` names, else PGSSLROOTCERT's, else the system trust store.
 *
 * @internal
 */
export const parseDatabaseUrl = Effect.fn("parseDatabaseUrl")(function* (
	text: string,
	env: ConnectionEnv,
	cwd: string
): Effect.fn.Return<MigrationConnection, CliError, FileSystem.FileSystem | Path.Path> {
	const parts = yield* Effect.fromResult(urlParts(text))
	const ca = Option.isSome(parts.sslrootcert)
		? yield* caFrom(parts.sslrootcert.value, "sslrootcert", cwd)
		: Option.isSome(env.PGSSLROOTCERT)
			? yield* caFrom(env.PGSSLROOTCERT.value, "PGSSLROOTCERT", cwd)
			: [...rootCertificates]
	const secret = parts.password.length > 0 ? Option.some(parts.password) : env.PGPASSWORD
	const connection: MigrationConnection = {
		host: parts.host,
		port: parts.port,
		database: parts.database,
		role: parts.role,
		password: Option.isSome(secret) ? Redacted.make(secret.value) : noPassword,
		tls: { ca: typeof ca === "string" ? ca : [...ca], servername: parts.host }
	}
	return connection
})

/**
 * Where `grizzle migrate` connects: the configuration's connection, else DATABASE_URL.
 *
 * @internal
 */
export const migrationConnection = (
	config: ResolvedConfig,
	env: ConnectionEnv,
	cwd: string
): Effect.Effect<MigrationConnection, CliError, FileSystem.FileSystem | Path.Path> => {
	if (Option.isSome(config.connection)) {
		return Effect.fromResult(resolveConnection(config.connection.value))
	}
	return Option.isSome(env.DATABASE_URL)
		? parseDatabaseUrl(env.DATABASE_URL.value, env, cwd)
		: Effect.fail(cliError(ConnectionUnnamed.make({})))
}
