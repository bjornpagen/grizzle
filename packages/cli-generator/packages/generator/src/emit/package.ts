import { findPackageJSON } from "node:module"
import { Effect, FileSystem, Record, Schema } from "effect"
import type { Path } from "effect"
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
export class PackageEmitError extends Schema.TaggedError<
	PackageEmitError,
	{ readonly brand: unique symbol }
>()("PackageEmitError", { reason: Schema.Literal("unprintable-package") }) {}

/**
 * What a generated package pins, by field: the packages its runtime and its CLI import, and the packages it is checked
 * with. Each is pinned to exactly the version the generator itself runs or checks with.
 */
const PINNED = {
	dependencies: ["@effect/platform-node", "arkregex", "effect"],
	devDependencies: ["@types/node", "typescript"]
} as const

const InstalledManifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

/**
 * The version of an installed package, read from the manifest the module resolution finds for it from the generator's
 * own module (`module.findPackageJSON`), which works for packages that do not export their manifest and for `@types`
 * packages, which have no entry point. A package the generator cannot find is a defect of its own install.
 */
const installedVersion = (name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const manifest = yield* Effect.sync(() => findPackageJSON(name, import.meta.url))
		const located = yield* Effect.fromNullishOr(manifest)
		const text = yield* fs.readFileString(located)
		const { version } = yield* Schema.decodeEffect(InstalledManifest)(text)
		return version
	}).pipe(Effect.orDie)

/** Each listed package pinned to its installed version, by name. */
const pinsOf = (names: ReadonlyArray<string>) =>
	Effect.map(
		Effect.forEach(names, (name) =>
			Effect.map(installedVersion(name), (version) => [name, version] as const)
		),
		Record.fromEntries
	)

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
} as const

const decodeJson = Schema.decodeUnknownEffect(JsonLiteral)

/**
 * The build's compiler options: JavaScript into `dist/`, and no declaration files. A generated
 * package is a command, not a library: its manifest exports nothing and its `imports` read types
 * from `src/`, so a declaration file would have no reader, and printing one serializes every
 * inferred schema type, which TypeScript refuses (TS7056) for a large enough request schema.
 */
const buildOptions = {
	allowImportingTsExtensions: false,
	noEmit: false,
	outDir: "dist",
	rewriteRelativeImportExtensions: true,
	rootDir: "."
} as const

const unprintable = () => PackageEmitError.make({ reason: "unprintable-package" })

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
			dependencies: yield* pinsOf(PINNED.dependencies),
			devDependencies: yield* pinsOf(PINNED.devDependencies),
			engines: { node: generatorManifest.engines.node },
			files: ["dist", "README.md"],
			name: config.package.name,
			scripts: {
				build: "tsc -p tsconfig.build.json --checkers 1",
				typecheck: "tsc --noEmit --checkers 1"
			},
			type: "module",
			imports: { "#*.ts": { types: "./src/*.ts", default: "./dist/src/*.js" } },
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
