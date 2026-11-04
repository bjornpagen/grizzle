import {
	Array as Arr,
	Clock,
	ConfigProvider,
	DateTime,
	Effect,
	FileSystem,
	type Path,
	type PlatformError,
	Redacted,
	type Result,
	Schema,
	type Scope,
	Stream
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { defineConfig } from "#adapter/config/define.ts"
import type { GrizzleConfig, MigrationConnectionConfig } from "#adapter/types/config.ts"
import { type ConfigFile, type ResolvedConfig, resolveConfig } from "#cli/config.ts"
import { type CliError, ConfigMissing, cliError, configFileName } from "#cli/errors.ts"
import { runCli } from "#cli/run.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { ledger, shop } from "#test/pg/cli/fixture.ts"
import { type InitializedClusterShape, readCluster } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { repoRoot } from "#test/support/files.ts"
import { decodeJson } from "#test/support/json.ts"
import { sourceCondition } from "#test/support/process.ts"
import { scopedTempDir } from "#test/support/temp.ts"

const repo = repoRoot
/** The module a CLI child process's grizzle.config.ts builds its configuration through (config.child.ts). */
const configChild = `${repo}test/pg/cli/config.child.ts`

/**
 * Driving the `grizzle` command line from the CLI tests.
 *
 * A test owns a workspace: a scratch directory inside the repository, so its grizzle.config.ts resolves `effect` and
 * the repository's modules as an application's would, removed when the test's block ends. The configuration is the
 * lean one, `export default defineConfig(...)`, with defineConfig imported from the package root by its name,
 * `@bjornpagen/grizzle`, as an application imports it: the workspace lies inside the repository, so Node resolves the
 * name to the package itself, and the configuration and the command line share one module instance. What it hands
 * defineConfig is built by typed code, `configOf` here, from the spec written beside it: the shop or ledger
 * fixture (fixture.ts) under the test's unique schema names. An in-process run (`cli`) builds the same configuration
 * from the same spec, so no run imports a configuration file but the bin. `grizzle migrate` connects with DATABASE_URL
 * (`databaseUrl`, the migration identity `grizzle_dev`, over verify-full TLS), handed to the command in
 * its environment, or with a typed `connection` in the configuration when a test asks for one; the password and the CA
 * come from the initialised cluster (test/support/cluster.ts), which a CLI child reads for itself (config.child.ts), so
 * no credential is written to disk.
 * `cli` runs a command line in process with a fixed clock; `bin` runs the real bin, `node packages/grizzle/src/cli/main.ts`, as a child
 * process the test owns.
 *
 * The password of the configuration's "wrong" connection, which no role has.
 */
export const wrongPassword = "not-the-password"

/**
 * A scratch workspace inside the repository, where the CLI resolves the package, removed when the scope closes; an
 * interrupted run's leftover is ignored by git and the formatter (.gitignore, .oxfmtrc.json).
 *
 * @internal
 */
export const workspace = (
	label: string
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
	scopedTempDir(`${repo}test/pg/cli`, `.ws-${label}-`)

/**
 * One schema of a configuration (fixture.ts): the shop at a version, its login owning a workload (both programs,
 * ordersOf alone, or none), or the ledger, with its residual law, derived relation and full workload.
 */
const SchemaSpecSchema = Schema.Union([
	Schema.Struct({
		name: Schema.String,
		fixture: Schema.Literal("shop"),
		version: Schema.Literals([1, 2]),
		workload: Schema.Literals(["full", "withoutByName", "none"])
	}),
	Schema.Struct({ name: Schema.String, fixture: Schema.Literal("ledger") })
])
export type SchemaSpec = typeof SchemaSpecSchema.Type

/**
 * A configuration: its schemas, and where migrate connects: DATABASE_URL, or a typed connection in the configuration to
 * `database` at `port` (a closed port shows a command never connects), with a Redacted password (`owner`), a wrong one,
 * or an Effect yielding it.
 */
const ConfigSpecSchema = Schema.Struct({
	schemas: Schema.Array(SchemaSpecSchema),
	connection: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("databaseUrl") }),
		Schema.Struct({
			kind: Schema.Literal("typed"),
			database: Schema.String,
			password: Schema.Literals(["owner", "wrong", "effect"]),
			port: Schema.Int
		})
	])
})
export type ConfigSpec = typeof ConfigSpecSchema.Type

/** Migrate reads DATABASE_URL. */
export const viaDatabaseUrl: ConfigSpec["connection"] = { kind: "databaseUrl" }

/** The parts of a DATABASE_URL besides its database. */
export interface UrlParts {
	readonly role: string
	readonly password: string
	readonly port: number
	readonly query: string
}

