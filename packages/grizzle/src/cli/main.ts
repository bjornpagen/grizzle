import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Console, Effect, FileSystem, Path, String as Str } from "effect"
import type { ConfigFile } from "#cli/config.ts"
import {
	type CliError,
	ConfigMissing,
	ConfigUnloaded,
	cliError,
	ExportRefused,
	thrownOf
} from "#cli/errors.ts"
import type { PhaseMeter } from "#cli/phases.ts"
import { runCli } from "#cli/run.ts"
import { argumentsStart } from "#cli/usage.ts"

const written = (
	write: (text: string) => Effect.Effect<void>,
	lines: ReadonlyArray<string>
): Effect.Effect<void> => (lines.length === 0 ? Effect.void : write(Arr.join(lines, "\n")))

/** The refusal of the configuration file `file`, which could not be found or imported, for what was thrown. */
const unloaded =
	(file: string) =>
	(cause: unknown): CliError =>
		cliError(new ConfigUnloaded({ file, thrown: thrownOf(cause) }))

/**
 * The configuration file at `file`, the absolute path the command line names, imported once.
 *
 * It lies outside grizzle's sources, so the command line imports it by one fixed specifier, `grizzle:config`, which a module
 * resolve hook maps to its file: every import in src/ keeps a literal specifier, the dependency audit's condition for
 * knowing src/'s whole import graph (test/unit/deps), and the application's configuration is an external module of
 * that graph, as `effect` is. A process runs one command line, so the hook answers that specifier with one file, and
 * only a command that reads the configuration imports it.
 *
 * A load hook records every file module Node loads while the import runs, the configuration file first: its closure,
 * a draft's configuration input (draft-inputs.ts). A module the command line had loaded already is grizzle's or a
 * package's, which other inputs name, so what the import loads anew is every module of the configuration's own.
 */
export const configAt = (
	file: string
): Effect.Effect<ConfigFile, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (!(yield* Effect.mapError(fs.exists(file), unloaded(file)))) {
			return yield* cliError(new ConfigMissing({ file }))
		}
		const url = (yield* Effect.mapError(path.toFileUrl(file), unloaded(file))).href
		const closure: Array<string> = []
		const recording = { on: true }
		yield* Effect.sync(() =>
			registerHooks({
				resolve: (specifier, context, nextResolve) =>
					specifier === "grizzle:config" && context.parentURL === import.meta.url
						? { url, shortCircuit: true }
						: nextResolve(specifier, context),
				load: (loadedUrl, context, nextLoad) => {
					if (recording.on && Str.startsWith("file:")(loadedUrl)) {
						closure.push(fileURLToPath(loadedUrl))
					}
					return nextLoad(loadedUrl, context)
				}
			})
		)
		const module: unknown = yield* Effect.tryPromise({
			try: () => import("grizzle:config"),
			catch: unloaded(file)
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					recording.on = false
				})
			)
		)
		if (typeof module !== "object" || module === null || !("default" in module)) {
			return yield* cliError(new ExportRefused({ file, fault: "missing" }))
		}
		const loaded: ConfigFile = { file, value: module.default, closure }
		return loaded
	})

/**
 * The microseconds of a second, the unit of Node's process.cpuUsage()
 * (https://nodejs.org/docs/v26.13.0/api/process.html#processcpuusagepreviousvalue: "values are in microsecond
 * values").
 *
 * @formatConstant Node's process.cpuUsage(): microseconds
 */
const microsPerSecond = 1_000_000

/**
 * The process's phase meter, for `--phases` (phases.ts): each reading the seconds since the process started, its user
 * and system CPU seconds and its memory (process.memoryUsage()), and each line written to stderr at once, which on Linux
 * is synchronous for a file, a pipe and a terminal alike, so a run that dies after a boundary has written its line.
 */
export const processMeter: PhaseMeter = {
	read: () => {
		const cpu = process.cpuUsage()
		const memory = process.memoryUsage()
		return {
			seconds: process.uptime(),
			cpuSeconds: (cpu.user + cpu.system) / microsPerSecond,
			heapUsed: memory.heapUsed,
			heapTotal: memory.heapTotal,
			rss: memory.rss,
			external: memory.external
		}
	},
	write: (line) => {
		process.stderr.write(`${line}\n`)
	}
}

/**
 * The grizzle CLI: `grizzle generate`, `grizzle check`, `grizzle migrate`, `grizzle drift`, `grizzle names`, `grizzle
 * roles` and `grizzle uninstall`, each over
 * the configuration file its command line names.
 *
 * The command line runs in the current directory, against which a relative configuration file resolves, on the
 * real clock and its output (run.ts), and sets the exit status its report carries. SIGINT interrupts the command, so a
 * migrate closes its connection and its open file transaction rolls back; the runtime then exits 130.
 */
const main = Effect.gen(function* () {
	const argv = yield* Effect.sync(() => process.argv.slice(argumentsStart))
	const cwd = yield* Effect.sync(() => process.cwd())
	const report = yield* runCli(argv, cwd, process.version, configAt, processMeter)
	yield* written(Console.log, report.stdout)
	yield* written(Console.error, report.stderr)
	yield* Effect.sync(() => {
		process.exitCode = report.code
	})
}).pipe(Effect.onInterrupt(() => Console.error("grizzle: interrupted")))

/**
 * Runs the command line as the program Node runs, and sets its exit status: the bin's one call (bin.ts), only as the
 * program Node runs, so a module that imports the bin (the dependency audit loads every entry point) runs nothing.
 */
export const runCommand = (): void =>
	NodeRuntime.runMain(Effect.provide(main, NodeServices.layer), { disableErrorReporting: true })

/**
 * This module run as the program, where the bin (bin.ts) is the command line's one entry point: it runs nothing and
 * exits 2, a usage error, naming the bin, since a run of it would otherwise define the command line and exit 0 having
 * done nothing, which a script reads as a command that succeeded.
 */
const refuseAsProgram = (): void => {
	process.stderr.write("grizzle: run src/cli/bin.ts (the package bin), not main.ts\n")
	process.exitCode = 2
}

if (import.meta.main) {
	refuseAsProgram()
}
