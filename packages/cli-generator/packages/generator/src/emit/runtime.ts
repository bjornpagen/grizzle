import { Array as Arr, Effect, FileSystem, Order, Path, Record, String as Str } from "effect"

/**
 * The generated runtime's sources, each file under `src/runtime-src/` by its path relative to that directory with `/`
 * separators, in path order: what every generated package holds verbatim under `src/`. They are read from the
 * generator's own tree at generation, never copied into a build-time module, so the runtime a package gets is exactly
 * the runtime source beside the generator that wrote it. A file that cannot be read is a defect of the generator's own
 * install.
 */
export const runtimeSources: Effect.Effect<
	Readonly<Record<string, string>>,
	never,
	FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.join(import.meta.dirname, "..", "runtime-src")
	const entries = yield* fs.readDirectory(root, { recursive: true })
	const files = yield* Effect.filter(entries, (entry) =>
		Effect.map(fs.stat(path.join(root, entry)), (info) => info.type === "File")
	)
	const keyed = Arr.sort(
		Arr.map(files, (file) => ({ file, key: Arr.join(Str.split(file, path.sep), "/") })),
		Order.mapInput(Order.String, (entry: { readonly key: string }) => entry.key)
	)
	const contents = yield* Effect.forEach(keyed, ({ file, key }) =>
		Effect.map(fs.readFileString(path.join(root, file)), (content) => [key, content] as const)
	)
	return Record.fromEntries(contents)
}).pipe(Effect.orDie)