/** The migration identity on the cluster's port, verify-full against the cluster's CA. */
export const migrationIdentity = (cluster: InitializedClusterShape): UrlParts => ({
	role: pgPin.devRole,
	password: Redacted.value(cluster.devPassword),
	port: pgPin.port,
	query: `sslrootcert=${encodeURIComponent(cluster.caFile)}`
})

/** The DATABASE_URL of `parts` on `database`. */
export const databaseUrl = (database: string, parts: UrlParts): string =>
	`postgresql://${encodeURIComponent(parts.role)}:${encodeURIComponent(parts.password)}@${pgPin.host}:${parts.port}/${encodeURIComponent(database)}?${parts.query}`

/** The environment of a migrate against `database`. */
export const urlEnv = (
	cluster: InitializedClusterShape,
	database: string
): Readonly<Record<string, string>> => ({
	DATABASE_URL: databaseUrl(database, migrationIdentity(cluster))
})

/**
 * A connection's password as its spec names it: the migration identity's, the wrong one, or an Effect yielding the
 * identity's, its one source: a typed connection whose password is the Effect connects only once the Effect ran.
 */
const passwordOf = (
	cluster: InitializedClusterShape,
	password: "owner" | "wrong" | "effect"
): MigrationConnectionConfig["password"] => {
	switch (password) {
		case "wrong":
			return Redacted.make(wrongPassword)
		case "effect":
			return Effect.sync(() => cluster.devPassword)
		case "owner":
			return cluster.devPassword
	}
}

/**
 * The configuration a spec describes, built from the fixtures (fixture.ts), as defineConfig takes it; a typed
 * connection verifies the cluster's CA.
 *
 * @internal
 */
export const configOf = (cluster: InitializedClusterShape, spec: ConfigSpec): GrizzleConfig => {
	const c = spec.connection
	if (c.kind === "databaseUrl") {
		return configWith(spec, {})
	}
	return configWith(spec, {
		connection: {
			host: pgPin.host,
			port: c.port,
			database: c.database,
			role: pgPin.devRole,
			password: passwordOf(cluster, c.password),
			tls: { ca: cluster.caPem }
		}
	})
}

/** The configuration of `spec`'s schemas and their logins, which own their workloads, with its connection part. */
const configWith = (
	spec: ConfigSpec,
	connection: Pick<GrizzleConfig, "connection">
): GrizzleConfig => {
	const built = Arr.map(spec.schemas, (s) =>
		s.fixture === "ledger" ? ledger(s.name) : shop(s.name, s.version, s.workload)
	)
	const [first, ...rest] = Arr.map(built, (b) => b.schema)
	if (first === undefined) {
		throw new Error("configOf: a configuration names at least one schema")
	}
	return { schemas: [first, ...rest], logins: Arr.map(built, (b) => b.server), ...connection }
}

/** The file a workspace's spec lies in, which its grizzle.config.ts builds its configuration from. */
const specFileName = "grizzle.spec.json"

const decodeSpec = decodeJson(ConfigSpecSchema)

/**
 * The configuration of the spec in `dir`, as its grizzle.config.ts and an in-process run build it: its password and
 * CA are the initialised cluster's, read once for it.
 *
 * @internal
 */
export const specConfig = (
	dir: string
): Effect.Effect<
	GrizzleConfig,
	PlatformError.PlatformError | Effect.Error<typeof readCluster>,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(`${dir}/${specFileName}`)
		const spec = decodeSpec(text)
		const cluster = yield* readCluster
		return configOf(cluster, spec)
	})

/**
 * The grizzle.config.ts every spec's workspace holds: config.child.ts's configModule builds the configuration from the
 * spec beside it.
 */
const configText = `import { defineConfig } from "@bjornpagen/grizzle"\nimport { configModule } from ${jsonText(configChild)}\n\nexport default defineConfig(await configModule(import.meta.dirname))\n`

/**
 * A grizzle.config.ts of `text` itself in `dir`: a malformed configuration, or one written by hand, which the bin
 * imports.
 *
 * @internal
 */
export const writeConfigText = (
	dir: string,
	text: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(`${dir}/${configFileName}`, text)
	})

/**
 * The configuration of `spec` in `dir`: the spec, and the grizzle.config.ts that builds it.
 *
 * @internal
 */
export const writeConfig = (
	dir: string,
	spec: ConfigSpec
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(`${dir}/${specFileName}`, jsonText(spec))
		yield* writeConfigText(dir, configText)
	})

