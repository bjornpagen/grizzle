import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
	String as Str
} from "effect"
import { Yaml } from "effect/encoding"
import { DevtoolFailure } from "#shared/devtool.ts"

/**
 * The repository the dev tools run in, derived from the tree, never named. The dev tools assume POSIX paths: every
 * path they build joins segments with "/".
 */

export class Repository extends Context.Service<
	Repository,
	Readonly<{
		/** The workspace root: the nearest directory above the dev tools holding pnpm-workspace.yaml. */
		root: string
		/** Every workspace package's root, in the order pnpm-workspace.yaml lists their globs. */
		packages: ReadonlyArray<string>
	}>
>()("@grizzle/devtools/shared/repository") {}

/** Files under these directory segments are generated or installed, never maintained source. */
const GENERATED_SEGMENTS: ReadonlyArray<string> = ["node_modules", ".git", ".turbo"]

/** The directory a file sits in. */
export const directoryOf = (file: string): string =>
	Option.match(Str.lastIndexOf("/")(file), {
		onNone: () => ".",
		onSome: (index) => Str.slice(0, index)(file)
	})

/** A path relative to `root`; a file outside it keeps its absolute path. */
export const relativeTo =
	(root: string) =>
	(file: string): string =>
		Str.startsWith(`${root}/`)(file) ? Str.slice(root.length + 1)(file) : file

/** True when the file lies under a directory that holds generated or installed code. */
export const isGeneratedPath = (file: string): boolean =>
	Arr.some(Str.split("/")(file), (segment) => Arr.contains(GENERATED_SEGMENTS, segment))

/** A selected path covers a file when the file is that path or lies under it. */
export const covers = (input: Readonly<{ selected: string; file: string }>): boolean => {
	if (input.file === input.selected) {
		return true
	}
	return Str.startsWith(`${input.selected}/`)(input.file)
}

/** TypeScript and TSX sources, declaration files included; callers decide about declarations. */
export const isTypeScriptPath = (file: string): boolean =>
	Arr.some([".ts", ".tsx"], (extension) => Str.endsWith(extension)(file))

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

/** The workspace root: the nearest directory at or above `directory` holding pnpm-workspace.yaml. */
const workspaceRootFrom = (
	directory: string
): Effect.Effect<string, DevtoolFailure, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const marker = path.join(directory, "pnpm-workspace.yaml")
		if (yield* fs.exists(marker).pipe(Effect.mapError(inspectionFailure(marker)))) {
			return directory
		}
		const parent = path.dirname(directory)
		if (parent === directory) {
			return yield* DevtoolFailure.make({
				detail: "No pnpm-workspace.yaml above the dev tools: they run inside a pnpm workspace"
			})
		}
		return yield* workspaceRootFrom(parent)
	})

/** What pnpm-workspace.yaml says about the workspace's packages: the globs that select them. */
const WorkspaceManifest = Schema.Struct({ packages: Schema.Array(Schema.String) })

const decodeWorkspaceManifest = Schema.decodeUnknownEffect(WorkspaceManifest)

/** The package globs of pnpm-workspace.yaml. */
const workspaceGlobsOf = (
	manifest: string,
	text: string
): Effect.Effect<ReadonlyArray<string>, DevtoolFailure> =>
	Effect.try({
		try: () => Yaml.parse(text),
		catch: (cause) => DevtoolFailure.make({ detail: `${manifest} is not YAML`, cause })
	}).pipe(
		Effect.flatMap(decodeWorkspaceManifest),
		Effect.mapBoth({
			onSuccess: (decoded) => decoded.packages,
			onFailure: (cause) =>
				DevtoolFailure.make({
					detail: `${manifest} must list the workspace's package globs`,
					cause
				})
		})
	)

/** The package roots one workspace glob selects: `dir/*` the directories under dir holding a package.json, any other
 * glob the directory it names. pnpm's other glob forms appear in no workspace here, so they are refused. */
const packagesOf = (
	root: string,
	glob: string
): Effect.Effect<ReadonlyArray<string>, DevtoolFailure, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (Str.includes("**")(glob) || Str.startsWith("!")(glob)) {
			return yield* DevtoolFailure.make({
				detail: `pnpm-workspace.yaml lists ${glob}; the dev tools read only dir/* and plain directory globs`
			})
		}
		const candidates = Str.endsWith("/*")(glob)
			? yield* fs.readDirectory(`${root}/${Str.slice(0, -2)(glob)}`).pipe(
					Effect.mapBoth({
						onFailure: inspectionFailure(`${root}/${glob}`),
						onSuccess: (names) =>
							Arr.map(
								Arr.sort(names, Str.Order),
								(name) => `${root}/${Str.slice(0, -2)(glob)}/${name}`
							)
					})
				)
			: [`${root}/${glob}`]
		return yield* Effect.filter(candidates, (candidate) =>
			fs
				.exists(`${candidate}/package.json`)
				.pipe(Effect.mapError(inspectionFailure(`${candidate}/package.json`)))
		)
	})

/** The repository, derived: its root from where the dev tools sit, its packages from pnpm-workspace.yaml. */
const derive = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* workspaceRootFrom(import.meta.dirname)
	const manifest = `${root}/pnpm-workspace.yaml`
	const text = yield* fs.readFileString(manifest).pipe(Effect.mapError(inspectionFailure(manifest)))
	const globs = yield* workspaceGlobsOf(manifest, text)
	const packages = Arr.flatten(yield* Effect.forEach(globs, (glob) => packagesOf(root, glob)))
	return { root, packages }
})

/**
 * The repository service, derived through Effect's FileSystem and Path, which are unstable, and so is it.
 *
 * @stability unstable
 */
export const RepositoryLive = Layer.effect(Repository, derive)
