import { constants } from "node:fs"
import { cp } from "node:fs/promises"
import { failureFrom } from "@bjornpagen/devtools/devtool"
import { Effect } from "effect"

/**
 * Clones `from` to `to`, recursively, by one code path on every platform: each file copy-on-write where the file system
 * can (COPYFILE_FICLONE: a clonefile on APFS, a reflink on Btrfs or XFS) and copied where it cannot. Symbolic links are
 * copied as written, never resolved (verbatimSymlinks), so a relative one resolves inside the clone. Effect's
 * FileSystem.copy takes neither option, so this module alone of the tool imports node:fs (tsconfig.json's
 * nodeBuiltinImport override).
 */
export const cloneInto = Effect.fn("cloneInto")(function* (from: string, to: string) {
	yield* Effect.tryPromise({
		try: () =>
			cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true }),
		catch: failureFrom(`${from} could not be cloned to ${to}`)
	})
})
