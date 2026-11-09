import { arch, availableParallelism, cpus, platform, release, totalmem } from "node:os"
import {
	Array as Arr,
	Config,
	ConfigProvider,
	Console,
	Data,
	DateTime,
	Effect,
	FileSystem,
	Inspectable,
	Option,
	Record as Rec,
	type Scope,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonDocument, trusted, trustedJson } from "#compiler/core/trusted.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

import { regex } from "arkregex"
/**
 * The identity every bench/cold record carries: the full benchmark identity (git sha, PostgreSQL pin, phases). A
 * benchmark record identifies its source, extension and build versions, schema and index state, data distribution,
 * parameters, result semantics, cache state, samples and measurement scope; every transaction is SERIALIZABLE,
 * so no record states an isolation.
 *
 * The record-wide part lives here: the source (git sha and whether the tree was dirty), the PostgreSQL pin from
 * scripts/pg/pin.env and the server the run reached, the runtime and machine, the pinned packages, the phases the
 * record measures and its scope. The per-case part (schema and index state, data distribution, parameters, result
 * semantics, cache state, samples) sits on each case of the record, because it differs between cases. The machine is a
 * virtual machine, and its timings are noisy (Tests and gates): the identity says so, so no reader takes a record for a
 * performance claim.
 */
export const repoRoot: string = Str.slice(
	0,
	-1
)(decodeURIComponent(new URL("../../", import.meta.url).pathname))

/** Why a part of the identity could not be read: a file, git, or the machine did not answer. */
export class IdentityUnreadable extends Data.TaggedError("IdentityUnreadable")<{
	readonly detail: string
}> {}

const unreadable =
	(detail: string) =>
	(cause: unknown): IdentityUnreadable =>
		new IdentityUnreadable({ detail: `${detail}: ${Inspectable.toStringUnknown(cause)}` })

/** The record format; a reader refuses a record of another format. */
const benchFormat = "grizzle-bench/1"

export interface SourceIdentity {
	readonly gitSha: string
	/** Whether the working tree differed from that commit when the run started. */
	readonly gitDirty: boolean
}

interface PgPin {
	readonly tag: string
	readonly commit: string
	readonly version: string
	readonly pgvector: string
}

export interface ServerIdentity {
	/** SELECT version(): the build the run reached, compiler and platform included. */
	readonly version: string
	readonly serverVersion: string
	readonly serverVersionNum: number
	/**
	 * Whether a JIT provider loads when a session turns jit on: pg_jit_available() reports false whenever jit is off, so
	 * it is read with jit on in a transaction that is rolled back.
	 */
	readonly jitAvailable: boolean
	/** Settings as a session of the migration identity sees them, the server defaults the measurements ran under. */
	readonly settings: Readonly<Record<string, string>>
	/** The extensions of the benchmark's database and their versions. */
	readonly extensions: Readonly<Record<string, string>>
}

interface RuntimeIdentity {
	readonly node: string
	readonly v8: string
	readonly execArgv: ReadonlyArray<string>
	readonly platform: string
	readonly release: string
	readonly arch: string
	readonly cpu: string
	readonly cores: number
	readonly memoryBytes: number
	readonly note: string
}

export interface BenchIdentity {
	readonly format: typeof benchFormat
	readonly benchmark: string
	readonly recordedAt: string
	readonly source: SourceIdentity
	readonly pgPin: PgPin
	readonly server: ServerIdentity
	readonly runtime: RuntimeIdentity
	readonly packages: Readonly<Record<string, string>>
	/** The phases the record measures, by the names its cases use. */
	readonly phases: ReadonlyArray<string>
	/** What the record measures, and what it leaves out. */
	readonly scope: string
	/** The options the run was started with. */
	readonly options: Readonly<Record<string, unknown>>
}

const pinValue = (key: string): Config.Config<string> => Config.NonEmptyString(key)

const pinConfig = Config.all({
	tag: pinValue("PG_PIN_TAG"),
	commit: pinValue("PG_PIN_COMMIT"),
	version: pinValue("PG_PIN_VERSION"),
	pgvector: pinValue("PGVECTOR_PIN_VERSION")
})

/**
 * scripts/pg/pin.env, the one file every script, test and benchmark reads the pin from; every key it needs is set.
 *
 * @internal
 */
export const readPin: Effect.Effect<PgPin, IdentityUnreadable, FileSystem.FileSystem> = Effect.gen(
	function* () {
		const provider = yield* ConfigProvider.fromDotEnv({ path: `${repoRoot}/scripts/pg/pin.env` })
		return yield* pinConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
	}
).pipe(Effect.mapError(unreadable("scripts/pg/pin.env does not define the pin")))

