/** What the properties of entry.test.ts read: its space and the run of one entry point. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem } from "effect"
import { hardenedNode, run } from "#test/support/process.ts"

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
