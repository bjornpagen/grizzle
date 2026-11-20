import { Array as Arr, Effect, FileSystem, Order, Path, Record, String as Str } from "effect"

/** One file of the generated runtime: its path under a generated package's `src/`, and the file it is read from. */
interface RuntimeFile {
	readonly file: string
	readonly key: string
}

/**
 * The generated runtime's sources, each file under `src/runtime-src/` by its path relative to that directory with `/`
 * separators, and the runtime's UTF-8 codec, grizzle-text's utf8.ts, as `runtime/utf8.ts`, in path order: what every
 * generated package holds verbatim under `src/`. They are read from the generator's own tree at generation, never
 * copied into a build-time module, so the runtime a package gets is exactly the runtime source beside the generator
 * that wrote it; the codec is the file the generator's own `#runtime/utf8.ts` import resolves to, so the runtime source
 * and the package it is carried into read one codec. A file that cannot be read is a defect of the generator's own
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
	const codec: RuntimeFile = {
		file: yield* path.fromFileUrl(new URL(import.meta.resolve("#runtime/utf8.ts"))),
		key: "runtime/utf8.ts"
	}
	const keyed = Arr.sort(
		Arr.append(
			Arr.map(files, (file): RuntimeFile => ({
				file: path.join(root, file),
				key: Arr.join(Str.split(file, path.sep), "/")
			})),
			codec
		),
		Order.mapInput(Order.String, (entry: RuntimeFile) => entry.key)
	)
	const contents = yield* Effect.forEach(keyed, ({ file, key }) =>
		Effect.map(fs.readFileString(file), (content) => [key, content] as const)
	)
	return Record.fromEntries(contents)
}).pipe(Effect.orDie)
