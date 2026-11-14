import net from "node:net"
import {
	Array as Arr,
	Clock,
	DateTime,
	Effect,
	FileSystem,
	Path,
	type PlatformError,
	Redacted,
	type Result,
	type Scope,
	Stream
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import pgDriver from "pg"
import { defineConfig } from "#adapter/config/define.ts"
import { served } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import type { GrizzleConfig, MigrationConnectionConfig } from "#adapter/types/config.ts"
import type { DbConnection, ServedLogin } from "#adapter/types/layer.ts"
import { type ConfigFile, type ResolvedConfig, resolveConfig } from "#cli/config.ts"
import { type CliError, ConfigMissing, cliError } from "#cli/errors.ts"
import { type CliReport, type ConfigLoader, runCli } from "#cli/run.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { servedPath } from "#compiler/served/forms.ts"
import { ledger, shop } from "#test/pg/cli/fixture.ts"
import { type InitializedClusterShape, readCluster } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { repoRoot } from "#test/support/files.ts"
import { testConnectTimeout } from "#test/support/limits.ts"
import { decodersIn, type SourcedLayer, servedSourcedLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool, type SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import { testVerify } from "#test/support/worlds.ts"

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
 * fixture (fixture.ts) under the test's unique schema names, the migrations directory `migrations`, and where migrate
 * connects. An in-process run (`cli`) builds the same configuration from the same spec, so no run imports a
 * configuration file but the bin. Every command line names the workspace's configuration file (`configName`), as an
 * application's does. `grizzle migrate` connects with the configuration's connection only, over verify-full TLS: as
 * the migration identity `grizzle_dev`, whose password and CA come from the initialised cluster
 * (test/support/cluster.ts), which a CLI child reads for itself (config.child.ts), or as a role a test created, whose
 * password its spec names.
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
 * ordersOf alone, or none), or the ledger, with its alternatives, derived relation and full workload.
 */
export type SchemaSpec =
	| {
			readonly name: string
			readonly fixture: "shop"
			readonly version: 1 | 2
			readonly workload: "full" | "withoutByName" | "none"
	  }
	| { readonly name: string; readonly fixture: "ledger" }

/**
 * Who migrate connects as: the migration identity, with its password (`owner`), a wrong one, or an Effect yielding its
 * password; or a role a test created, with the password the test was given for it.
 */
export type ConnectionAs =
	| { readonly kind: "migration identity"; readonly password: "owner" | "wrong" | "effect" }
	| { readonly kind: "role"; readonly role: string; readonly password: string }

/**
 * Where migrate connects: `database` at `port` on the cluster's host (a closed port shows a command never connects),
 * verify-full against the cluster's CA, as `as`.
 */
export type ConnectionSpec = {
	readonly database: string
	readonly port: number
	readonly as: ConnectionAs
}

/** A configuration: its schemas, and where migrate connects. */
export type ConfigSpec = {
	readonly schemas: ReadonlyArray<SchemaSpec>
	readonly connection: ConnectionSpec
}

/** The migration identity on `database`, with its password. */
export const ownerOn = (database: string): ConnectionSpec => ({
	database,
	port: pgPin.port,
	as: { kind: "migration identity", password: "owner" }
})

/**
 * The connection of a configuration no command of the test connects with: generate, check and names never read it,
 * and a migrate on it finds no such database.
 */
export const unconnected: ConnectionSpec = ownerOn("unconnected")

/** The file every workspace's configuration lies in, as its command lines name it, relative to the workspace. */
export const configName = "grizzle.config.ts"

/** The password of the offline connection, which a refusal must never quote. */
export const offlinePassword = "offline-password"

/**
 * A connection to no cluster, which no command or layer of a test opens: generate, check and names never read a
 * configuration's connection, and a DbLayer builds without connecting. Its CA signs nothing.
 *
 * @internal
 */
export const offlineConnection: DbConnection = {
	driver: pgDriver,
	transport: {
		kind: "sslRequest",
		host: pgPin.host,
		port: pgPin.port,
		open: () => new net.Socket(),
		ca: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n",
		servername: pgPin.host
	},
	database: "offline",
	password: Redacted.make(offlinePassword),
	connectTimeoutMs: testConnectTimeout.value
}

/** The migration identity's connection to no cluster, for a configuration no test migrates with. */
export const offlineOwner: MigrationConnectionConfig = { ...offlineConnection, role: pgPin.devRole }

/**
 * A connection's role and password as its spec names them: the migration identity's password, the wrong one, or an
 * Effect yielding the identity's, its one source, so a connection whose password is the Effect connects only once the
 * Effect ran; or a test's role, with its password.
 */
const credentialsOf = (
	cluster: InitializedClusterShape,
	as: ConnectionAs
): Pick<MigrationConnectionConfig, "role" | "password"> => {
	if (as.kind === "role") {
		return { role: as.role, password: Redacted.make(as.password) }
	}
	switch (as.password) {
		case "wrong":
			return { role: pgPin.devRole, password: Redacted.make(wrongPassword) }
		case "effect":
			return { role: pgPin.devRole, password: Effect.sync(() => cluster.devPassword) }
		case "owner":
			return { role: pgPin.devRole, password: cluster.devPassword }
	}
}

/**
 * The connection a spec describes: the cluster's (test/support/pg.ts clusterConnection) on its port, verifying its
 * CA, as the spec's role with its password.
 *
 * @internal
 */
export const connectionOf = (
	cluster: InitializedClusterShape,
	spec: ConnectionSpec
): MigrationConnectionConfig => {
	const { role, password } = credentialsOf(cluster, spec.as)
	const base = clusterConnection(cluster, spec.database, password)
	return { ...base, transport: { ...base.transport, port: spec.port }, role }
}

/**
 * The configuration a spec describes, built from the fixtures (fixture.ts), as defineConfig takes it: its schemas and
 * their logins, which own their workloads, the migrations directory `migrations`, and its connection.
 *
 * @internal
 */
export const configOf = (cluster: InitializedClusterShape, spec: ConfigSpec): GrizzleConfig => {
	const built = Arr.map(spec.schemas, (s) =>
		s.fixture === "ledger" ? ledger(s.name) : shop(s.name, s.version, s.workload)
	)
	const [first, ...rest] = Arr.map(built, (b) => b.schema)
	if (first === undefined) {
		throw new Error("configOf: a configuration names at least one schema")
	}
	return {
		schemas: [first, ...rest],
		logins: Arr.map(built, (b) => b.server),
		migrations: "migrations",
		connection: () => connectionOf(cluster, spec.connection)
	}
}

/** The file a workspace's spec lies in, which its grizzle.config.ts builds its configuration from. */
const specFileName = "grizzle.spec.json"

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
		const spec = trustedJson<ConfigSpec>(text)
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
		yield* fs.writeFileString(`${dir}/${configName}`, text)
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

/**
 * A command line's run in process: its exit status and its output as the bin writes it, and its report itself, whose
 * refused arm carries the refusal.
 */
export interface CliRun {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
	readonly report: CliReport
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
 * The configuration file at `file`, as the bin imports it: the configuration of the spec writeConfig wrote beside it,
 * or refused as missing when no configuration file is there.
 */
const workspaceConfig: ConfigLoader = (file) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (!(yield* Effect.orDie(fs.exists(file)))) {
			return yield* cliError(new ConfigMissing({ file }))
		}
		const config = yield* Effect.orDie(specConfig(path.dirname(file)))
		const value = defineConfig(config)
		const loaded: ConfigFile = { file, value }
		return loaded
	})

