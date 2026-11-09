import net from "node:net"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Layer,
	Order,
	Record as Rec,
	Redacted,
	Stdio,
	Stream
} from "effect"
import { queryInput } from "#compiler/program/compile.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"

const boot = performance.now()

/**
 * One cold start, in a fresh Node process: cold import and compile costs, in cold and warm cases. A warm
 * compilation compiles the same query again with the process's modules loaded.
 *
 * bench/cold/run.ts spawns this file once per sample and writes the run's input to its stdin as JSON. The process
 * starts with nothing of grizzle loaded: this module has no static import of the library, because ESM evaluates every
 * static dependency before the module's first statement, so the first reading of performance.now() below is the
 * process's own boot time (Node's startup and this module's load, measured from the process's time origin). Then:
 *
 * - mode "compile": import the package entry, packages/grizzle/src/index.ts (#index.ts, the file package.json's "." export names under
 *   the grizzle-source condition), then the workload (the Work fixture's schema and queries, built by the public
 *   builders); compile the schema's artifacts once, as a DbLayer does; compile each query for the first time; then
 *   compile each one again, warm, as a Db compiles a program it runs without compiling it ahead.
 * - mode "database": the same imports, then the serverless cold start of a read: build the DbLayer, Db.open (the first
 *   session, admission and the schema's artifacts), the first execution of each query (its compilation, statement
 *   parse on the backend and the round trip) and warm executions, each compiled again and sent unnamed.
 *   The standalone compile phases are not run first, so nothing the read pays for is already warm.
 *
 * The result is one line on stdout, prefixed by resultMarker; anything else the process prints is ignored. The
 * password arrives on stdin, never in argv or the environment, and never appears in the result.
 */
export const resultMarker = "GRIZZLE-BENCH-COLD "

export type ProbeDatabase = {
	readonly host: string
	readonly port: number
	readonly database: string
	readonly schema: string
	/** The password of the Work fixture's login `server`, whose role `reader` the probe opens. */
	readonly password: string
	readonly caFile: string
	/** The committed snapshot.json the installation reached, which the application passes to Db.open. */
	readonly snapshot: string
	/** The connect timeout of the probe's connection, its parent's (bench/harness/limits.ts benchConnectTimeout). */
	readonly connectTimeoutMs: number
	/** The idle timeout of the probe's pool, its parent's (bench/harness/limits.ts benchIdleTimeout). */
	readonly idleTimeoutMs: number
	/** The account whose tasks the parameterized queries read. */
	readonly account: Uuid
}

/** A compile probe, or a database probe with the installation it reads. */
export type ProbeInput =
	| { readonly mode: "compile"; readonly warmRepeats: number }
	| { readonly mode: "database"; readonly warmRepeats: number; readonly database: ProbeDatabase }

