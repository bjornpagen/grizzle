import {
	Array as Arr,
	Data,
	Effect,
	FileSystem,
	Option,
	Record as Rec,
	Redacted,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { compileServed } from "#adapter/public/compile.ts"
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
import { elapsed, type Summary, summarize, summarizePhases } from "#bench/cold/stats.ts"
import { coldLogin } from "#bench/cold/workload.ts"
import { benchConnectTimeout, benchIdleTimeout } from "#bench/harness/limits.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonDocument, jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import { schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { pgPin } from "#test/support/env.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The cold-start benchmark of an application serving its login's served file: the runtime entry's import, the served
 * file's parse and load, the serverless cold start of a read, and first and warm backend behavior.
 *
 * Every sample is a fresh Node process running bench/cold/probe.ts, so nothing of grizzle is loaded and every cache
 * is empty when it starts; samples run one after another, never concurrently, so one does not slow another. Both
 * series serve the cold bench's login (bench/cold/workload.ts), its served file compiled once by the compile
 * `grizzle generate` runs (adapter/public/compile.ts compileServed), under the snapshot of the Work fixture installed
 * under a unique schema in a database of the series' own.
 *
 * - load: the runtime entry's import, the served file's parse, and its load as a layer loads it, every program's
 *   encoders, decoders and readers built and none compiled.
 * - database, direct to PostgreSQL: the serverless cold start of a read, the DbLayer over the served file (its load
 *   and its first session) and Db.open, each served read's first execution and its warm executions.
 *
 * The record carries the full identity (identity.ts), the conditions of each series (schema and index state, data
 * distribution, parameters, result semantics, cache state, samples, scope), summaries, and every raw sample. Nothing here is a gate: the timings of this machine are information.
 */
export interface ColdOptions {
	/** Fresh processes for the load series. */
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
	"parseServedMs",
	"loadServedMs",
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
	/** The connection a database series reads through; a load series opens none. */
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
	readonly load: ColdSeries
	readonly database: ColdSeries
}

const probePath = `${repoRoot}/bench/cold/probe.ts`

/** A probe process that did not deliver its result: its exit and what it wrote on stderr. */
class ProbeFailed extends Data.TaggedError("ProbeFailed")<{ readonly detail: string }> {}

const probeFailed =
	(detail: string) =>
	(cause: unknown): ProbeFailed =>
		new ProbeFailed({ detail: `${detail}: ${String(cause)}` })

/** One fresh process: the probe, its input on stdin, killed with its process group when the sample is interrupted. */
const sample = Effect.fn("sample")(
	function* (input: ProbeInput) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const text = jsonText(input)
		const started = performance.now()
		const [stdout, stderr, status] = yield* Effect.scoped(
			Effect.gen(function* () {
				const child = yield* spawner.spawn(
					ChildProcess.make(process.execPath, [probePath], {
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
					{ concurrency: "unbounded" }
				)
			})
		)
		const processWallMs = elapsed(started)
		const line = Arr.findFirst(Str.split(stdout, "\n"), (l) => Str.startsWith(resultMarker)(l))
		if (status !== 0 || Option.isNone(line)) {
			return yield* new ProbeFailed({
				detail: `bench/cold/probe.ts exited with ${status}: ${stderr}`
			})
		}
		const result = trustedJson<ProbeResult>(Str.slice(resultMarker.length)(line.value))
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
	"the Work fixture: 6 relations (one closed roster), the alternatives law; its login serving 4 reads to its reader"

const loadConditions: ColdConditions = {
	workload,
	schemaState: "the served file compiled under the installation's snapshot; no connection",
	dataDistribution: "none",
	parameters: {},
	resultSemantics:
		"the served file parsed and loaded: every program's encoders, decoders and readers built",
	cacheState: "process cold (no module loaded); the OS file cache is warm after the first sample",
	connection: { kind: "none" }
}

const databaseConditions = (port: number): ColdConditions => ({
	workload,
	schemaState:
		"the Work fixture installed by the fresh-install compiler under a unique schema, with its login's workload's indexes; no ANALYZE",
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
	"Cold starts in fresh Node processes serving a login's served file: the runtime entry's import, the served file's parse and load; and the serverless cold start of reads (DbLayer, Db.open, first and warm executions). Excludes network latency beyond localhost and the Vercel deployment."

/**
 * Both series and the server's identity, in a database of its own cloned from the template, which bench/cold/main.ts
 * sweeps once the series have run: the Work fixture installed with the cold bench's login, and that login's served
 * file compiled under the installation's snapshot, the cold bench's login rebuilt over the installed schema's name.
 */
const benchRun = Effect.fn("benchRun")(function* (options: ColdOptions) {
	const s = yield* Substrate
	const server = yield* serverIdentity(s.admin)
	const work = yield* install(W.Work, {
		ambient: ordinarySession,
		label: "cold",
		logins: [coldLogin(W.Work)],
		extensions: []
	})
	yield* load(work, workFacts)
	const installed = coldLogin(schema(work.schema, W.Work.relations, W.Work.statements))
	const compiled = yield* compileServed(
		installed,
		snapshotValue(work.snapshot, work.installation),
		installed.workload
	)
	const served = jsonText(trusted<Json>(compiled))
	const loadRaw = yield* Effect.forEach(
		upTo(options.samples, (i) => i),
		() => sample({ mode: "load", warmRepeats: options.warmRepeats, served })
	)
	/** The credentials of the cold bench's login, whose reader role the probe opens. */
	const credentials = work.as(installed)
	const target: ProbeDatabase = {
		host: pgPin.host,
		port: pgPin.port,
		database: s.database,
		password: Redacted.value(credentials.password),
		caFile: s.cluster.caFile,
		account: a1,
		connectTimeoutMs: benchConnectTimeout.value,
		idleTimeoutMs: benchIdleTimeout.value
	}
	const databaseRaw = yield* Effect.forEach(
		upTo(options.databaseSamples, (i) => i),
		() => sample({ mode: "database", warmRepeats: options.warmRepeats, served, database: target })
	)
	return {
		server,
		load: series(loadConditions, loadRaw),
		database: series(databaseConditions(pgPin.port), databaseRaw)
	}
}, Effect.scoped)

/** The benchmark: the load series, then the database series, in a database of its own. */
const coldBench = Effect.fn("coldBench")(function* (options: ColdOptions) {
	const source = yield* sourceIdentity
	const run = yield* benchRun(options)
	const identity = yield* benchIdentity({
		benchmark: "cold",
		server: run.server,
		phases: coldPhases,
		scope: coldScope,
		options: { ...options },
		source
	})
	return { identity, load: run.load, database: run.database } satisfies ColdRecord
})

export const recordFile = (outDir: string): string => `${outDir}/cold.json`

const writtenBench = Effect.fn("writtenBench")(function* (options: ColdOptions, outDir: string) {
	const fs = yield* FileSystem.FileSystem
	const record = yield* coldBench(options)
	yield* fs.makeDirectory(outDir, { recursive: true })
	yield* fs.writeFileString(recordFile(outDir), `${jsonDocument(trusted<Json>(record))}\n`)
	return record
})

/**
 * Runs the benchmark and writes its record to `outDir`/cold.json.
 */
export const runColdBench = (
	options: ColdOptions,
	outDir: string
): ReturnType<typeof writtenBench> => writtenBench(options, outDir)
