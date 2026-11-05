import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Predicate,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"

/** An `exports` target: a module, or its conditions, each naming a module (`{ "types": …, "default": … }`). */
const ExportTarget = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])

/** What the public surface reads of a package.json: its `exports` map, which a package that publishes nothing lacks. */
const SurfaceManifest = Schema.fromJsonString(
	Schema.Struct({ exports: Schema.optionalKey(Schema.Record(Schema.String, ExportTarget)) })
)

const decodeSurfaceManifest = Schema.decodeUnknownEffect(SurfaceManifest)

/** The subpaths under which a package exports the modules its sibling packages build against: a door between the
 * repository's own packages, never its public surface. */
const INTERNAL_SUBPATH = "./internal/"

/** A TypeScript source module, which a program holds: a declaration file is the build's, never the source. */
const isSourceModule = (target: string): boolean =>
	(Str.endsWith(".ts")(target) || Str.endsWith(".tsx")(target)) && !Str.endsWith(".d.ts")(target)

/** The source module an export's target names: itself, or the first of its conditions that names one. A target that
 * names no TypeScript source (a JSON file, the build's output alone) is no module of the surface. */
const sourceOf = (target: typeof ExportTarget.Type): Option.Option<string> =>
	Predicate.isString(target)
		? Option.liftPredicate(target, isSourceModule)
		: Arr.findFirst(Record.values(target), isSourceModule)

/**
 * The public surface a package.json declares: the source module, as an absolute path, of every subpath of its
 * `exports` map but the `./internal/` ones. A manifest without `exports` publishes nothing, so its surface is empty,
 * and so is the surface of a directory without a manifest. It reads through Effect's FileSystem, which is unstable,
 * and so is it.
 *
 * @stability unstable
 */
export const surfaceOf = (
	manifest: string
): Effect.Effect<ReadonlyArray<string>, DevtoolFailure, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const unreadable = (cause: unknown) =>
			DevtoolFailure.make({ detail: `${manifest} could not be read`, cause })
		if (!(yield* fs.exists(manifest).pipe(Effect.mapError(unreadable)))) {
			return []
		}
		const text = yield* fs.readFileString(manifest).pipe(Effect.mapError(unreadable))
		const decoded = yield* decodeSurfaceManifest(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({
					detail: `${manifest} has an exports map this lint does not read: each subpath names a module or its conditions`,
					cause
				})
			)
		)
		const directory = path.dirname(manifest)
		return Arr.filterMap(
			Record.toEntries(decoded.exports ?? {}),
			([subpath, target]): Result.Result<string, void> => {
				const module = sourceOf(target)
				return Str.startsWith(INTERNAL_SUBPATH)(subpath) || Option.isNone(module)
					? Result.failVoid
					: Result.succeed(path.resolve(directory, module.value))
			}
		)
	})