export type ProbeResult = {
	readonly mode: "compile" | "database"
	/** Milliseconds per phase, in the order they ran. */
	readonly phases: Readonly<Record<string, number>>
	/** Per query: milliseconds per measure, and the statements or rows it involved. */
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
	const grizzle = yield* Effect.promise(() => import("#index.ts"))
	phases["importEntryMs"] = since(t)
	t = performance.now()
	const { snapshotJson } = yield* Effect.promise(() => import("#test/support/snapshot-json.ts"))
	const W = yield* Effect.promise(() => import("#test/support/fixtures/api/work.ts"))
	phases["importWorkloadMs"] = since(t)
	/** The input is read once the entry is loaded, outside every measured phase. */
	const { trustedJson } = yield* Effect.promise(() => import("#compiler/core/trusted.ts"))
	const input = trustedJson<ProbeInput>(text)
	if (!(Number.isInteger(input.warmRepeats) && input.warmRepeats >= 1)) {
		throw new Error(`warmRepeats must be a positive integer, not ${input.warmRepeats}`)
	}

	if (input.mode === "compile") {
		/** The compilation a Db runs for a program (program/template.ts); already loaded by the entry. */
		const { templateFor } = yield* Effect.promise(() => import("#compiler/program/template.ts"))
		const { parseSchemaInput, schemaArtifacts } = yield* Effect.promise(
			() => import("#compiler/program/schema.ts")
		)
		/** The engine's Result, the answer of every compile step below. */
		const Engine = yield* Effect.promise(() => import("#compiler/core/result.ts"))
		/** A snapshot read as the Work fixture's reader role, as a Db of it compiles one. */
		const reading = { context: "snapshot", read: "rows" } as const
		const reader = W.workWorlds(W.Work).reader
		t = performance.now()
		const schemaInput = parseSchemaInput(reader)
		if (!schemaInput.ok) {
			throw new Error(`schema input: ${schemaInput.error.message}`)
		}
		/** A fresh installation's codes, as a first install's snapshot records them. */
		const { firstCodebook } = yield* Effect.promise(() => import("#compiler/ir/codes.ts"))
		const { ownRole, rostersOf } = yield* Effect.promise(() => import("#compiler/schema/own.ts"))
		const owned = schemaInput.value.kind === "role" ? ownRole(schemaInput.value.desc) : undefined
		if (owned === undefined || !owned.ok) {
			throw new Error("schema input: the Work fixture's reader is a role over its schema")
		}
		const artifacts = schemaArtifacts(schemaInput.value, {
			codes: firstCodebook(rostersOf(owned.value.base))
		})
		phases["schemaArtifactsMs"] = since(t)
		if (!artifacts.ok) {
			throw new Error(`schema artifacts: ${artifacts.error.message}`)
		}
		const workload = {
			automaticTasksFor: W.automaticTasksFor,
			automaticBudgetFor: W.automaticBudgetFor,
			taskCards: W.taskCards,
			largestPerAccount: W.largestPerAccount,
			labeledAutomaticTasks: W.labeledAutomaticTasks
		}
		for (const [name, query] of Rec.toEntries(workload)) {
			t = performance.now()
			const compile = () =>
				Engine.flatMap(queryInput(query), (q) =>
					templateFor(q, schemaInput.value, artifacts.value, reading)
				)
			const first = compile()
			const firstMs = since(t)
			if (!first.ok) {
				throw new Error(`${name}: ${first.error.message}`)
			}
			const warm: Array<number> = []
			for (let i = 0; i < input.warmRepeats; i++) {
				t = performance.now()
				const again = compile()
				warm.push(since(t))
				if (!again.ok) {
					throw new Error(`${name}: warm compilation ${i} refused`)
				}
			}
			queries[name] = {
				firstCompileMs: firstMs,
				warmCompileFirstMs: sampleAt(warm, 0),
				warmCompileP50Ms: median(warm),
				statements: first.value.template.optimized.length
			}
		}
	} else {
		const target = input.database
		const fs = yield* FileSystem.FileSystem
		const ca = yield* fs.readFileString(target.caFile)
		/** node-postgres, as an application imports it beside grizzle, read once the measured imports are done. */
		const pg = yield* Effect.promise(() => import("pg"))
		/**
		 * The Work fixture under the installed schema name, its worlds over it, so the Db logs in as the installed login and
		 * takes on the installed reader role, and its reads over it.
		 */
		const work = grizzle.schema(target.schema, W.Work.relations, W.Work.statements)
		const worlds = W.workWorlds(work)
		const reads = W.workReads(work)
		const password: Redacted.Redacted = Redacted.make(target.password)
		const layer = grizzle.DbLayer.make({
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
			login: worlds.server,
			snapshot: snapshotJson(target.snapshot)
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
			const db = yield* grizzle.Db.open(worlds.server.roles.reader, {})
			phases["openMs"] = since(opened)
			yield* measure("automaticTasksFor", () => db.execute(reads.automaticTasksFor, params))
			yield* measure("automaticBudgetFor", () => db.execute(reads.automaticBudgetFor, params))
			yield* measure("taskCards", () => db.execute(reads.taskCards, params))
			yield* measure("largestPerAccount", () => db.execute(reads.largestPerAccount, {}))
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
