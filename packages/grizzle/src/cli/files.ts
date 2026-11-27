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
	type Scope,
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
 * leave. Writing is staged, then atomic per entry: each file is written into the process's hidden staging entry of the
 * schema's directory as its text is made (Staging), so no text is held past its write, and once every selected schema
 * has drafted, a folder is renamed into place whole, then manifest.json and snapshot.json are each replaced by rename,
 * so an interrupted generate leaves either nothing or a complete folder; a complete folder without its snapshot, or the
 * files of two snapshots, are the inconsistencies left, and the next generate refuses them: the newest folder's target
 * is not snapshot.json's fingerprint (generate.ts), or the files' fingerprint does not hold (boundary/snapshot.ts
 * readSnapshot).
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

/**
 * The entries of a directory a generator may have written, every hidden one left out, in code-unit order: the one
 * listing every command reads of a migrations directory, so an entry whose name starts with `.` (an editor's, an
 * interrupted write's scratch) is never an input of a draft.
 */
export const visibleEntries = (
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
 * The hidden entry of a schema's directory a process of id `pid` stages its files in (Staging): hidden, so no command
 * reads it as an entry of its directory (visibleEntries), and the process's own, which the scope that made it removes.
 */
export const scratchName = (pid: number): string => `.partial-${pid}`

/**
 * Where a run writes one schema's files as their texts are made, so that no text outlives its write and none is in
 * place before every selected schema has drafted: the process's hidden entry of the schema's directory (scratchName),
 * holding each staged file at the path it takes in the directory (a folder, manifest.json's parts, snapshot.json,
 * `served/<login>.json`, `openapi/<login>.json`) until the commit renames it into place (commitFolder,
 * commitSnapshotFiles, commitLoginFiles), each entry by one rename, as atomic as a rename is. The area is its scope's
 * (stagingArea): what is left of it as the scope closes is removed, and so is each directory above it that the run
 * made and that holds nothing then, so a run refused before its commit leaves the migrations directory as it found it.
 */
export interface Staging {
	/** The schema's directory, which the commit renames each staged file into. */
	readonly directory: string
	/** The hidden entry of `directory` each file is staged in. */
	readonly scratch: string
}

/**
 * The staging area of the schema whose directory is `directory`, in the migrations directory `migrations` (Staging), the
 * scope's: whatever an earlier process of the same id left at its scratch entry is removed as it is made, and as the
 * scope closes the scratch entry is removed with what is left in it, then each directory from `directory` up to
 * `migrations` that did not exist as the area was made and holds nothing then, the deepest first. Making it reads no
 * path outside the migrations directory; the first file staged makes the directories.
 */
export const stagingArea = Effect.fn("stagingArea")(
	function* (
		...[, directory, migrations]: [schema: string, directory: string, migrations: string]
	): Effect.fn.Return<
		Staging,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path | Scope.Scope
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const scratch = path.join(directory, scratchName(process.pid))
		const made: Array<string> = []
		for (
			let at = directory;
			(at === migrations || Str.startsWith(`${migrations}/`)(at)) && !(yield* fs.exists(at));
			at = path.dirname(at)
		) {
			made.push(at)
		}
		const emptied = (at: string) =>
			Effect.flatMap(fs.exists(at), (exists) =>
				exists
					? Effect.flatMap(fs.readDirectory(at), (entries) =>
							entries.length === 0 ? fs.remove(at, { recursive: true }) : Effect.void
						)
					: Effect.void
			)
		const removed = fs.remove(scratch, { recursive: true, force: true })
		yield* Effect.addFinalizer(() =>
			Effect.ignore(Effect.andThen(removed, Effect.forEach(made, emptied, { discard: true })))
		)
		yield* removed
		return { directory, scratch }
	},
	(effect, schema, directory) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new TreeUnread({ schema, directory, cause })))
		)
)

export const writeAtomically = Effect.fn("writeAtomically")(function* <R>(
	directory: string,
	final: string,
	write: (scratch: string) => Effect.Effect<void, PlatformError.PlatformError, R>
): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | R> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = path.join(directory, final)
	const scratch = path.join(directory, scratchName(process.pid))
	const clear = fs.remove(scratch, { recursive: true, force: true })
	yield* clear
	yield* write(scratch).pipe(
		Effect.andThen(fs.rename(scratch, target)),
		Effect.onError(() => Effect.ignore(clear))
	)
	return target
})

/**
 * Stages a drafted folder (Staging), meta.json and each SQL file laid out within `bound` bytes (`laidOut`), each file
 * written as its text's chunks are encoded (writeText).
 */
export const stageFolder = Effect.fn("stageFolder")(
	function* (
		...[, staging, folder, bound]: [
			schema: string,
			staging: Staging,
			folder: MigrationFolder,
			bound: number
		]
	): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const staged = path.join(staging.scratch, folder.name)
		yield* fs.makeDirectory(staged, { recursive: true })
		for (const f of [{ name: metaFileName, text: folder.metaText }, ...folder.files]) {
			for (const part of laidOut(f.name, f.text, bound)) {
				yield* writeText(path.join(staged, part.entry), part.text)
			}
		}
	},
	(effect, schema, ...[, folder]) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new FolderUnwritten({ schema, folder: folder.name, cause })))
		)
)

