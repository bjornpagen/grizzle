import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	String as Str
} from "effect"
import type { FolderSource } from "#adapter/migrate/input.ts"
import {
	type CliError,
	FolderExists,
	FolderUnwritten,
	cliError,
	SnapshotUnwritten,
	TreeRefused,
	TreeUnread
} from "#cli/errors.ts"
import {
	manifestFileName,
	metaFileName,
	type MigrationFolder,
	type SnapshotFiles,
	snapshotFileName
} from "#compiler/plan/migration.ts"

/**
 * The migrations directory on disk.
 *
 * Each declared schema has its own directory `<migrations>/<schema>/`, `<schema>` its PostgreSQL schema identifier,
 * holding the snapshot's two files, `snapshot.json` and `manifest.json`, and one folder `<YYYYMMDDHHMMSS>_<name>/` per
 * migration, each with its `meta.json` and its `NN-<phase>.sql` files. The command line owns this filesystem work; the
 * compiler and the apply runner only ever see texts.
 *
 * Reading is strict, because a draft continues exactly the committed chain: a schema directory holds the snapshot's two
 * files, both or neither, and migration folders, a folder holds meta.json and its SQL files, and anything else is
 * refused, except hidden entries (a leading dot), which no generator writes and an editor or the operating system may
 * leave. Writing is atomic per entry: a folder is written whole into a hidden scratch directory beside it and renamed
 * into place, then manifest.json and snapshot.json are each replaced by rename, so an interrupted generate leaves
 * either nothing or a complete folder; a complete folder without its snapshot, or the files of two snapshots, are the
 * inconsistencies left, and the next generate refuses them: the newest folder's target is not snapshot.json's
 * fingerprint (generate.ts), or the files' fingerprint does not hold (boundary/snapshot.ts readSnapshot).
 */
export interface SchemaTree {
	readonly directory: string
	/**
	 * The texts of snapshot.json and manifest.json, or none before the schema's first drafted migration: the empty
	 * snapshot is no file.
	 */
	readonly snapshotFiles: Option.Option<SnapshotFiles>
	/** Every migration folder, in name order. */
	readonly folders: ReadonlyArray<FolderSource>
}

/** The refusal of a schema's migrations directory that holds what no generator writes. */
const strayIn = (schema: string, fault: TreeRefused["fault"]): CliError =>
	cliError(new TreeRefused({ schema, fault }))

const visible = (name: string): boolean => !Str.startsWith(".")(name)

/** The entries of a directory a generator may have written, every hidden one left out, in code-unit order. */
const visibleEntries = (
	fs: FileSystem.FileSystem,
	directory: string
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
	Effect.map(fs.readDirectory(directory), (names) =>
		Arr.sort(Arr.filter(names, visible), Order.String)
	)

const entryType = (
	fs: FileSystem.FileSystem,
	path: string
): Effect.Effect<FileSystem.File.Type, PlatformError.PlatformError> =>
	Effect.map(fs.stat(path), (info) => info.type)

const readFolder = Effect.fnUntraced(function* (schema: string, directory: string, name: string) {
	const fs = yield* FileSystem.FileSystem
	const paths = yield* Path.Path
	const path = paths.join(directory, name)
	const entries = yield* visibleEntries(fs, path)
	const join = (entry: string) => paths.join(path, entry)
	const metaPresent =
		Arr.contains(entries, metaFileName) && (yield* entryType(fs, join(metaFileName))) === "File"
	if (!metaPresent) {
		return yield* strayIn(schema, { kind: "noMeta", folder: path })
	}
	const files: Array<{ readonly name: string; readonly text: string }> = []
	for (const entry of Arr.filter(entries, (e) => e !== metaFileName)) {
		if ((yield* entryType(fs, join(entry))) !== "File") {
			return yield* strayIn(schema, { kind: "notAFile", folder: path, entry })
		}
		files.push({ name: entry, text: yield* fs.readFileString(join(entry)) })
	}
	const folder: FolderSource = {
		name,
		metaText: yield* fs.readFileString(join(metaFileName)),
		files
	}
	return folder
})

/**
 * Reads one schema's directory; a missing directory is a schema with no migration yet.
 */
export const readSchemaTree = Effect.fn("readSchemaTree")(
	function* (
		schema: string,
		directory: string
	): Effect.fn.Return<
		SchemaTree,
		CliError | PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (!(yield* fs.exists(directory))) {
			const empty: SchemaTree = { directory, folders: [], snapshotFiles: Option.none() }
			return empty
		}
		if ((yield* entryType(fs, directory)) !== "Directory") {
			return yield* strayIn(schema, { kind: "notDirectory", directory })
		}
		const snapshotTexts = new Map<string, string>()
		const folders: Array<FolderSource> = []
		for (const entry of yield* visibleEntries(fs, directory)) {
			const type = yield* entryType(fs, path.join(directory, entry))
			if ((entry === snapshotFileName || entry === manifestFileName) && type === "File") {
				const text = yield* fs.readFileString(path.join(directory, entry))
				snapshotTexts.set(entry, text)
				continue
			}
			if (type !== "Directory") {
				return yield* strayIn(schema, { kind: "strayEntry", directory, entry })
			}
			const folder = yield* readFolder(schema, directory, entry)
			folders.push(folder)
		}
		const snapshot = snapshotTexts.get(snapshotFileName)
		const manifest = snapshotTexts.get(manifestFileName)
		if (snapshot === undefined && manifest === undefined) {
			const unsnapshotted: SchemaTree = { directory, folders, snapshotFiles: Option.none() }
			return unsnapshotted
		}
		if (snapshot === undefined || manifest === undefined) {
			return yield* strayIn(schema, {
				kind: "halfSnapshot",
				directory,
				present: snapshot === undefined ? manifestFileName : snapshotFileName,
				missing: snapshot === undefined ? snapshotFileName : manifestFileName
			})
		}
		const tree: SchemaTree = {
			directory,
			folders,
			snapshotFiles: Option.some({ snapshot, manifest })
		}
		return tree
	},
	(effect, schema, directory) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new TreeUnread({ schema, directory, cause })))
		)
)