/**
 * Runs a command line in process in `dir` at `now`, its configuration file imported by `load`; its report's lines
 * read back as the text the bin writes.
 */
const runIn = (
	dir: string,
	load: ConfigLoader,
	argv: ReadonlyArray<string>,
	now: DateTime.Utc
): Effect.Effect<CliRun, never, FileSystem.FileSystem | Path.Path> =>
	runCli(argv, dir, load).pipe(
		Effect.provideService(Clock.Clock, fixedClock(now)),
		Effect.map((report) => ({
			code: report.code,
			stdout: text(report.stdout),
			stderr: text(report.stderr),
			report
		}))
	)

/**
 * Runs a command line in process in `dir` at `now`, over the configuration of the spec writeConfig wrote beside the
 * configuration file it names; its report's lines read back as the text the bin writes.
 *
 * @internal
 */
export const cli = (
	dir: string,
	argv: ReadonlyArray<string>,
	now: DateTime.Utc
): Effect.Effect<CliRun, never, FileSystem.FileSystem | Path.Path> =>
	runIn(dir, workspaceConfig, argv, now)

/**
 * Runs a command line in process in `dir` at `now` over `value`, the default export of whatever configuration file it
 * names, as the bin imports it.
 *
 * @internal
 */
export const cliOver = (
	dir: string,
	value: unknown,
	argv: ReadonlyArray<string>,
	now: DateTime.Utc
): Effect.Effect<CliRun, never, FileSystem.FileSystem | Path.Path> =>
	runIn(dir, (file) => Effect.succeed({ file, value }), argv, now)

/**
 * The drift check's mismatches a refused `grizzle migrate` or `grizzle drift` reports, each as its kind and fact: none
 * for a report the drift check did not refuse. A refusal at stage drift is exactly one with a mismatch.
 */
export const driftMismatches = (ran: CliRun): ReadonlyArray<string> => {
	const report = ran.report
	if (report.outcome !== "refused" || report.refusal._tag !== "CommandRefused") {
		return []
	}
	const reason = report.refusal.error.reason
	return reason._tag === "Drifted" ? Arr.map(reason.mismatches, (m) => `${m.kind} ${m.fact}`) : []
}

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
				[`${repo}packages/grizzle/src/cli/main.ts`, ...argv],
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

/** A login served from the file generate wrote, as an application serves it: its served login, typed by L, and its layer. */
export interface ServedFromFile<L> {
	readonly login: ServedLogin<L>
	readonly layer: SourcedLayer<L>
}

/**
 * The served file `grizzle generate` wrote for `login` in the schema directory `directory`, served under L's type as an
 * application's import of it is.
 */
export const servedAt = <L extends AnyLogin>(
	directory: string,
	login: L
): Effect.Effect<ServedLogin<L>, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(`${directory}/${servedPath(login.name)}`)
		return served<L>(trustedJson<unknown>(text), login.name)
	})

/**
 * The served file `grizzle generate` wrote for `login` in the workspace `dir`, under the PostgreSQL schema `schema`'s
 * directory (servedAt), and the DbLayer of it on the substrate's database as the login's own PostgreSQL role, with its
 * password, the test pool and testVerify: what a deployment of the workspace runs.
 */
export const servedFromFile = <L extends AnyLogin>(
	dir: string,
	schema: string,
	login: L
): Effect.Effect<
	ServedFromFile<L>,
	PlatformError.PlatformError | SqlError,
	FileSystem.FileSystem | Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const file = yield* servedAt(`${dir}/migrations/${schema}`, login)
		const credentials = yield* substrate.login(roleNameOf(file, {}))
		const scope = yield* Effect.scope
		const decoderOf = yield* decodersIn(substrate, scope)
		return {
			login: file,
			layer: servedSourcedLayer(decoderOf, {
				...clusterConnection(substrate.cluster, substrate.database, credentials.password),
				pool: clusterPool,
				login: file,
				verify: testVerify
			})
		}
	})
