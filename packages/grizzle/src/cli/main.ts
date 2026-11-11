#!/usr/bin/env -S node --disable-proto=delete --disable-sigusr1
import { registerHooks } from "node:module"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Array as Arr, Console, Effect, FileSystem, Path } from "effect"
import type { ConfigFile } from "#cli/config.ts"
import {
	type CliError,
	ConfigMissing,
	ConfigUnloaded,
	cliError,
	ExportRefused,
	thrownOf
} from "#cli/errors.ts"
import { runCli } from "#cli/run.ts"

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
 * It lies outside grizzle's sources, so the bin imports it by one fixed specifier, `grizzle:config`, which a module
 * resolve hook maps to its file: every import in src/ keeps a literal specifier, the dependency audit's condition for
 * knowing src/'s whole import graph (test/unit/deps), and the application's configuration is an external module of
 * that graph, as `effect` is. A process runs one command line, so the hook answers that specifier with one file, and
 * only a command that reads the configuration imports it.
 */
const configAt = (
	file: string
): Effect.Effect<ConfigFile, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (!(yield* Effect.mapError(fs.exists(file), unloaded(file)))) {
			return yield* cliError(new ConfigMissing({ file }))
		}
		const url = (yield* Effect.mapError(path.toFileUrl(file), unloaded(file))).href
		yield* Effect.sync(() =>
			registerHooks({
				resolve: (specifier, context, nextResolve) =>
					specifier === "grizzle:config" && context.parentURL === import.meta.url
						? { url, shortCircuit: true }
						: nextResolve(specifier, context)
			})
		)
		const module: unknown = yield* Effect.tryPromise({
			try: () => import("grizzle:config"),
			catch: unloaded(file)
		})
		if (typeof module !== "object" || module === null || !("default" in module)) {
			return yield* cliError(new ExportRefused({ file, fault: "missing" }))
		}
		const loaded: ConfigFile = { file, value: module.default }
		return loaded
	})

/**
 * Where the command line's own arguments begin in process.argv, after Node's executable and the program's entry point
 * (https://nodejs.org/docs/v26.13.0/api/process.html#processargv: "The first element will be process.execPath. [...] If
 * a program entry point was provided, the second element will be the absolute path to it. The remaining elements are
 * additional command-line arguments.").
 *
 * @formatConstant Node's process.argv: its executable, the program's entry point, then the arguments
 */
const argumentsStart = 2

/**
 * The grizzle CLI: `grizzle generate`, `grizzle check`, `grizzle migrate`, `grizzle drift`, `grizzle names`, `grizzle
 * roles` and `grizzle uninstall`, each over
 * the configuration file its command line names.
 *
 * The bin runs the command line in the current directory, against which a relative configuration file resolves, on the
 * real clock and its output (run.ts), and sets the exit status its report carries. SIGINT interrupts the command, so a
 * migrate closes its connection and its open file transaction rolls back; the runtime then exits 130. It runs only as
 * the program Node runs: a module that imports the bin (the dependency audit loads every entry point) runs nothing.
 */
const main = Effect.gen(function* () {
	const argv = yield* Effect.sync(() => process.argv.slice(argumentsStart))
	const cwd = yield* Effect.sync(() => process.cwd())
	const report = yield* runCli(argv, cwd, configAt)
	yield* written(Console.log, report.stdout)
	yield* written(Console.error, report.stderr)
	yield* Effect.sync(() => {
		process.exitCode = report.code
	})
}).pipe(Effect.onInterrupt(() => Console.error("grizzle: interrupted")))

if (import.meta.main) {
	NodeRuntime.runMain(Effect.provide(main, NodeServices.layer), { disableErrorReporting: true })
}
