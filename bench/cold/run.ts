import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Record as Rec,
	Redacted,
	Result,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { toResult } from "#adapter/engine.ts"
import {
	type BenchIdentity,
	benchIdentity,
	repoRoot,
	serverIdentity,
	sourceIdentity
} from "#bench/cold/identity.ts"

import {
	type ProbeDatabase,
	type ProbeInput,
	type ProbeResult,
	resultMarker
} from "#bench/cold/probe.ts"
import { decodeProbeResult, encodeProbeInput } from "#bench/cold/protocol.ts"
import { elapsed, type Summary, summarize, summarizePhases } from "#bench/cold/stats.ts"
import { writeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { pgPin } from "#test/support/env.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { sourceCondition } from "#test/support/process.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cold-start benchmark: cold import, first compile and warm hit; cold import and compile costs; cold-start and
 * pooled serverless cases; first and warm backend behavior, in cold and warm cases.
 *
 * Every sample is a fresh Node process running bench/cold/probe.ts, so nothing of grizzle is loaded and every cache
 * is empty when it starts; samples run one after another, never concurrently, so one does not slow another.
 *
 * - compile: the package entry's import, the workload's (the Work fixture's schema and five queries),
 *   the schema's artifacts, each query's first compilation and its warm compilations.
 * - database, direct to PostgreSQL: the serverless cold start of a read, DbLayer and Db.open (first session,
 *   admission), each query's first execution and its warm executions, against the Work fixture installed under a
 *   unique schema in a database of the series' own.
 *
 * The record carries the full identity (identity.ts), the conditions of each series (schema and index state, data
 * distribution, parameters, result semantics, cache state, samples, scope), summaries, and every raw sample. Nothing here is a gate: the timings of this machine are information.
 */
export interface ColdOptions {
	/** Fresh processes for the compile series. */
	readonly samples: number
	/** Fresh processes for the database series. */
	readonly databaseSamples: number
	/** Warm lookups or executions after each first one. */
	readonly warmRepeats: number
	readonly quick: boolean
}

export const coldDefaults: ColdOptions = {
	samples: 20,
	databaseSamples: 10,
	warmRepeats: 50,
	quick: false
}

export const coldQuick: ColdOptions = {
	samples: 2,
	databaseSamples: 1,
	warmRepeats: 3,
	quick: true
}

const coldPhases = [
	"bootMs",
	"importEntryMs",
	"importWorkloadMs",
	"schemaArtifactsMs",
	"firstCompileMs",
	"warmCompileMs",
	"layerMs",
	"openMs",
	"firstExecuteMs",
	"warmExecuteMs",
	"closeMs",
	"processWallMs"
] as const

interface ColdSample {
	/** From spawning the process to its exit, as the parent saw it. */
	readonly processWallMs: number
	readonly result: ProbeResult
}

/** What a series measured under. */
interface ColdConditions {
	readonly workload: string
	readonly schemaState: string
	readonly dataDistribution: string
	readonly parameters: Readonly<Record<string, unknown>>
	readonly resultSemantics: string
	readonly cacheState: string
	/** The connection a database series reads through; a compile series opens none. */
	readonly connection:
		| { readonly kind: "none" }
		| { readonly kind: "database"; readonly port: number }
}

export interface ColdSeries {
	readonly conditions: ColdConditions
	readonly samples: number
	readonly processWallMs: Summary
	readonly phases: Readonly<Record<string, Summary>>
	readonly queries: Readonly<Record<string, Readonly<Record<string, Summary>>>>
	readonly memory: { readonly rssBytes: Summary; readonly heapUsedBytes: Summary }
	readonly raw: ReadonlyArray<ColdSample>
}

interface ColdRecord {
	readonly identity: BenchIdentity
	readonly compile: ColdSeries
	readonly database: ColdSeries
}

const probePath = `${repoRoot}/bench/cold/probe.ts`

/** A probe process that did not deliver its result: its exit and what it wrote on stderr. */
class ProbeFailed extends Schema.TaggedError<ProbeFailed, { readonly brand: unique symbol }>()(
	"ProbeFailed",
	{
		detail: Schema.String
	}
) {}

const probeFailed =
	(detail: string) =>
	(cause: unknown): ProbeFailed =>
		ProbeFailed.make({ detail: `${detail}: ${String(cause)}` })

/** One fresh process: the probe, its input on stdin, killed with its process group when the sample is interrupted. */
const sample = Effect.fn("sample")(
	function* (input: ProbeInput) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const text = yield* encodeProbeInput(input)
		const started = performance.now()
		const [stdout, stderr, status] = yield* Effect.scoped(
			Effect.gen(function* () {
				const child = yield* spawner.spawn(
					ChildProcess.make(process.execPath, [sourceCondition, probePath], {
						cwd: repoRoot,
						stdin: { stream: Stream.make(new TextEncoder().encode(text)), endOnDone: true },
						stdout: "pipe",
						stderr: "pipe",
						killSignal: "SIGKILL"
					})
				)
				return yield* Effect.all(
					[
						Stream.mkString(Stream.decodeText(child.stdout)),
						Stream.mkString(Stream.decodeText(child.stderr)),
						child.exitCode
					],
					{ concurrency: 3 }
				)
			})
		)
		const processWallMs = elapsed(started)
		const line = Arr.findFirst(Str.split(stdout, "\n"), (l) => Str.startsWith(resultMarker)(l))
		if (status !== 0 || Option.isNone(line)) {
			return yield* ProbeFailed.make({
				detail: `bench/cold/probe.ts exited with ${status}: ${stderr}`
			})
		}
		const result = yield* decodeProbeResult(Str.slice(resultMarker.length)(line.value))
		const taken: ColdSample = { processWallMs, result }
		return taken
	},
	Effect.mapError(probeFailed("a cold sample failed"))
)

const series = (conditions: ColdConditions, raw: ReadonlyArray<ColdSample>): ColdSeries => {
	const names = Option.match(Arr.head(raw), {
		onNone: () => [],
		onSome: (first) => Rec.keys(first.result.queries)
	})
	const queries: Record<string, Readonly<Record<string, Summary>>> = {}
	for (const name of names) {
		queries[name] = summarizePhases(
			Arr.map(raw, (s) => {
				const q = s.result.queries[name]
				if (q === undefined) {
					throw new Error(`a sample without query ${name}`)
				}
				return q
			})
		)
	}
	return {
		conditions,
		samples: raw.length,
		processWallMs: summarize(Arr.map(raw, (s) => s.processWallMs)),
		phases: summarizePhases(Arr.map(raw, (s) => s.result.phases)),
		queries,
		memory: {
			rssBytes: summarize(Arr.map(raw, (s) => s.result.memory.rssBytes)),
			heapUsedBytes: summarize(Arr.map(raw, (s) => s.result.memory.heapUsedBytes))
		},
		raw
	}
}

const workload =
	"the Work fixture: 6 relations (one closed roster), the alternatives law; 5 queries for compile, 4 for reads"

const compileConditions: ColdConditions = {
	workload,
	schemaState: "not installed: compilation only",
	dataDistribution: "none",
	parameters: {},
	resultSemantics:
		"a compiled template per query, optimized and conservative artifacts, for the snapshot context; a warm compilation compiles the same query again",
	cacheState: "process cold (no module loaded); the OS file cache is warm after the first sample",
	connection: { kind: "none" }
}

const databaseConditions = (port: number): ColdConditions => ({
	workload,
	schemaState:
		"the Work fixture installed by the fresh-install compiler under a unique schema; primary-key, key and law indexes only; no ANALYZE",
	dataDistribution:
		"the Work fixture's golden facts: 6 accounts, 7 tasks, 4 automatic arms, 3 manual arms, 2 notes",
	parameters: { account: a1 },
	resultSemantics:
		"every read collected to host values; a warm read must deliver as many rows as the first",
	cacheState:
		"process cold: a new DbLayer, so a new pool and backend; shared buffers warm after the first sample",
	connection: { kind: "database", port }
})

const coldScope =
	"Cold starts in fresh Node processes: module import, workload construction, schema artifacts, first and warm compilations; and the serverless cold start of reads (DbLayer, Db.open with admission, first and warm executions). Excludes network latency beyond localhost and the Vercel deployment."

/**
 * The database series and the server's identity, in a database of its own cloned from the template, which
 * bench/cold/main.ts sweeps once the series has run.
 */
const databaseRun = Effect.fn("databaseRun")(function* (options: ColdOptions) {
	const s = yield* Substrate
	const server = yield* serverIdentity(s.admin)
	const work = yield* install(W.Work, {
		ambient: ordinarySession,
		label: "cold",
		logins: [W.workWorlds(W.Work).server],
		extensions: []
	})
	yield* load(work, workFacts)
	/** The credentials of the Work fixture's login, whose reader role the probe opens. */
	const credentials = work.as(W.workWorlds(W.Work).server)
	const target: ProbeDatabase = {
		host: pgPin.host,
		port: pgPin.port,
		database: s.database,
		schema: work.schema,
		password: Redacted.value(credentials.password),
		caFile: s.cluster.caFile,
		snapshot: Result.getOrThrow(toResult(writeSnapshot(work.snapshot))),
		account: a1
	}
	const raw = yield* Effect.forEach(
		Arr.makeBy(options.databaseSamples, (i) => i),
		() => sample({ mode: "database", warmRepeats: options.warmRepeats, database: target })
	)
	return { server, series: series(databaseConditions(pgPin.port), raw) }
}, Effect.scoped)

/** The benchmark: the compile series, then the database series in a database of its own. */
const coldBench = Effect.fn("coldBench")(function* (options: ColdOptions) {
	const source = yield* sourceIdentity
	const compileRaw = yield* Effect.forEach(
		Arr.makeBy(options.samples, (i) => i),
		() => sample({ mode: "compile", warmRepeats: options.warmRepeats })
	)

	const head = yield* databaseRun(options)
	const database = head.series
	const identity = yield* benchIdentity({
		benchmark: "cold",
		server: head.server,
		phases: coldPhases,
		scope: coldScope,
		options: { ...options },
		source
	})
	return {
		identity,
		compile: series(compileConditions, compileRaw),
		database
	} satisfies ColdRecord
})

export const recordFile = (outDir: string): string => `${outDir}/cold.json`

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: "\t" }))

const writtenBench = Effect.fn("writtenBench")(function* (options: ColdOptions, outDir: string) {
	const fs = yield* FileSystem.FileSystem
	const record = yield* coldBench(options)
	yield* fs.makeDirectory(outDir, { recursive: true })
	yield* fs.writeFileString(recordFile(outDir), `${yield* encodeRecord(record)}\n`)
	return record
})

/**
 * Runs the benchmark and writes its record to `outDir`/cold.json.
 *
 * @internal
 */
export const runColdBench = (
	options: ColdOptions,
	outDir: string
): ReturnType<typeof writtenBench> => writtenBench(options, outDir)
