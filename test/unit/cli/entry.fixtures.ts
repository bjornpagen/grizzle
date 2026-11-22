/** What the properties of entry.test.ts read: its space and the run of one entry point. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Order } from "effect"
import { hardenedNode, probedRun, run } from "#test/support/process.ts"

/** The command line's two modules a script may run: the bin, its entry point, and the module the bin loads. */
export type Entry = "bin.ts" | "main.ts"

/**
 * The command lines a case runs: none, the help, each command over a configuration file the directory does not hold,
 * which the command line refuses before it opens any connection, and a command it does not have.
 */
const commandLines: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> = [
	[],
	["--help"],
	["generate", "grizzle.config.ts"],
	["check", "grizzle.config.ts"],
	["migrate", "grizzle.config.ts"],
	["frobnicate"]
]

/** Each entry point over each command line. */
export const entryCaseGen: Gen<readonly [Entry, ReadonlyArray<string>]> = (source) =>
	[
		source.draw(element(["bin.ts", "main.ts"] as const)),
		source.draw(element(commandLines))
	] as const

/** What main.ts says, run as the program, before it exits 2. */
export const mainRefusal = "grizzle: run src/cli/bin.ts (the package bin), not main.ts\n"

/** `entry` of the checkout at `checkout` run under hardened Node over `argv`, in an empty directory of its own. */
export const runEntry = (checkout: string, entry: Entry, argv: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-entry-" })
			return yield* run(
				process.execPath,
				[...hardenedNode, `${checkout}/packages/grizzle/src/cli/${entry}`, ...argv],
				{ cwd, env: {} }
			)
		})
	)

/** What comes before a help flag: nothing, a command of the command line with its configuration file, or one it does
 * not have. */
const beforeHelp: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> = [
	[],
	["check", "grizzle.config.ts"],
	["frobnicate"]
]

/**
 * A command line that asks for the usage alone (cli/usage.ts helpAsked): none, or `--help` or `-h` alone or after a
 * command and its arguments.
 */
export const helpLineGen: Gen<ReadonlyArray<string>> = (source) =>
	source.draw(boolean)
		? [...source.draw(element(beforeHelp)), source.draw(element(["--help", "-h"] as const))]
		: []

/**
 * Every module the usage loads, by its path in the checkout, in code point order: the bin, the usage it answers alone,
 * and the engine's usage facade with the one module of constants it re-exports. Nothing of the command line (main.ts,
 * run.ts, args.ts) and nothing else of the engine.
 */
export const usageModules: ReadonlyArray<string> = Arr.sort(
	[
		"packages/engine/src/deploy/render/layout.ts",
		"packages/engine/src/plan/usage.ts",
		"packages/grizzle/src/cli/bin.ts",
		"packages/grizzle/src/cli/usage.ts"
	],
	Order.String
)

/**
 * The bin of the checkout at `checkout` run over `argv` as runEntry runs it, with test/support/load-probe.ts imported
 * before it (probedRun): its exit status, its stdout, its stderr but the probe's line, and the path in the checkout of
 * every file module it loaded, in code point order. A module it loads from outside the checkout, a dependency, fails
 * the case.
 */
export const probedBin = (checkout: string, argv: ReadonlyArray<string>) =>
	Effect.map(probedRun(checkout, "packages/grizzle/src/cli/bin.ts", argv), (ran) => {
		assert.deepEqual(ran.outside, [], "every module it loads is the checkout's")
		return ran
	})