/**
 * Puts the folder `name` the staging area holds (stageFolder) into the schema's directory by one rename, never over an
 * entry of its name: a migration folder is never overwritten (FolderExists); returns its path.
 */
export const commitFolder = Effect.fn("commitFolder")(
	function* (
		schema: string,
		staging: Staging,
		name: string
	): Effect.fn.Return<
		string,
		CliError | PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const final = path.join(staging.directory, name)
		if (yield* fs.exists(final)) {
			return yield* cliError(new FolderExists({ schema, path: final }))
		}
		yield* fs.rename(path.join(staging.scratch, name), final)
		return final
	},
	(effect, schema, ...[, name]) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new FolderUnwritten({ schema, folder: name, cause })))
		)
)

/**
 * Stages the schema's manifest.json, laid out within `bound` bytes (`laidOut`), and its snapshot.json (Staging);
 * returns the entries manifest.json is laid out in, which its commit puts in place (commitSnapshotFiles).
 */
export const stageSnapshotFiles = Effect.fn("stageSnapshotFiles")(
	function* (
		...[, staging, files, bound]: [
			schema: string,
			staging: Staging,
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
		yield* fs.makeDirectory(staging.scratch, { recursive: true })
		const parts = laidOut(manifestFileName, files.manifest, bound)
		for (const part of parts) {
			yield* writeText(path.join(staging.scratch, part.entry), part.text)
		}
		yield* writeText(path.join(staging.scratch, snapshotFileName), files.snapshot)
		return Arr.map(parts, (part) => part.entry)
	},
	(effect, schema) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new SnapshotUnwritten({ schema, cause })))
		)
)

/**
 * Replaces the schema's manifest.json by the entries `manifest` the staging area holds (stageSnapshotFiles), each by
 * rename, then removes every entry of the manifest the directory held before that it no longer does, and then replaces
 * its snapshot.json, by rename; returns the paths written. snapshot.json, which records the fingerprint over both, is
 * replaced last, so an interrupted commit leaves the files of two snapshots, or parts of two manifests, whose seal does
 * not hold or whose parts do not lay out one file, and the next generate refuses them.
 */
export const commitSnapshotFiles = Effect.fn("commitSnapshotFiles")(
	function* (
		...[, staging, manifest]: [schema: string, staging: Staging, manifest: ReadonlyArray<string>]
	): Effect.fn.Return<
		ReadonlyArray<string>,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const put = (entry: string) =>
			Effect.as(
				fs.rename(path.join(staging.scratch, entry), path.join(staging.directory, entry)),
				path.join(staging.directory, entry)
			)
		const written = yield* Effect.forEach(manifest, put)
		const kept = new Set(manifest)
		for (const entry of yield* visibleEntries(fs, staging.directory)) {
			if (isEntryOf(entry, manifestFileName) && !kept.has(entry)) {
				yield* fs.remove(path.join(staging.directory, entry))
			}
		}
		const snapshot = yield* put(snapshotFileName)
		return [...written, snapshot]
	},
	(effect, schema) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new SnapshotUnwritten({ schema, cause })))
		)
)

/** Stages a login's file of `kind` (loginFiles), its text written as its chunks are encoded (writeText). */
export const stageLoginFile = Effect.fn("stageLoginFile")(
	function* (
		...[, kind, staging, login, text]: [
			schema: string,
			kind: LoginFileKind,
			staging: Staging,
			login: string,
			text: TextChunks
		]
	): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const files = loginFiles[kind]
		yield* fs.makeDirectory(path.join(staging.scratch, files.directory), { recursive: true })
		yield* writeText(path.join(staging.scratch, files.path(login)), text)
	},
	(effect, schema, kind) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.fail(cliError(new ServedUnwritten({ schema, kind, cause })))
		)
)

/**
 * Brings a schema's directory of one kind of login file (loginFiles) to what generate compiled: the file of each login
 * of `write` the staging area holds (stageLoginFile) put in place by rename, the directory made first when it puts
 * one, then each file of a login in `remove` removed; returns the paths written and removed.
 */
export const commitLoginFiles = Effect.fn("commitLoginFiles")(
	function* (
		...[, kind, staging, write, remove]: [
			schema: string,
			kind: LoginFileKind,
			staging: Staging,
			write: ReadonlyArray<string>,
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
			yield* fs.makeDirectory(path.join(staging.directory, files.directory), { recursive: true })
		}
		const written: Array<string> = []
		for (const login of write) {
			const target = path.join(staging.directory, files.path(login))
			yield* fs.rename(path.join(staging.scratch, files.path(login)), target)
			written.push(target)
		}
		const removed: Array<string> = []
		for (const login of remove) {
			const file = path.join(staging.directory, files.path(login))
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
