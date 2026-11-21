import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Data, Effect, Option, Order, Record, Result } from "effect"
import { printJson } from "#emit/printer.ts"
import { isSha256Hex } from "#model/digest.ts"
import type { Sha256Hex } from "#model/digest.ts"
import { isArray, isJson, isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { parseJson } from "#runtime/json.ts"

/**
 * The manifest file the writer commits last in the output directory (design 3.6, Write).
 */
export const manifestFileName = ".openapi-cli-manifest.json"

/**
 * Why a previous manifest could not be read: `malformed` (not one JSON text of the manifest
 * shape) or `duplicate-path`. `subject` names the path involved, or the manifest file when no
 * path is.
 */
class ManifestError extends Data.TaggedError("ManifestError")<{
	readonly reason: "duplicate-path" | "malformed"
	readonly subject: string
}> {}

/**
 * One generated file: its path relative to the output directory, the sha256 of its bytes and
 * their count. The count bounds what a later run reads to judge the file: a file of another size
 * is not the one written, and is never read.
 */
export interface ManifestEntry {
	readonly path: string
	readonly sha256: Sha256Hex
	readonly size: number
}

const byPath = Order.mapInput(Order.String, (entry: ManifestEntry) => entry.path)

/**
 * Whether every member of an object is one of `names`: an unknown member refuses the object, and a missing one is
 * refused by the reader of its value.
 */
const holdsOnly = (object: JsonObject, names: ReadonlyArray<string>): boolean =>
	Arr.every(Record.keys(object), (name) => Arr.contains(names, name))

const entryMembers: ReadonlyArray<string> = ["path", "sha256", "size"]

/**
 * A manifest entry read from a JSON value: an object of exactly `path`, a non-empty string,
 * `sha256`, 64 lowercase hex digits, and `size`, a whole number of bytes.
 */
const entryOf = (value: Json): Option.Option<ManifestEntry> => {
	if (!isObject(value) || !holdsOnly(value, entryMembers)) {
		return Option.none()
	}

	const { path, sha256, size } = value

	return typeof path === "string" &&
		path !== "" &&
		typeof sha256 === "string" &&
		isSha256Hex(sha256) &&
		typeof size === "number" &&
		Number.isSafeInteger(size) &&
		size >= 0
		? Option.some({ path, sha256, size })
		: Option.none()
}

/** A manifest's entries read from a JSON value: an object of exactly `files`, a list of entries. */
const entriesOf = (value: Json): Option.Option<readonly ManifestEntry[]> =>
	isObject(value) && holdsOnly(value, ["files"])
		? Option.flatMap(Option.filter(Record.get(value, "files"), isArray), (files) =>
				Option.all(Arr.map(files, entryOf))
			)
		: Option.none()

/** The first path two neighbours of a sorted list share. */
const duplicatePath = (sorted: readonly ManifestEntry[]): Option.Option<string> =>
	Option.map(
		Arr.findFirst(
			Arr.zip(sorted, Arr.drop(sorted, 1)),
			([previous, entry]) => previous.path === entry.path
		),
		([, entry]) => entry.path
	)

/**
 * Prints the manifest in the `docs/printer.md` JSON layout: `{"files": [...]}` with entries sorted
 * by path (code-unit order), whatever the input order. The writer's own entries come in, each path
 * one the plan admitted once, so nothing here is refused.
 */
export const printManifest = (entries: readonly ManifestEntry[]): string =>
	printJson({
		files: Arr.map(Arr.sort(entries, byPath), (entry) => ({
			path: entry.path,
			sha256: entry.sha256,
			size: entry.size
		}))
	})

/**
 * Reads a previous manifest's text into entries sorted by path. Anything but `{"files": [{path,
 * sha256, size}]}` (an unknown member, an empty path, a bad sha256, a size that is no whole
 * number of bytes, a repeated path) fails. A path that leaves the output directory still reads:
 * the writer refuses it, not the reader.
 */
export const decodeManifest = (
	text: string
): Effect.Effect<readonly ManifestEntry[], ManifestError> =>
	Option.match(
		Option.flatMap(Option.filter(Result.getSuccess(parseJson(text)), isJson), entriesOf),
		{
			onNone: () =>
				Effect.fail(new ManifestError({ reason: "malformed", subject: manifestFileName })),
			onSome: (entries) => {
				const sorted = Arr.sort(entries, byPath)

				return Option.match(duplicatePath(sorted), {
					onNone: () => Effect.succeed(sorted),
					onSome: (subject) => Effect.fail(new ManifestError({ reason: "duplicate-path", subject }))
				})
			}
		}
	)
