import { homedir } from "node:os"
import { failureFrom } from "@bjornpagen/devtools/devtool"
import {
	Array as Arr,
	Config,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	String as Str
} from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"

/**
 * A verdict a plant run keeps: what a test that passes with no plant did while the plant was planted. An unjudged test
 * judges nothing, and a plant that does not apply is refused by the check, so only these two are kept.
 */
export type Kept = "red" | "green"

/** A path's content as git hashes it: its blob, or absent where the tree has no such file (a file a plant creates). */
export type Blob = Readonly<{ kind: "blob"; id: string }> | Readonly<{ kind: "absent" }>

/** A path and its content. */
export type Held = readonly [path: string, blob: Blob]

/**
 * All a verdict on a citation depends on: the plant's patch, the test that cites it, and each file the patch changes,
 * each with its content.
 */
export interface Content {
	readonly plant: Held
	readonly test: Held
	readonly files: ReadonlyArray<Held>
}

/** One line of a key's text: the role, the path and the blob. */
const lineOf = (role: string, [path, blob]: Held): string =>
	`${role} ${path} ${blob.kind === "blob" ? blob.id : "absent"}`

/**
 * A citation's key: the SHA-256 of its content, spelled one way, a line for the plant, the test and each changed file in
 * path order. Two citations share a key exactly when they hold the same content, so a verdict kept under a key is the
 * verdict of that content wherever it stands, in any clone or commit.
 */
export const keyOf = (content: Content): string =>
	sha256Hex(
		Arr.join(
			[
				lineOf("plant", content.plant),
				lineOf("test", content.test),
				...Arr.map(
					Arr.sort(
						content.files,
						Order.mapInput(Order.String, ([path]: Held) => path)
					),
					(held) => lineOf("file", held)
				)
			],
			"\n"
		)
	)

/**
 * Where kept verdicts live: one file a key under the user's cache, ${XDG_CACHE_HOME:-~/.cache}/grizzle/plants. A verdict
 * is a function of the content its key names, so it is kept like a build's cache: nothing to commit or merge, good in
 * any clone of the same content, and recomputed once if lost.
 */
export const verdictDirectory = Effect.gen(function* () {
	const path = yield* Path.Path
	const cache = yield* Config.String("XDG_CACHE_HOME").pipe(
		Config.withDefault(path.join(homedir(), ".cache"))
	)
	return path.join(cache, "grizzle", "plants")
}).pipe(Effect.mapError(failureFrom("XDG_CACHE_HOME could not be read")))

/** The verdict kept under `key` in `directory`, if any. */
export const keptAt = Effect.fn("keptAt")(function* (directory: string, key: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = path.join(directory, key)
	const exists = yield* fs
		.exists(file)
		.pipe(Effect.mapError(failureFrom(`${file} could not be read`)))
	if (!exists) {
		return Option.none<Kept>()
	}
	const read = yield* fs
		.readFileString(file)
		.pipe(Effect.mapError(failureFrom(`${file} could not be read`)))
	const text = Str.trim(read)
	return text === "red" || text === "green" ? Option.some<Kept>(text) : Option.none<Kept>()
})

/** Keeps `verdict` under `key` in `directory`. */
export const keep = Effect.fn("keep")(function* (directory: string, key: string, verdict: Kept) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs
		.makeDirectory(directory, { recursive: true })
		.pipe(Effect.mapError(failureFrom(`${directory} could not be made`)))
	const file = path.join(directory, key)
	yield* fs
		.writeFileString(file, `${verdict}\n`)
		.pipe(Effect.mapError(failureFrom(`${file} could not be written`)))
})
