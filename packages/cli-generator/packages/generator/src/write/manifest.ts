import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Schema } from "effect"
import { printJson } from "#emit/printer.ts"
import { JsonLiteral } from "#model/brands.ts"

/**
 * The manifest file the writer commits last in the output directory (design 3.6, Write).
 */
export const manifestFileName = ".openapi-cli-manifest.json"

/**
 * Why a manifest could not be printed or read: `malformed` (not the manifest shape),
 * `duplicate-path` or `unprintable` (a value `printJson` cannot take). `subject` names the path
 * involved, or the manifest file when no path is.
 */
export class ManifestError extends Schema.TaggedError<
	ManifestError,
	{ readonly brand: unique symbol }
>()("ManifestError", {
	reason: Schema.Literals(["duplicate-path", "malformed", "unprintable"]),
	subject: Schema.String
}) {}

const ManifestEntrySchema = Schema.Struct({
	path: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
	sha256: Schema.String.pipe(Schema.check(Schema.isPattern(regex("^[0-9a-f]{64}$", "u")))),
	size: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
})

const ManifestFile = Schema.Struct({ files: Schema.Array(ManifestEntrySchema) })

/**
 * One generated file: its path relative to the output directory, the sha256 of its bytes and
 * their count. The count bounds what a later run reads to judge the file: a file of another size
 * is not the one written, and is never read.
 */
export type ManifestEntry = (typeof ManifestEntrySchema)["Type"]

const strict = { onExcessProperty: "error" } as const

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestFile))

const encodeJson = Schema.decodeUnknownEffect(JsonLiteral)

const byPath = Order.mapInput(Order.String, (entry: ManifestEntry) => entry.path)

/** The first path two neighbours of a sorted list share. */
const duplicatePath = (sorted: readonly ManifestEntry[]): Option.Option<string> =>
	Option.map(
		Arr.findFirst(
			Arr.zip(sorted, Arr.drop(sorted, 1)),
			([previous, entry]) => previous.path === entry.path
		),
		([, entry]) => entry.path
	)

const sortedUnique = (
	entries: readonly ManifestEntry[]
): Effect.Effect<readonly ManifestEntry[], ManifestError> => {
	const sorted = Arr.sort(entries, byPath)

	return Option.match(duplicatePath(sorted), {
		onNone: () => Effect.succeed(sorted),
		onSome: (subject) => Effect.fail(ManifestError.make({ reason: "duplicate-path", subject }))
	})
}

/**
 * Prints the manifest in the `docs/printer.md` JSON layout: `{"files": [...]}` with entries sorted
 * by path (code-unit order), whatever the input order. A repeated path or a sha256 that is not 64
 * lowercase hex digits fails.
 */
export const printManifest = (
	entries: readonly ManifestEntry[]
): Effect.Effect<string, ManifestError> =>
	Schema.decodeEffect(Schema.Array(ManifestEntrySchema))(entries).pipe(
		Effect.mapError(() => ManifestError.make({ reason: "malformed", subject: manifestFileName })),
		Effect.flatMap(sortedUnique),
		Effect.flatMap((sorted) =>
			encodeJson({ files: sorted }).pipe(
				Effect.mapError(() =>
					ManifestError.make({ reason: "unprintable", subject: manifestFileName })
				)
			)
		),
		Effect.map(printJson)
	)

/**
 * Reads a previous manifest's text into entries sorted by path. Anything but `{"files": [{path,
 * sha256}]}` (an unknown member, an empty path, a bad sha256, a repeated path) fails. A path that
 * leaves the output directory still decodes: the writer refuses it, not the codec.
 */
export const decodeManifest = (
	text: string
): Effect.Effect<readonly ManifestEntry[], ManifestError> =>
	decodeFile(text, strict).pipe(
		Effect.mapError(() => ManifestError.make({ reason: "malformed", subject: manifestFileName })),
		Effect.flatMap((file) => sortedUnique(file.files))
	)