export interface CliRun {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * A fixed, increasing clock its test file owns: each reading one second after the last, from 2026-10-12 12:00:00 UTC,
 * so the folders a file's commands draft sort in drafting order.
 */
export const cliClock = (): (() => DateTime.Utc) => {
	let seconds = 0
	return () =>
		DateTime.makeUnsafe({
			year: 2026,
			month: 10,
			day: 12,
			hour: 12,
			minute: 0,
			second: seconds++,
			millisecond: 0
		})
}

/**
 * A Clock whose current time is `now` and whose sleep is the default clock's: a command reads its folder timestamp
 * from it, and a migrate's connect deadlines still elapse on the live clock.
 */
const fixedClock = (now: DateTime.Utc): Clock.Clock => {
	const live = Clock.Clock.defaultValue()
	const millis = DateTime.toEpochMillis(now)
	const nanos = BigInt(millis) * 1_000_000n
	return {
		currentTimeMillisUnsafe: () => millis,
		currentTimeMillis: Effect.succeed(millis),
		currentTimeNanosUnsafe: () => nanos,
		currentTimeNanos: Effect.succeed(nanos),
		monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
		monotonicTimeNanos: live.monotonicTimeNanos,
		sleep: (duration) => live.sleep(duration)
	}
}

/**
 * A configuration value checked as the default export of `file`, its directories resolved by Path.
 *
 * @internal
 */
export const resolvedConfig = (
	value: unknown,
	file: string
): Effect.Effect<Result.Result<ResolvedConfig, CliError>, never, Path.Path> =>
	Effect.result(resolveConfig(value, file))

const text = (lines: ReadonlyArray<string>): string =>
	lines.length === 0 ? "" : `${Arr.join(lines, "\n")}\n`

/**
 * The configuration of the spec writeConfig wrote in `dir`, as the bin imports it: none without a spec.
 */
const workspaceConfig = (
	dir: string
): Effect.Effect<ConfigFile, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (!(yield* Effect.orDie(fs.exists(`${dir}/${specFileName}`)))) {
			return yield* cliError(ConfigMissing.make({ directory: dir }))
		}
		const config = yield* Effect.orDie(specConfig(dir))
		const value = defineConfig(config)
		const loaded: ConfigFile = { file: `${dir}/${configFileName}`, value }
		return loaded
	})

/**
 * Runs a command line in process in `dir` at `now`, with the environment `env` as its ConfigProvider, over the
 * configuration `configFile`; its report's lines read back as the text the bin writes.
 */
const runIn = (
	dir: string,
	configFile: Effect.Effect<ConfigFile, CliError, FileSystem.FileSystem | Path.Path>,
	argv: ReadonlyArray<string>,
	now: DateTime.Utc,
	env: Readonly<Record<string, string>>
): Effect.Effect<CliRun, never, FileSystem.FileSystem | Path.Path> =>
	runCli(argv, dir, configFile).pipe(
		Effect.provideService(Clock.Clock, fixedClock(now)),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
		Effect.map((report) => ({
			code: report.code,
			stdout: text(report.stdout),
			stderr: text(report.stderr)
		}))
	)

/**
 * Runs a command line in process in `dir` at `now`, with the environment `env` as its ConfigProvider, over the
 * configuration of the spec writeConfig wrote there; its report's lines read back as the text the bin writes.
 *
 * @internal
 */
export const cli = (
	dir: string,
	argv: ReadonlyArray<string>,
	now: DateTime.Utc,
	env: Readonly<Record<string, string>>
): Effect.Effect<CliRun, never, FileSystem.FileSystem | Path.Path> =>
	runIn(dir, workspaceConfig(dir), argv, now, env)

/**
 * Runs a command line in process in `dir` at `now` over `value`, a grizzle.config.ts's default export as the bin
 * imports it.
 *
 * @internal
 */
export const cliOver = (
	dir: string,
	value: unknown,
	argv: ReadonlyArray<string>,
	now: DateTime.Utc
): Effect.Effect<CliRun, never, FileSystem.FileSystem | Path.Path> =>
	runIn(dir, Effect.succeed({ file: `${dir}/${configFileName}`, value }), argv, now, {})

/** What the bin did: its exit code and its output. */
export interface BinRun {
	readonly status: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * Runs the real bin in `dir` as a child process of the effect, killed when it is interrupted, its environment this
 * process's extended by `env`.
 *
 * @internal
 */
export const bin = (
	dir: string,
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
): Effect.Effect<BinRun, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(
				process.execPath,
				[sourceCondition, `${repo}packages/grizzle/src/cli/main.ts`, ...argv],
				{ cwd: dir, env: { ...env }, extendEnv: true, stdin: "ignore" }
			)
			const [stdout, stderr, status] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: "unbounded" }
			)
			const ran: BinRun = { status, stdout, stderr }
			return ran
		})
	)
