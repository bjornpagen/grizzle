import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import { runDevtool } from "@bjornpagen/devtools/run"
import { Array as Arr, Console, Effect, FileSystem, Path, String as Str } from "effect"

/**
 * The packages that left grizzle for the toolchain (vendor/toolchain): each keeps its name and changes its scope, from
 * grizzle's to the toolchain's.
 */
const MOVED: ReadonlyArray<string> = ["testing", "devtools"]

/** `text` with every moved package spelled under the toolchain's scope. */
const renamed = (text: string): string =>
	Arr.reduce(MOVED, text, (current, name) =>
		Str.replaceAll(`@grizzle/${name}`, `@bjornpagen/${name}`)(current)
	)

/**
 * Spells the toolchain's package names in each file it is given (MOVED), and changes nothing else: every other byte of
 * the file stays as it was. Formatting is the file's owner's: its repository's formatter, under that repository's own
 * configuration, puts the renamed imports in their sorted place (`oxfmt <file>...` in grizzle). A lane whose in-flight
 * edits meet the toolchain switch takes its own side of an import conflict, then runs it on the files it changed:
 *
 *   node scripts/dev/toolchain-imports.ts <file>...
 *
 * A file already spelled with the toolchain's names is left as it is, so a second run changes nothing.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const given = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	if (!Arr.isReadonlyArrayNonEmpty(given)) {
		return yield* DevtoolFailure.make({
			detail: "Name the files to rewrite: node scripts/dev/toolchain-imports.ts <file>..."
		})
	}
	const files = Arr.map(given, (file) => path.resolve(file))
	const changed = yield* Effect.filter(files, (file) =>
		Effect.gen(function* () {
			const text = yield* fs
				.readFileString(file)
				.pipe(Effect.mapError(failureFrom(`${file} could not be read`)))
			const next = renamed(text)
			if (next === text) {
				return false
			}
			yield* fs
				.writeFileString(file, next)
				.pipe(Effect.mapError(failureFrom(`${file} could not be written`)))
			return true
		})
	)
	yield* Console.log(`${changed.length} of ${files.length} files now name the toolchain's packages`)
	return 0
})

runDevtool(main)
