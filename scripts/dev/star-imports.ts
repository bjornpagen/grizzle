#!/usr/bin/env -S node

import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import { PLUGIN_MODULE } from "@bjornpagen/devtools/preset"
import { runDevtool } from "@bjornpagen/devtools/run"
import { regex } from "arkregex"
import { Array as Arr, Console, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { jsonText } from "#compiler/core/trusted.ts"

/**
 * The codemod that brings a repository's code to grizzle's star imports and PostgreSQL's names, in two passes of the
 * repository's own oxlint with --fix over the paths it is given:
 *
 * 1. the dev tools' grizzle-star-imports rule (`@bjornpagen/devtools`, the repository's own), whose fix makes each module's
 *    imports of a grizzle entry one namespace import under the entry's name, `import * as g from "@bjornpagen/grizzle"`,
 *    `import * as gRuntime from "@bjornpagen/grizzle/runtime"` (`import type * as …` where every name was a type), and
 *    reads each use of an imported name off it, `x` becoming `g.x`;
 * 2. the rule beside this script (star-imports-plugin.ts), which renames each name read off a namespace to the one it
 *    has: PostgreSQL's plain types by their pg_type names (`g.pg.integer` is `g.int4`, `g.pg["double precision"]`
 *    `g.float8`), bytea, range, bit, Range, Bit and Numeric, Text.parseFloat8 and Text.parseNumeric, and every SQL tag
 *    among a namespace type's arguments by its typname (`g.Term<D, unknown, O, "bigint">` is `"int8"`).
 *
 * A module whose name for an entry is taken, a re-export of an entry and a read of the old pg namespace that names no
 * member of it are reported and left as they are, for their authors. From the repository's root, after moving
 * vendor/grizzle and vendor/toolchain to the pin:
 *
 *   pnpm exec node vendor/grizzle/scripts/dev/star-imports.ts <paths…>
 *
 * then the typecheck, which names whatever the two passes left, and the formatter on the files it changed. A vendored
 * repository is no path's: each is its own repository's to run this over.
 */

/** Every built-in category off, so each pass runs its one rule. */
const NO_CATEGORIES = {
	correctness: "off",
	nursery: "off",
	pedantic: "off",
	perf: "off",
	restriction: "off",
	style: "off",
	suspicious: "off"
} as const

/** oxlint's count of what a run reported: `Found <w> warnings and <e> errors.` */
const FOUND = regex("Found (\\d+) warnings? and (\\d+) errors?", "u")

/** How many diagnostics a run of oxlint reported, every one an error under the passes' configurations. */
const reportsOf = (output: string): number => {
	const found = FOUND.exec(output)
	return found === null ? 0 : Number(found[2])
}

/** A command's standard output and its exit status. */
const outputOf = Effect.fn("outputOf")(function* (command: string, args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [output, status] = yield* Effect.scoped(
		Effect.flatMap(spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore" })), (handle) =>
			Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
				concurrency: "unbounded"
			})
		)
	).pipe(Effect.mapError(failureFrom(`${command} could not be run`)))
	return { output, status: Number(status) }
})

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const paths = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	if (!Arr.isReadonlyArrayNonEmpty(paths)) {
		return yield* DevtoolFailure.make({
			detail:
				"Name the paths to rewrite: pnpm exec node vendor/grizzle/scripts/dev/star-imports.ts <paths…>"
		})
	}
	const scratch = yield* fs
		.makeTempDirectoryScoped({ prefix: "star-imports-" })
		.pipe(Effect.mapError(failureFrom("a scratch directory could not be made")))
	const pass = Effect.fn("pass")(function* (name: string, plugin: string, rule: string) {
		const config = path.join(scratch, `${name}.oxlintrc.json`)
		yield* fs
			.writeFileString(
				config,
				jsonText({
					plugins: [],
					categories: NO_CATEGORIES,
					jsPlugins: [plugin],
					ignorePatterns: ["**/vendor/**"],
					rules: { [rule]: "error" }
				})
			)
			.pipe(Effect.mapError(failureFrom(`${config} could not be written`)))
		return yield* outputOf("oxlint", ["-c", config, "--fix", ...paths])
	})
	/**
	 * The imports pass runs again until a run fixes nothing more: where two fixes of a module overlap oxlint applies one
	 * per run, and the fix of each entry a module imports spans the module, from its first import to its last use, so a
	 * module importing k entries is done in k runs and the run after them reports what is left.
	 */
	let left = Number.POSITIVE_INFINITY
	let last = ""
	for (;;) {
		last = (yield* pass("imports", PLUGIN_MODULE, "devtools/grizzle-star-imports")).output
		if (reportsOf(last) >= left) {
			break
		}
		left = reportsOf(last)
	}
	yield* Console.log(last)
	const names = path.join(import.meta.dirname, "star-imports-plugin.ts")
	yield* Console.log((yield* pass("names", names, "grizzle-names/rename")).output)
	yield* Console.log(
		"star-imports: imports and names rewritten where they could be, and the rest reported above; run the typecheck, then the formatter on the files changed"
	)
	return 0
})

runDevtool(Effect.scoped(main))
