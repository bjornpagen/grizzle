import { openApiDirectory, openApiPath } from "@bjornpagen/grizzle-openapi/openapi"
import { chunkBytes, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
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
import { readLaidOut } from "#adapter/boundary/laid-out.ts"
import { toResult } from "#adapter/engine.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import {
	type CliError,
	FileTooLarge,
	FolderExists,
	FolderUnwritten,
	cliError,
	ServedUnwritten,
	SnapshotUnwritten,
	TreeRefused,
	TreeUnread
} from "#cli/errors.ts"
import {
	isEntryOf,
	type LaidOutFile,
	laidOut,
	laidOutFiles,
	metaFileName,
	type MigrationFolder
} from "#compiler/plan/migration.ts"
import {
	manifestFileName,
	servedDirectory,
	servedPath,
	snapshotFileName,
	type SnapshotFiles
} from "#compiler/plan/serve.ts"

/**
 * The migrations directory on disk.
 *
 * Each declared schema has its own directory `<migrations>/<schema>/`, `<schema>` its PostgreSQL schema identifier,
 * holding the snapshot's two files, `snapshot.json` and `manifest.json`, one folder `<YYYYMMDDHHMMSS>_<name>/` per
 * migration, each with its `meta.json` and its `NN-<phase>.sql` files, and two directories of one `<login>.json` per
 * login of the configuration over the schema (loginFiles): `served/`, the login's workload compiled under the snapshot
 * (adapter/served/compile.ts), which its application serves, and `openapi/`, the login's OpenAPI document, read off
 * its served file (packages/openapi/src/openapi.ts). The command line owns this filesystem work; the compiler and the
 * apply runner only ever see texts, each as its chunks (grizzle-text TextChunks): a file is written a chunk at a time
 * (writeText) and read a block at a time (adapter/boundary/files.ts readText), and a login's file is held to the text
 * the compile gives by its bytes as they are read (matchesFile), never read whole, since one may be longer than any
 * string V8 builds.
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
	readonly folders: ReadonlyArray<FolderTexts>
	/**
	 * The path of each login's file of each kind (loginFiles), by its login's declared name, the stem of its name; none
	 * before generate wrote one. A file is read only where it is held to a text (adapter/boundary/files.ts matchesFile,
	 * readText), never whole.
	 */
	readonly logins: LoginPaths
}

/**
 * The files generate writes beside the snapshot, one per login, by kind: a login's served file (served/forms.ts
 * servedPath) and its OpenAPI document (packages/openapi/src/openapi.ts openApiPath), each in its own directory, each
 * refused there as the fault its kind names when that directory holds anything else.
 */
export const loginFiles = {
	served: { directory: servedDirectory, path: servedPath, stray: "strayServed" },
	openapi: { directory: openApiDirectory, path: openApiPath, stray: "strayDocument" }
} as const

/** A kind of file generate writes per login (loginFiles). */
export type LoginFileKind = keyof typeof loginFiles

/** The kinds of file generate writes per login, in the order it writes them. */
export const loginFileKinds: ReadonlyArray<LoginFileKind> = ["served", "openapi"]

/** Each kind's files' paths, by login (SchemaTree logins). */
export type LoginPaths = { readonly [K in LoginFileKind]: ReadonlyMap<string, string> }

/** A schema directory's per-login files before generate wrote any. */
export const noLoginPaths: LoginPaths = { served: new Map(), openapi: new Map() }

/** The extension of a login's file, after its login's declared name (loginFiles). */
const loginExtension = ".json"

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

/** The files a directory's entries lay out (adapter/boundary/files.ts laidOutFiles), or the refusal of a file whose
 * parts are no layout generate writes. */
