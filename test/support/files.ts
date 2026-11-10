import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Array as Arr, Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"

/**
 * Node's file system and paths, taken once from a runtime of their layers: test code reads the files it loads through
 * them, so no test code reads a file or joins a path but through Effect's FileSystem and Path.
 */
const { files, paths } = await ManagedRuntime.make(
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
).runPromise(
	Effect.all({ files: Effect.service(FileSystem.FileSystem), paths: Effect.service(Path.Path) })
)

/**
 * The text of the file at `path`, read through Effect's FileSystem. A file a run needs and cannot read is a defect of
 * the run, as the module that reads it when it loads fails to load: `await Effect.runPromise(fileText(path))` there.
 */
export const fileText = (path: string): Effect.Effect<string> =>
	Effect.orDie(files.readFileString(path))

/** `segments` joined into one normalized path, as Effect's Path joins them. */
export const joinPath = (...segments: ReadonlyArray<string>): string =>
	Arr.reduce(segments, "", (path, segment) => paths.join(path, segment))

export { paths }

/** The repository's root directory, ending in a slash. */
export const repoRoot = `${joinPath(import.meta.dirname, "../..")}/`
