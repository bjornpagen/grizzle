import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import { runDevtool } from "@bjornpagen/devtools/run"
import { Array as Arr, Console, Effect, FileSystem, Option, Path, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

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
 * The lines of a file above its first import, when the last of them closes a comment that stands directly over the
 * import: oxfmt's import sorting moves that comment with the import it is attached to, so a file's leading comment
 * would follow its first import away from the top once a renamed import sorts above it.
 */
const headerOf = (text: string): Option.Option<string> => {
	const lines = Str.split("\n")(text)
	return Option.flatMap(
		Arr.findFirstIndex(lines, (line) => Str.startsWith("import ")(line)),
		(first) => {
			const above = Arr.take(lines, first)
			return Option.as(
				Option.filter(Arr.last(above), (line) => {
					const trimmed = Str.trim(line)
					return Str.endsWith("*/")(trimmed) || Str.startsWith("//")(trimmed)
				}),
				`${Arr.join(above, "\n")}\n`
			)
		}
	)
}

/** A rewritten file, and its leading comment when one stood directly over its first import. */
type Rewritten = Readonly<{ file: string; header: Option.Option<string> }>

/** The repository's root, two directories above this script. */
const root = (path: Path.Path): string => path.resolve(import.meta.dirname, "../..")

/**
 * Spells the toolchain's package names in each file it is given (MOVED), then formats the TypeScript files it changed
 * with oxfmt, whose import sorting puts the renamed imports in their place. A leading comment over a file's first import
 * is held apart by a blank line while oxfmt sorts, so it stays at the top, and joined again after. A lane whose
 * in-flight edits meet the toolchain switch takes its own side of an import conflict, then runs it on the files it
 * changed:
 *
 *   node scripts/dev/toolchain-imports.ts <file>...
 *
 * A file already spelled with the toolchain's names is left as it is, so a second run changes nothing.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const given = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	if (!Arr.isReadonlyArrayNonEmpty(given)) {
		return yield* DevtoolFailure.make({
			detail: "Name the files to rewrite: node scripts/dev/toolchain-imports.ts <file>..."
		})
	}
	const files = Arr.map(given, (file) => path.resolve(file))
	const rewritten = yield* Effect.forEach(files, (file) =>
		Effect.gen(function* () {
			const text = yield* fs
				.readFileString(file)
				.pipe(Effect.mapError(failureFrom(`${file} could not be read`)))
			const next = renamed(text)
			if (next === text) {
				return Option.none<Rewritten>()
			}
			const header = Str.endsWith(".ts")(file) ? headerOf(next) : Option.none<string>()
			const written = Option.match(header, {
				onNone: () => next,
				onSome: (above) => `${above}\n${Str.slice(above.length)(next)}`
			})
			yield* fs
				.writeFileString(file, written)
				.pipe(Effect.mapError(failureFrom(`${file} could not be written`)))
			return Option.some({ file, header })
		})
	)
	const changed = Arr.getSomes(rewritten)
	const formatted = Arr.filter(changed, ({ file }) => Str.endsWith(".ts")(file))
	if (Arr.isReadonlyArrayNonEmpty(formatted)) {
		const status = yield* spawner
			.exitCode(
				ChildProcess.make(
					path.join(root(path), "node_modules/.bin/oxfmt"),
					Arr.map(formatted, ({ file }) => file),
					{ cwd: root(path), stdout: "inherit", stderr: "inherit" }
				)
			)
			.pipe(Effect.mapError(failureFrom("oxfmt could not be run")))
		if (status !== 0) {
			return yield* DevtoolFailure.make({
				detail: `oxfmt exited ${status} on the ${formatted.length} rewritten TypeScript files`
			})
		}
	}
	yield* Effect.forEach(
		formatted,
		({ file, header }) =>
			Effect.forEach(
				Option.toArray(header),
				(above) =>
					Effect.gen(function* () {
						const text = yield* fs
							.readFileString(file)
							.pipe(Effect.mapError(failureFrom(`${file} could not be read`)))
						if (!Str.startsWith(`${above}\n`)(text)) {
							return yield* DevtoolFailure.make({
								detail: `${file}: oxfmt moved its leading comment, so it is left as oxfmt wrote it`
							})
						}
						yield* fs
							.writeFileString(file, `${above}${Str.slice(above.length + 1)(text)}`)
							.pipe(Effect.mapError(failureFrom(`${file} could not be written`)))
					}),
				{ discard: true }
			),
		{ discard: true }
	)
	yield* Console.log(`${changed.length} of ${files.length} files now name the toolchain's packages`)
	return 0
})

runDevtool(main)
