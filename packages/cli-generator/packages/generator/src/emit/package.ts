import platformNodeManifest from "@effect/platform-node/package.json" with { type: "json" }
import { Data, Effect, FileSystem, Path, Schema } from "effect"
import effectManifest from "effect/package.json" with { type: "json" }
import typescriptManifest from "typescript/package.json" with { type: "json" }
import { printJson, printPackageJson } from "#emit/printer.ts"
import type { AuthorConfig } from "#model/author-config.ts"
import { JsonLiteral } from "#model/brands.ts"
import generatorManifest from "#package.json" with { type: "json" }

export interface EmittedFile {
	readonly content: string
	readonly path: string
}

/**
 * The package holds a value the printer refuses.
 */
export class PackageEmitError extends Data.TaggedError("PackageEmitError")<{
	readonly reason: "unprintable-package"
}> {}

const InstalledManifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

/**
 * The installed `@types/node` version. TypeScript refuses an import of a `@types` package's
 * manifest, so it is read from the file the module resolution names.
 */
const typesNodeVersion = Effect.gen(function* typesNode() {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const manifest = yield* path.fromFileUrl(new URL(import.meta.resolve("@types/node/package.json")))
	const text = yield* fs.readFileString(manifest)
	const { version } = yield* Schema.decodeUnknownEffect(InstalledManifest)(text)

	return version
}).pipe(Effect.orDie)

/**
 * The generated package's compiler options: strict, with the index and optional-property checks
 * the generator's own code is held to, resolving `.ts` imports, typed against Node only.
 */
const compilerOptions = {
	allowImportingTsExtensions: true,
	exactOptionalPropertyTypes: true,
	lib: ["ESNext"],
	module: "ESNext",
	moduleResolution: "Bundler",
	noEmit: true,
	noUncheckedIndexedAccess: true,
	skipLibCheck: true,
	strict: true,
	target: "ESNext",
	types: ["node"]
}

const decodeJson = Schema.decodeUnknownEffect(JsonLiteral)

const buildOptions = {
	allowImportingTsExtensions: false,
	declaration: true,
	noEmit: false,
	outDir: "dist",
	rewriteRelativeImportExtensions: true,
	rootDir: "."
}

const unprintable = () => new PackageEmitError({ reason: "unprintable-package" })

/**
 * Emits `package.json`, `tsconfig.json` and `tsconfig.build.json` (design 4.2, 4.3; X12), sorted by
 * path. The package pins exactly the versions of the packages this generator runs and checks on,
 * read from their installed manifests, and admits the Node versions the generator admits. Both tsc scripts run one checker (`--checkers 1`): full checking at under half the default
 * peak memory.
 */
export const emitPackageFiles = (
	config: AuthorConfig
): Effect.Effect<readonly EmittedFile[], PackageEmitError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* emit() {
		const manifest = yield* decodeJson({
			bin: { [config.binName]: "dist/src/bin.js" },
			dependencies: {
				"@effect/platform-node": platformNodeManifest.version,
				effect: effectManifest.version
			},
			devDependencies: {
				"@types/node": yield* typesNodeVersion,
				typescript: typescriptManifest.version
			},
			engines: { node: generatorManifest.engines.node },
			files: ["dist", "README.md"],
			name: config.package.name,
			scripts: {
				build: "tsc -p tsconfig.build.json --checkers 1",
				typecheck: "tsc --noEmit --checkers 1"
			},
			type: "module",
			version: config.package.version
		}).pipe(Effect.mapError(unprintable))
		const tsconfig = yield* decodeJson({
			compilerOptions,
			exclude: ["node_modules", "dist"],
			include: ["src"]
		}).pipe(Effect.mapError(unprintable))
		const tsconfigBuild = yield* decodeJson({
			compilerOptions: buildOptions,
			exclude: ["node_modules", "dist"],
			extends: "./tsconfig.json",
			include: ["src/**/*.ts"]
		}).pipe(Effect.mapError(unprintable))
		const packageJson = yield* printPackageJson(manifest).pipe(Effect.mapError(unprintable))

		return [
			{ content: packageJson, path: "package.json" },
			{ content: printJson(tsconfigBuild), path: "tsconfig.build.json" },
			{ content: printJson(tsconfig), path: "tsconfig.json" }
		]
	})