const git = Effect.fn("git")(function* (
	args: ReadonlyArray<string>
): Effect.fn.Return<
	string,
	IdentityUnreadable,
	ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
	const failed = unreadable(`git ${Arr.join(args, " ")} failed`)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [out, status] = yield* Effect.mapError(
		Effect.flatMap(
			spawner.spawn(ChildProcess.make("git", args, { cwd: repoRoot, stderr: "inherit" })),
			(child) =>
				Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode], {
					concurrency: "unbounded"
				})
		),
		failed
	)
	if (status !== 0) {
		return yield* failed(`exit ${status}`)
	}
	return out
}, Effect.scoped)

/**
 * The commit the run measures, and whether the working tree differed from it when the run started.
 *
 * @internal
 */
export const sourceIdentity: Effect.Effect<
	SourceIdentity,
	IdentityUnreadable,
	ChildProcessSpawner.ChildProcessSpawner
> = Effect.map(
	Effect.all([git(["rev-parse", "HEAD"]), git(["status", "--porcelain", "--untracked-files=no"])]),
	([sha, status]) => ({ gitSha: Str.trim(sha), gitDirty: Str.trim(status) !== "" })
)

/** The packages whose versions shape what is measured: the runtime, the driver, the compiler toolchain. */
const pinnedPackages = ["effect", "pg", "typescript", "@effect/tsgo"] as const

/** A package manifest, read from disk; only its version is read. */
interface Manifest {
	readonly version: string
}

/**
 * The installed version of each pinned package.
 *
 * @internal
 */
export const packageVersions: Effect.Effect<
	Readonly<Record<string, string>>,
	IdentityUnreadable,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const versions = yield* Effect.forEach(pinnedPackages, (name) =>
		Effect.map(
			fs.readFileString(`${repoRoot}/node_modules/${name}/package.json`),
			(text): readonly [string, string] => [name, trustedJson<Manifest>(text).version]
		)
	)
	return Rec.fromEntries(versions)
}).pipe(Effect.mapError(unreadable("a pinned package's manifest could not be read")))

const machineNote =
	"A virtual machine: timings are noisy and are information, not a performance claim."

const runtimeIdentity: Effect.Effect<RuntimeIdentity, IdentityUnreadable> = Effect.suspend(() =>
	Option.match(Arr.head(cpus()), {
		onNone: () =>
			Effect.fail(
				new IdentityUnreadable({ detail: "the machine reports no CPU to identify the run by" })
			),
		onSome: (cpu) =>
			Effect.succeed({
				node: process.version,
				v8: process.versions.v8,
				execArgv: process.execArgv,
				platform: platform(),
				release: release(),
				arch: arch(),
				cpu: cpu.model,
				cores: availableParallelism(),
				memoryBytes: totalmem(),
				note: machineNote
			})
	})
)

/** The settings a measurement's plan and timing depend on. */
export const serverSettings = [
	"jit",
	"jit_above_cost",
	"jit_inline_above_cost",
	"jit_optimize_above_cost",
	"plan_cache_mode",
	"shared_buffers",
	"work_mem",
	"effective_cache_size",
	"random_page_cost",
	"max_parallel_workers_per_gather",
	"track_io_timing"
] as const

/** The server identity, read on `connection` (the migration identity's connection to the benchmark's database). */
export const serverIdentity = Effect.fn("serverIdentity")(function* (
	connection: PgConnection
): Effect.fn.Return<ServerIdentity, SqlError, Scope.Scope> {
	const pinned = yield* connection.pin
	const [row] = yield* pinned.queryValues(
		`SELECT pg_catalog.version(), pg_catalog.current_setting('server_version'), pg_catalog.current_setting('server_version_num'), ${Arr.join(
			Arr.map(serverSettings, (s) => `pg_catalog.current_setting('${s}')`),
			", "
		)}`,
		[]
	)
	if (row === undefined) {
		return yield* Effect.die(new Error("serverIdentity: no row"))
	}
	const settings = Rec.fromEntries(
		Arr.map(serverSettings, (s, i) => [s, String(row[3 + i])] as const)
	)
	yield* pinned.query("BEGIN", [])
	yield* pinned.query("SET LOCAL jit = on", [])
	const available = yield* pinned.queryValues("SELECT pg_catalog.pg_jit_available()::text", [])
	yield* pinned.query("ROLLBACK", [])
	const extensions = yield* pinned.queryValues(
		"SELECT extname::text, extversion FROM pg_catalog.pg_extension ORDER BY extname",
		[]
	)
	return {
		version: String(row[0]),
		serverVersion: String(row[1]),
		serverVersionNum: Number(row[2]),
		jitAvailable: available[0]?.[0] === "true",
		settings,
		extensions: Rec.fromEntries(
			Arr.map(extensions, ([name, version]) => [String(name), String(version)] as const)
		)
	}
}, Effect.scoped)

