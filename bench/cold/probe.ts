import net from "node:net"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Layer,
	Order,
	Redacted,
	Result,
	Stdio,
	Stream
} from "effect"
import type { ColdLogin } from "#bench/cold/workload.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"

const boot = performance.now()

/**
 * One cold start of an application, in a fresh Node process, serving the cold bench's login (bench/cold/workload.ts)
 * from its served file, as an application serves the file `grizzle generate` committed: by the login's type alone, so
 * no schema module is evaluated and nothing is compiled.
 *
 * bench/cold/run.ts spawns this file once per sample and writes the run's input to its stdin as JSON, the served file's
 * text among it. The process starts with nothing of grizzle loaded: this module has no static import of the library,
 * because ESM evaluates every static dependency before the module's first statement, so the first reading of
 * performance.now() below is the process's own boot time (Node's startup and this module's load, measured from the
 * process's time origin). Then:
 *
 * - mode "load": import the runtime entry, @bjornpagen/grizzle/runtime, parse the served file's text, and load it as a
 *   layer does (adapter/served/load.ts loadServed): every encoder, decoder and reader of its programs built, and none
 *   compiled.
 * - mode "database": the same import and parse, then the serverless cold start of a read: build the DbLayer over the
 *   served file (its load and its first session), Db.open, the first execution of each served read (statement parse on
 *   the backend and the round trip) and its warm executions.
 *
 * The result is one line on stdout, prefixed by resultMarker; anything else the process prints is ignored. The
 * password arrives on stdin, never in argv or the environment, and never appears in the result.
 */
export const resultMarker = "GRIZZLE-BENCH-COLD "

export type ProbeDatabase = {
	readonly host: string
	readonly port: number
	readonly database: string
	/** The password of the cold bench's login `server`, whose role `reader` the probe opens. */
	readonly password: string
	readonly caFile: string
	/** The connect timeout of the probe's connection, its parent's (bench/harness/limits.ts benchConnectTimeout). */
	readonly connectTimeoutMs: number
	/** The idle timeout of the probe's pool, its parent's (bench/harness/limits.ts benchIdleTimeout). */
	readonly idleTimeoutMs: number
	/** The account whose tasks the parameterized reads read. */
	readonly account: Uuid
}

/** A load probe, or a database probe with the installation it reads; each with the login's served file's text. */
export type ProbeInput =
	| { readonly mode: "load"; readonly warmRepeats: number; readonly served: string }
	| {
			readonly mode: "database"
			readonly warmRepeats: number
			readonly served: string
			readonly database: ProbeDatabase
	  }

export type ProbeResult = {
	readonly mode: "load" | "database"
	/** Milliseconds per phase, in the order they ran. */
	readonly phases: Readonly<Record<string, number>>
	/** Per read: milliseconds per measure, and the rows it delivered. */
	readonly queries: Readonly<Record<string, Readonly<Record<string, number>>>>
	readonly memory: { readonly rssBytes: number; readonly heapUsedBytes: number }
}

const round = (x: number): number => Math.round(x * 1000) / 1000
const since = (start: number): number => round(performance.now() - start)

/** The sample at index i of nonempty samples. */
const sampleAt = (xs: ReadonlyArray<number>, i: number): number => {
	const x = xs[i]
	if (x === undefined) {
		throw new Error(`no sample ${i} of ${xs.length}`)
	}
	return x
}

const median = (xs: ReadonlyArray<number>): number => {
	const sorted = Arr.sort(xs, Order.Number)
	return round(sampleAt(sorted, Math.ceil(sorted.length / 2) - 1))
}

/** The run's input, the JSON bench/cold/run.ts writes to the probe's stdin. */
const readStdin = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	return yield* Stream.mkString(Stream.decodeText(stdio.stdin))
})

