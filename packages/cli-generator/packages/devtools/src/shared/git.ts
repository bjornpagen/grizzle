import { Array as Arr, Effect, FileSystem, Order, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DevtoolFailure } from "#shared/devtool.ts"

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

/** The files git shows under a directory, tracked or untracked but not ignored, that still exist, in path order. */
export const gitFilesUnder = Effect.fn("gitFilesUnder")(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const command = ChildProcess.make(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: directory }
	)
	const [output, exitCode] = yield* Effect.scoped(
		Effect.flatMap(spawner.spawn(command), (handle) =>
			Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
				concurrency: "unbounded"
			})
		)
	).pipe(Effect.mapError(inspectionFailure(`The git file list of ${directory}`)))
	if (exitCode !== 0) {
		return yield* DevtoolFailure.make({
			detail: `git ls-files exited with ${exitCode} in ${directory}`
		})
	}
	const files = Arr.map(
		Arr.filter(Str.split("\0")(output), Str.isNonEmpty),
		(relative) => `${directory}/${relative}`
	)
	return yield* Effect.filter(Arr.sort(files, Order.String), (file) =>
		fs.exists(file).pipe(Effect.mapError(inspectionFailure(file)))
	)
})