const laidOutIn = (
	schema: string,
	directory: string,
	entries: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<LaidOutFile>, CliError> =>
	Effect.mapError(Effect.fromResult(toResult(laidOutFiles(entries))), (broken) =>
		strayIn(schema, { kind: "brokenParts", directory, file: broken.name })
	)

const readFolder = Effect.fnUntraced(function* (schema: string, directory: string, name: string) {
	const fs = yield* FileSystem.FileSystem
	const paths = yield* Path.Path
	const path = paths.join(directory, name)
	const entries = yield* visibleEntries(fs, path)
	const laid = yield* laidOutIn(schema, path, entries)
	/** The first entry of `file` that is not a file, none when each is. */
	const notAFile = (file: LaidOutFile) =>
		Effect.map(
			Effect.forEach(file.entries, (entry) => entryType(fs, paths.join(path, entry))),
			(types) => Arr.findFirst(file.entries, (_, i) => types[i] !== "File")
		)
	const meta = Arr.findFirst(laid, (f) => f.name === metaFileName)
	const metaStray = Option.isSome(meta) ? yield* notAFile(meta.value) : Option.none()
	if (Option.isNone(meta) || Option.isSome(metaStray)) {
		return yield* strayIn(schema, { kind: "noMeta", folder: path })
	}
	const files: Array<{ readonly name: string; readonly text: TextChunks }> = []
	for (const file of Arr.filter(laid, (f) => f.name !== metaFileName)) {
		const stray = yield* notAFile(file)
		if (Option.isSome(stray)) {
			return yield* strayIn(schema, { kind: "notAFile", folder: path, entry: stray.value })
		}
		const text = yield* readLaidOut(path, file)
		files.push({ name: file.name, text })
	}
	const metaText = yield* readLaidOut(path, meta.value)
	const folder: FolderTexts = { name, metaText, files }
	return folder
})

/**
 * Reads a schema's directory of one kind of login file (loginFiles): every entry a file named `<login>.json`, its path by
 * the login's declared name. Anything else is no file generate writes there, refused as the kind's stray fault.
 */
const readLoginFiles = Effect.fnUntraced(function* (
	schema: string,
	directory: string,
	kind: LoginFileKind
) {
	const fs = yield* FileSystem.FileSystem
	const paths = yield* Path.Path
	const files = new Map<string, string>()
	for (const entry of yield* visibleEntries(fs, directory)) {
		const file = paths.join(directory, entry)
		const login = Str.endsWith(loginExtension)(entry)
			? Str.slice(0, -loginExtension.length)(entry)
			: ""
		if (login.length === 0 || (yield* entryType(fs, file)) !== "File") {
			return yield* strayIn(schema, { kind: loginFiles[kind].stray, directory, entry })
		}
		files.set(login, file)
	}
	return files
})

/** The kind of login file a schema directory's entry `entry` holds the directory of, none for any other entry. */
const loginDirectoryKind = (entry: string): Option.Option<LoginFileKind> =>
	Arr.findFirst(loginFileKinds, (kind) => loginFiles[kind].directory === entry)

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
			const empty: SchemaTree = {
				directory,
				folders: [],
				snapshotFiles: Option.none(),
				logins: noLoginPaths
			}
			return empty
		}
		if ((yield* entryType(fs, directory)) !== "Directory") {
			return yield* strayIn(schema, { kind: "notDirectory", directory })
		}
		const snapshotTexts = new Map<string, TextChunks>()
		const folders: Array<FolderTexts> = []
		const logins: { -readonly [K in LoginFileKind]: ReadonlyMap<string, string> } = {
			...noLoginPaths
		}
		const entries = yield* visibleEntries(fs, directory)
		for (const file of yield* laidOutIn(schema, directory, entries)) {
			const types = yield* Effect.forEach(file.entries, (entry) =>
				entryType(fs, path.join(directory, entry))
			)
			const [entry] = file.entries
			const [type] = types
			if (
				(file.name === manifestFileName ||
					(file.name === snapshotFileName && file.entries.length === 1)) &&
				Arr.every(types, (t) => t === "File")
			) {
				const text = yield* readLaidOut(directory, file)
				snapshotTexts.set(file.name, text)
				continue
			}
			const loginKind = loginDirectoryKind(file.name)
			if (file.entries.length > 1 || entry === undefined || type !== "Directory") {
				return yield* strayIn(schema, { kind: "strayEntry", directory, entry: entry ?? file.name })
			}
			if (Option.isSome(loginKind)) {
				logins[loginKind.value] = yield* readLoginFiles(
					schema,
					path.join(directory, entry),
					loginKind.value
				)
				continue
			}
			const folder = yield* readFolder(schema, directory, entry)
			folders.push(folder)
		}
		const snapshot = snapshotTexts.get(snapshotFileName)
		const manifest = snapshotTexts.get(manifestFileName)
		if (snapshot === undefined && manifest === undefined) {
			const unsnapshotted: SchemaTree = {
				directory,
				folders,
				snapshotFiles: Option.none(),
				logins
			}
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
			snapshotFiles: Option.some({ snapshot, manifest }),
			logins
		}
		return tree
	},
	(effect, schema, directory) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new TreeUnread({ schema, directory, cause })))
		)
)

/**
 * `text` written to `path` a chunk at a time, each chunk UTF-8 encoded alone and written before the next is encoded
 * (grizzle-text chunkBytes), so the file's bytes are exactly the text's UTF-8 and no encoding of the whole text, nor the
 * text as one string, is ever built: a served file's rope flattened as it was written whole is what edullm's qti
 * generate ran out of heap on.
 */