/** What an identity records before the run reaches the server: everything but the server. */
export type RunIdentity = Omit<BenchIdentity, "server">

interface RunIdentityInput {
	readonly benchmark: string
	readonly phases: ReadonlyArray<string>
	readonly scope: string
	readonly options: Readonly<Record<string, unknown>>
	readonly source: SourceIdentity
}

/**
 * The identity of a run about to start, read now: the pin, the runtime, the packages and the time.
 *
 * @internal
 */
export const runIdentity = Effect.fn("runIdentity")(function* (input: RunIdentityInput) {
	const pgPin = yield* readPin
	const runtime = yield* runtimeIdentity
	const packages = yield* packageVersions
	const now = yield* DateTime.now
	const identity: RunIdentity = {
		format: benchFormat,
		benchmark: input.benchmark,
		recordedAt: DateTime.formatIso(now),
		source: input.source,
		pgPin,
		runtime,
		packages,
		phases: input.phases,
		scope: input.scope,
		options: input.options
	}
	return identity
})

/**
 * Writes a standalone benchmark's record, JSON indented by tabs, to
 * bench/results/<benchmark>/<benchmark>-<start>.json, its benchmark its identity's and its start the second `startedAt`
 * names, and prints the path.
 */
export const writeRunRecord = Effect.fn("writeRunRecord")(function* (
	startedAt: DateTime.Utc,
	record: { readonly identity: RunIdentity }
) {
	const fs = yield* FileSystem.FileSystem
	const benchmark = record.identity.benchmark
	const outDir = `${repoRoot}/bench/results/${benchmark}`
	const stamp = Str.replaceAll(":", "")(Str.slice(0, 19)(DateTime.formatIso(startedAt)))
	const file = `${outDir}/${benchmark}-${stamp}.json`
	yield* fs.makeDirectory(outDir, { recursive: true })
	yield* fs.writeFileString(file, `${jsonDocument(trusted<Json>(record))}\n`)
	yield* Console.info(`record: ${file}`)
})

interface IdentityInput extends RunIdentityInput {
	readonly server: ServerIdentity
}

/** @internal */
export const benchIdentity = (
	input: IdentityInput
): Effect.Effect<BenchIdentity, IdentityUnreadable, FileSystem.FileSystem> =>
	Effect.map(runIdentity(input), (identity): BenchIdentity => ({
		...identity,
		server: input.server
	}))

/** One field of an identity a reader cannot use: what was measured, by what, where. */
export type IdentityProblem =
	| { readonly kind: "gitSha" }
	| { readonly kind: "pgPin" }
	| { readonly kind: "serverVersion" }
	| { readonly kind: "setting"; readonly setting: (typeof serverSettings)[number] }
	| { readonly kind: "runtime" }
	| { readonly kind: "package"; readonly package: (typeof pinnedPackages)[number] }
	| { readonly kind: "phases" }
	| { readonly kind: "scope" }
	| { readonly kind: "recordedAt" }

/** Why an identity is incomplete: every field a reader needs to know what was measured, by what, where. */
export const identityProblems = (identity: BenchIdentity): ReadonlyArray<IdentityProblem> => {
	const problems: Array<IdentityProblem> = []
	const need = (ok: boolean, problem: IdentityProblem) => {
		if (!ok) {
			problems.push(problem)
		}
	}
	need(regex("^[0-9a-f]{40}$").test(identity.source.gitSha), { kind: "gitSha" })
	need(
		regex("^[0-9a-f]{40}$").test(identity.pgPin.commit) &&
			identity.pgPin.tag !== "" &&
			identity.pgPin.version !== "",
		{
			kind: "pgPin"
		}
	)
	need(identity.server.serverVersion === identity.pgPin.version, { kind: "serverVersion" })
	for (const setting of serverSettings) {
		need(identity.server.settings[setting] !== undefined, { kind: "setting", setting })
	}
	need(identity.runtime.node !== "" && identity.runtime.cpu !== "", { kind: "runtime" })
	for (const p of pinnedPackages) {
		need(identity.packages[p] !== undefined, { kind: "package", package: p })
	}
	need(identity.phases.length > 0, { kind: "phases" })
	need(identity.scope !== "", { kind: "scope" })
	need(!Number.isNaN(Date.parse(identity.recordedAt)), { kind: "recordedAt" })
	return problems
}
