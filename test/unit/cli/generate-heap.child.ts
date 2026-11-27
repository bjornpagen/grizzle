/**
 * The child generate-heap.test.ts starts under `--expose-gc`, given a case (generate-heap.fixtures.ts HeapCase) and a
 * directory: `grizzle generate` of the case's installation (heapConfig) run twice in this process, each from nothing in
 * a directory of its own under the one given, the first so that every function the second calls has run, and is
 * compiled, before the second starts; the second with its phases reported to a meter that collects all garbage at each
 * boundary of heapPhases and reads the heap V8 then holds live (node:v8 getHeapStatistics, used_heap_size). It prints
 * one JSON line (HeapRun): each such boundary of the second run with its live heap, in order, and the bytes of each file
 * the second run wrote, by its path in the schema's directory.
 */
import { getHeapStatistics } from "node:v8"
import { defined } from "@bjornpagen/testing/assert"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { processMeter } from "#cli/main.ts"
import type { PhaseMeter } from "#cli/phases.ts"
import { runCli } from "#cli/run.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import {
	type HeapBoundary,
	type HeapCase,
	heapConfig,
	heapPhases,
	type HeapRun
} from "#test/unit/cli/generate-heap.fixtures.ts"

/** V8's full collection, which `--expose-gc` gives the process. */
const collect = defined(globalThis.gc, "the child runs under --expose-gc")

/** A meter recording, at each boundary of heapPhases, the heap live once every garbage is collected. */
const heapMeter = (boundaries: Array<HeapBoundary>): PhaseMeter => ({
	read: processMeter.read,
	write: (line) => {
		const [, , label = "", edge] = Str.split(line, " ")
		const [name] = Str.split(label, "/")
		if ((edge === "start" || edge === "end") && Arr.some(heapPhases, (p) => p === name)) {
			collect()
			boundaries.push({ label, edge, live: getHeapStatistics().used_heap_size })
		}
	}
})

const main = Effect.gen(function* () {
	const [caseText = "", dir = ""] = process.argv.slice(2)
	const config = heapConfig(trustedJson<HeapCase>(caseText))
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const generate = (at: string, meter: PhaseMeter, flags: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			yield* fs.makeDirectory(at, { recursive: true })
			const report = yield* runCli(
				["generate", path.join(at, "grizzle.config.ts"), "--name", "init", ...flags],
				at,
				process.version,
				(file) => Effect.succeed({ file, value: config, closure: [] }),
				meter
			)
			if (report.code !== 0) {
				return yield* Effect.die(Arr.join([...report.stdout, ...report.stderr], "\n"))
			}
		})
	yield* generate(path.join(dir, "warm"), processMeter, [])
	const boundaries: Array<HeapBoundary> = []
	const measured = path.join(dir, "measured")
	yield* generate(measured, heapMeter(boundaries), ["--phases"])
	const migrations = path.join(measured, "migrations")
	const [ident = ""] = yield* fs.readDirectory(migrations)
	const schemaDir = path.join(migrations, ident)
	const files: Array<readonly [string, number]> = []
	for (const entry of yield* fs.readDirectory(schemaDir, { recursive: true })) {
		const info = yield* fs.stat(path.join(schemaDir, entry))
		if (info.type === "File") {
			files.push([entry, Number(info.size)])
		}
	}
	const run: HeapRun = { boundaries, files }
	yield* Effect.sync(() => process.stdout.write(`${jsonText(run)}\n`))
})

NodeRuntime.runMain(Effect.provide(main, NodeServices.layer))