export const writeText = (
	path: string,
	text: TextChunks
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const file = yield* fs.open(path, { flag: "w" })
			for (const bytes of chunkBytes(text)) {
				yield* file.writeAll(bytes)
			}
		})
	)

/** How many bytes a text's UTF-8 holds. */
const textBytes = (text: TextChunks): number =>
	Arr.reduce(text, 0, (bytes, chunk) => bytes + utf8Length(chunk))

/**
 * Succeeds where each file an application imports whole by its path (snapshot.json, a login's served file and OpenAPI
 * document), which generate lays out in no parts, is within `bound` bytes (deploy/render/parts.ts
 * generatedFileMaxBytes); else refuses the first that is not, by its path in the schema's directory, FileTooLarge,
 * before anything is written.
 */
export const unsplitWithin = (
	schema: string,
	files: ReadonlyArray<{ readonly file: string; readonly text: TextChunks }>,
	bound: number
): Effect.Effect<void, CliError> =>
	Effect.forEach(
		files,
		({ file, text }) => {
			const bytes = textBytes(text)
			return bytes > bound
				? Effect.fail(cliError(new FileTooLarge({ schema, file, bytes, bound })))
				: Effect.void
		},
		{ discard: true }
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
 * Writes a drafted folder into the schema's directory, whole or not at all, meta.json and each SQL file laid out within
 * `bound` bytes (`laidOut`); returns its path.
 */
export const writeFolder = Effect.fn("writeFolder")(
	function* (
		schema: string,
		directory: string,
		folder: MigrationFolder,
		bound: number
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
				for (const f of [{ name: metaFileName, text: folder.metaText }, ...folder.files]) {
					for (const part of laidOut(f.name, f.text, bound)) {
						yield* writeText(path.join(scratch, part.entry), part.text)
					}
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
 * Replaces the schema's manifest.json, laid out within `bound` bytes (`laidOut`), each of its entries by rename and then
 * every entry of the manifest it held before and no longer does removed, and then its snapshot.json, by rename; returns
 * the paths written. snapshot.json, which records the fingerprint over both, is replaced last, so an interrupted write
 * leaves the files of two snapshots, or parts of two manifests, whose seal does not hold or whose parts do not lay out
 * one file, and the next generate refuses them.
 */
export const writeSnapshotFiles = Effect.fn("writeSnapshotFiles")(
	function* (
		...[, directory, files, bound]: [
			schema: string,
			directory: string,
			files: SnapshotFiles,
			bound: number
		]
	): Effect.fn.Return<
		ReadonlyArray<string>,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* fs.makeDirectory(directory, { recursive: true })
		const parts = laidOut(manifestFileName, files.manifest, bound)
		const manifest = yield* Effect.forEach(parts, (part) =>
			writeAtomically(directory, part.entry, (scratch) => writeText(scratch, part.text))
		)
		const kept = new Set(Arr.map(parts, (p) => p.entry))
		for (const entry of yield* visibleEntries(fs, directory)) {
			if (isEntryOf(entry, manifestFileName) && !kept.has(entry)) {
				yield* fs.remove(path.join(directory, entry))
			}
		}
		const snapshot = yield* writeAtomically(directory, snapshotFileName, (scratch) =>
			writeText(scratch, files.snapshot)
		)
		return [...manifest, snapshot]
	},
	(effect, schema) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new SnapshotUnwritten({ schema, cause })))
		)
)

/** A login's file as generate writes it: its login's declared name and its text, as its chunks. */
export interface LoginText {
	readonly login: string
	readonly text: TextChunks
}

/**
 * Brings a schema's directory of one kind of login file (loginFiles) to what generate compiled: each file of `write`
 * written by rename, the directory made first when it writes one, then each file of a login in `remove` removed;
 * returns the paths written and removed.
 */
export const writeLoginFiles = Effect.fn("writeLoginFiles")(
	function* (
		...[, kind, directory, write, remove]: [
			schema: string,
			kind: LoginFileKind,
			directory: string,
			write: ReadonlyArray<LoginText>,
			remove: ReadonlyArray<string>
		]
	): Effect.fn.Return<
		{ readonly written: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> },
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const files = loginFiles[kind]
		if (write.length > 0) {
			yield* fs.makeDirectory(path.join(directory, files.directory), { recursive: true })
		}
		const written: Array<string> = []
		for (const file of write) {
			const target = yield* writeAtomically(directory, files.path(file.login), (scratch) =>
				writeText(scratch, file.text)
			)
			written.push(target)
		}
		const removed: Array<string> = []
		for (const login of remove) {
			const file = path.join(directory, files.path(login))
			yield* fs.remove(file)
			removed.push(file)
		}
		return { written, removed }
	},
	(effect, schema, kind) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new ServedUnwritten({ schema, kind, cause })))
		)
)
