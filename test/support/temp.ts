import { Effect, FileSystem, type PlatformError, type Scope } from "effect"

/**
 * A scratch directory under `parent` whose name starts with `prefix`, removed with everything in it when the scope
 * closes, however it closes.
 *
 * @internal
 */
export const scopedTempDir = (
	parent: string,
	prefix: string
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.makeTempDirectoryScoped({ directory: parent, prefix })
	})