/**
 * Writes `final` by way of a hidden scratch path beside it: whatever was left at the scratch path is removed, `write`
 * fills it, and it is renamed into place; if anything fails or is interrupted before the rename, the scratch path is
 * removed again, so `final` is written whole or not at all. The scratch path is named after the process alone, never
 * after `final`, so a folder whose name is the longest file name (folder.ts fileNameMaxBytes) has a scratch path the
 * file system takes; a process writes one entry of a directory at a time.
 */
const writeAtomically = Effect.fn("writeAtomically")(function* <R>(
	directory: string,
	final: string,
	write: (scratch: string) => Effect.Effect<void, PlatformError.PlatformError, R>
): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | R> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = path.join(directory, final)
	const scratch = path.join(directory, `.partial-${process.pid}`)
	const clear = fs.remove(scratch, { recursive: true, force: true })
	yield* clear
	yield* write(scratch).pipe(
		Effect.andThen(fs.rename(scratch, target)),
		Effect.onError(() => Effect.ignore(clear))
	)
	return target
})

/**
 * Writes a drafted folder into the schema's directory, whole or not at all; returns its path.
 */
export const writeFolder = Effect.fn("writeFolder")(
	function* (
		schema: string,
		directory: string,
		folder: MigrationFolder
	): Effect.fn.Return<
		string,
		CliError | PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* fs.makeDirectory(directory, { recursive: true })
		const final = path.join(directory, folder.name)
		if (yield* fs.exists(final)) {
			return yield* cliError(new FolderExists({ schema, path: final }))
		}
		return yield* writeAtomically(directory, folder.name, (scratch) =>
			Effect.gen(function* () {
				yield* fs.makeDirectory(scratch)
				yield* fs.writeFileString(path.join(scratch, metaFileName), folder.metaText)
				for (const f of folder.files) {
					yield* fs.writeFileString(path.join(scratch, f.name), f.text)
				}
			})
		)
	},
	(effect, schema, ...[, folder]) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new FolderUnwritten({ schema, folder: folder.name, cause })))
		)
)

/**
 * Replaces the schema's manifest.json and then its snapshot.json, each by rename; returns their paths. snapshot.json,
 * which records the fingerprint over both, is replaced last, so an interrupted write leaves the files of two snapshots,
 * whose fingerprint does not hold, and the next generate refuses them.
 */
export const writeSnapshotFiles = Effect.fn("writeSnapshotFiles")(
	function* (
		...[, directory, files]: [schema: string, directory: string, files: SnapshotFiles]
	): Effect.fn.Return<
		ReadonlyArray<string>,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		yield* fs.makeDirectory(directory, { recursive: true })
		const manifest = yield* writeAtomically(directory, manifestFileName, (scratch) =>
			fs.writeFileString(scratch, files.manifest)
		)
		const snapshot = yield* writeAtomically(directory, snapshotFileName, (scratch) =>
			fs.writeFileString(scratch, files.snapshot)
		)
		return [manifest, snapshot]
	},
	(effect, schema) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new SnapshotUnwritten({ schema, cause })))
		)
)
