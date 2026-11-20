import { Array as Arr, Effect, Order, Record } from "effect"
import type { FileSystem, Path } from "effect"
import { emitEntryFiles } from "#emit/entry.ts"
import { emitPackageFiles } from "#emit/package.ts"
import type { EmittedFile, PackageEmitError } from "#emit/package.ts"
import type { PrinterError } from "#emit/printer.ts"
import { emitReadme } from "#emit/readme.ts"
import type { ReadmeInput } from "#emit/readme.ts"
import { runtimeSources } from "#emit/runtime.ts"

const byPath = Order.mapInput(Order.String, (file: EmittedFile) => file.path)

/**
 * Emits the package scaffold (design 4.1, 4.2, 4.3): `package.json` and both tsconfigs,
 * `src/bin.ts` and `src/main.ts`, `README.md`, and the runtime's sources verbatim under `src/`, sorted by path. Refusal
 * diagnostics only shape the README's summary; they never fail the scaffold. The `domain/`,
 * `api/` and `cli/` layers are emitted by their own emitters.
 */
export const emitScaffold = (
	input: ReadmeInput
): Effect.Effect<
	readonly EmittedFile[],
	PackageEmitError | PrinterError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* emit() {
		const packageFiles = yield* emitPackageFiles(input.config)
		const entryFiles = yield* emitEntryFiles(input.config, input.api.securitySchemes)
		const sources = yield* runtimeSources
		const runtime = Arr.map(Record.toEntries(sources), ([key, content]) => ({
			content,
			path: `src/${key}`
		}))

		return Arr.sort([...packageFiles, ...entryFiles, emitReadme(input), ...runtime], byPath)
	})