const main = Effect.gen(function* () {
	const text = yield* readStdin
	const phases: Record<string, number> = { bootMs: round(boot) }
	const queries: Record<string, Record<string, number>> = {}

	let t = performance.now()
	const runtime = yield* Effect.promise(() => import("@bjornpagen/grizzle/runtime"))
	phases["importEntryMs"] = since(t)
	/** The input is read once the entry is loaded, outside every measured phase. */
	const { trustedJson } = yield* Effect.promise(() => import("#compiler/core/trusted.ts"))
	const input = trustedJson<ProbeInput>(text)
	if (!(Number.isInteger(input.warmRepeats) && input.warmRepeats >= 1)) {
		throw new Error(`warmRepeats must be a positive integer, not ${input.warmRepeats}`)
	}
	t = performance.now()
	const file = trustedJson<unknown>(input.served)
	phases["parseServedMs"] = since(t)

	if (input.mode === "load") {
		/** What a layer runs over the served file when it is built; already loaded by the entry. */
		const { loadServed } = yield* Effect.promise(() => import("#adapter/served/load.ts"))
		const { servedFile } = yield* Effect.promise(() => import("#compiler/served/json.ts"))
		t = performance.now()
		const loaded = loadServed(servedFile(file), "server")
		phases["loadServedMs"] = since(t)
		if (Result.isFailure(loaded)) {
			throw new Error(`the served file does not load: ${String(loaded.failure)}`)
		}
	} else {
		const target = input.database
		const fs = yield* FileSystem.FileSystem
		const ca = yield* fs.readFileString(target.caFile)
		/** node-postgres, as an application imports it beside grizzle, read once the measured imports are done. */
		const pg = yield* Effect.promise(() => import("pg"))
		const login = runtime.served<ColdLogin>(file, "server")
		const password: Redacted.Redacted = Redacted.make(target.password)
		const layer = runtime.DbLayer.make({
			driver: pg.default,
			transport: {
				kind: "sslRequest",
				host: target.host,
				port: target.port,
				open: () => new net.Socket(),
				ca,
				servername: target.host
			},
			database: target.database,
			password,
			connectTimeoutMs: target.connectTimeoutMs,
			pool: { max: 1, min: 1, idleTimeoutMs: target.idleTimeoutMs },
			login
		})
		const params = { account: target.account }
		let opened = 0
		let finished = 0
		/** The first execution of a read, then its warm executions, each collected to host values. */
		const measure = <Row, E>(
			name: string,
			read: () => Effect.Effect<{ readonly collect: Effect.Effect<ReadonlyArray<Row>, E> }, E>
		) =>
			Effect.gen(function* () {
				let s = performance.now()
				const rows = yield* Effect.flatMap(read(), (result) => result.collect)
				const firstMs = since(s)
				const warm: Array<number> = []
				for (let i = 0; i < input.warmRepeats; i++) {
					s = performance.now()
					const again = yield* Effect.flatMap(read(), (result) => result.collect)
					warm.push(since(s))
					if (again.length !== rows.length) {
						throw new Error(`${name}: warm read ${i} differs`)
					}
				}
				queries[name] = {
					firstExecuteMs: firstMs,
					warmExecuteFirstMs: sampleAt(warm, 0),
					warmExecuteP50Ms: median(warm),
					rows: rows.length
				}
			})
		const executions = Effect.gen(function* () {
			opened = performance.now()
			const db = yield* runtime.Db.open(login.roles.reader, {})
			phases["openMs"] = since(opened)
			const reads = db.workload
			yield* measure("automaticTasksFor", () => reads.automaticTasksFor.execute(params))
			yield* measure("automaticBudgetFor", () => reads.automaticBudgetFor.execute(params))
			yield* measure("taskCards", () => reads.taskCards.execute(params))
			yield* measure("largestPerAccount", () => reads.largestPerAccount.execute({}))
			finished = performance.now()
		})
		/** The layer is built in the read's own scope, which closes the session before the layer, as providing it would. */
		const program = Effect.gen(function* () {
			const context = yield* Layer.build(layer)
			phases["layerMs"] = since(t)
			yield* Effect.provide(executions, context)
		})
		t = performance.now()
		yield* Effect.scoped(program)
		phases["closeMs"] = since(finished)
	}
	const memory = process.memoryUsage()
	const result: ProbeResult = {
		mode: input.mode,
		phases,
		queries,
		memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed }
	}
	return result
})

/** The probe's one result line on stdout: the result as JSON. */
const probe = Effect.gen(function* () {
	const result = yield* main
	const { jsonText } = yield* Effect.promise(() => import("#compiler/core/trusted.ts"))
	yield* Console.log(`${resultMarker}${jsonText(result)}`)
})

if (import.meta.filename === process.argv[1]) {
	const { NodeRuntime, NodeServices } = await import("@effect/platform-node")
	NodeRuntime.runMain(probe.pipe(Effect.provide(NodeServices.layer)))
}
