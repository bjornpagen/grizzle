import { jsonTextOf } from "@superstarter/json"
import { Array as Arr, Effect, type Scope } from "effect"
import { type createFileSystem, type FileSystemCallbacks, serverFS } from "typescript/fs"
import { API, type Project } from "typescript/sync"
import { DevtoolFailure } from "#shared/devtool.ts"
import { directoryOf } from "#shared/repository.ts"

/**
 * One native compiler session. The tsgo process lives exactly as long as the scope, and every call into it is a
 * synchronous IPC round trip, so callers batch their checker calls.
 */
export const nativeSession = (
	options: Readonly<{ cwd: string; fs?: FileSystemCallbacks }>
): Effect.Effect<API, DevtoolFailure, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.try({
			try: () => new API(options),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The native TypeScript compiler did not start", cause })
		}),
		(api) =>
			Effect.sync(() => {
				api.close()
			})
	)

/** Opens one tsconfig project in its own snapshot, read from `fileSystem` when one is given (a full one is
 * total: nothing is read from the host). A config the compiler rejects is a failure. */
export const openProject = (
	input: Readonly<{ api: API; config: string; fileSystem?: ReturnType<typeof createFileSystem> }>
): Effect.Effect<Project, DevtoolFailure, Scope.Scope> =>
	Effect.gen(function* () {
		const snapshot = yield* Effect.acquireDisposable(
			Effect.try({
				try: () =>
					input.api.createSnapshot({ openProjects: [input.config], fileSystem: input.fileSystem }),
				catch: (cause) =>
					DevtoolFailure.make({ detail: "The native compiler could not build the program", cause })
			})
		)
		const project = snapshot.getConfiguredProject(input.config)
		if (project === undefined) {
			return yield* DevtoolFailure.make({
				detail: `The native compiler did not open ${input.config}`
			})
		}
		const diagnostics = yield* Effect.try({
			try: () => project.program.getConfigFileParsingDiagnostics(),
			catch: (cause) => DevtoolFailure.make({ detail: `${input.config} could not be read`, cause })
		})
		if (Arr.isReadonlyArrayNonEmpty(diagnostics)) {
			return yield* DevtoolFailure.make({
				detail: Arr.join(
					Arr.map(diagnostics, (diagnostic) => diagnostic.text),
					"\n"
				)
			})
		}
		return project
	})

/**
 * Opens a tsconfig's program in a session of its own. Files the tsconfig leaves out (a scratch file a tool was
 * pointed at) are added through an overlay: a virtual config beside the real one, so its relative paths resolve
 * the same, that extends it and adds the files, so they are checked with the project's real options.
 */
export const openProgram = (
	input: Readonly<{ config: string; extraFiles: ReadonlyArray<string> }>
): Effect.Effect<Project, DevtoolFailure, Scope.Scope> =>
	Effect.gen(function* () {
		const cwd = directoryOf(input.config)
		if (!Arr.isReadonlyArrayNonEmpty(input.extraFiles)) {
			const api = yield* nativeSession({ cwd })
			return yield* openProject({ api, config: input.config })
		}
		const overlayConfig = `${cwd}/.overlay.tsconfig.json`
		const overlay = jsonTextOf({ extends: input.config, files: input.extraFiles })
		const nativeFs: FileSystemCallbacks = {
			directoryExists: serverFS.useOS,
			fileExists: (file) => (file === overlayConfig ? true : serverFS.useOS),
			getAccessibleEntries: serverFS.useOS,
			readFile: (file) => (file === overlayConfig ? overlay : serverFS.useOS),
			realpath: serverFS.useOS,
			stat: serverFS.useOS,
			writeFile: serverFS.useOS,
			removeFile: serverFS.useOS
		}
		const api = yield* nativeSession({ cwd, fs: nativeFs })
		return yield* openProject({ api, config: overlayConfig })
	})
