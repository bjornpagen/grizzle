import { Array as Arr, Effect, FileSystem, Path, type PlatformError } from "effect"
import { readText } from "#adapter/boundary/files.ts"
import { readNamed } from "#adapter/boundary/laid-out.ts"
import { readMeta } from "#adapter/boundary/meta.ts"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { CompileError } from "#compiler/plan/common.ts"
import { isFolderName, metaFileName, replayLocks } from "#compiler/plan/migration.ts"
import { manifestFileName, snapshotFileName } from "#compiler/plan/serve.ts"

/** The locks one schema's directory states of its transactions: each drafted file's, and its snapshot's full replay. */
const schemaLocks = Effect.fn("schemaLocks")(function* (
	directory: string
): Effect.fn.Return<
	ReadonlyArray<number>,
	CompileError | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = yield* fs.readDirectory(directory)
	const snapshotPath = path.join(directory, snapshotFileName)
	const replay: Array<number> = []
	if (yield* fs.exists(snapshotPath)) {
		const snapshot = yield* readText(snapshotPath)
		const manifest = yield* readNamed(directory, manifestFileName, "manifest")
		const read = yield* Effect.fromResult(readSnapshot({ snapshot, manifest }))
		replay.push(replayLocks(read.snapshot))
	}
	const files: Array<number> = []
	for (const entry of Arr.filter(entries, isFolderName)) {
		const text = yield* readNamed(path.join(directory, entry), metaFileName, "meta")
		const meta = yield* Effect.fromResult(readMeta(text))
		if (meta.kind === "drafted") {
			for (const f of meta.record.files) {
				files.push(f.locks)
			}
		}
	}
	return [...replay, ...files]
})

/**
 * The most locks one transaction of `grizzle migrate` holds applying every migration the migrations directory
 * `directory` holds (a configuration's `migrations`, one directory a schema): the largest any drafted file's meta.json
 * states (deploy/locks/demand.ts fileLockSets), or the drift check's replay of every object of a schema's snapshot, as
 * a first install's check replays them, with one apply lock for each schema, which the session holds through every
 * transaction (adapter/migrate/apply.ts lockTableHolds). Fails where a schema's snapshot or a folder's meta.json does not read as `grizzle migrate` reads it.
 */
export const migrationLocks = Effect.fn("migrationLocks")(function* (
	directory: string
): Effect.fn.Return<
	number,
	CompileError | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const schemas: Array<string> = []
	for (const entry of yield* fs.readDirectory(directory)) {
		const info = yield* fs.stat(path.join(directory, entry))
		if (info.type === "Directory") {
			schemas.push(entry)
		}
	}
	const each = yield* Effect.forEach(schemas, (s) => schemaLocks(path.join(directory, s)))
	return Arr.reduce(Arr.flatten(each), 0, (most, n) => Math.max(most, n)) + schemas.length
})
