import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { HARDENED_FLAGS } from "@superstarter/testing/vitest/config"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	type PlatformError,
	Record as Rec,
	Schema,
	Stream
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { generate, type GenerateResult } from "#generate.ts"
import { DocumentUri } from "#model/brands.ts"
import { type Finished, finished } from "#test/support/process.ts"

/** A file a fixture writes: its path, `/`-separated and relative to the directory it lands in, and its text. */
type FixtureFile = Readonly<{ path: string; text: string }>

/**
 * One package to generate: the specification and the author config, each written into the fixture's own directory and
 * named in diagnostics by a fixed `file:///fixture/` URI, never a host path; and the files the API author owns, such as
 * the command module an author config names, written into the package after generation.
 */
type Fixture = Readonly<{
	spec: FixtureFile
	config: FixtureFile
	authorFiles: ReadonlyArray<FixtureFile>
}>

/** A generated package: its directory inside the scoped temporary directory, and what the run reported. */
type GeneratedPackage = Readonly<{ dir: string; result: GenerateResult }>

/** A generated package installed, type-checked and built: its directory and the built bin its manifest names. */
export type BuiltPackage = Readonly<{ dir: string; bin: string }>

/**
 * One run of a built bin: its arguments after the bin, its whole environment (nothing of the test process's own reaches
 * it) and the bytes its stdin reads before it ends.
 */
export type BinInvocation = Readonly<{
	args: ReadonlyArray<string>
	env: Readonly<Record<string, string>>
	stdin: Uint8Array
}>

/** A build step of a generated package. */
type BuildStep = "install" | "typecheck" | "build"

/** A build step that exited non-zero, with its exit code and output. */
class BuildStepFailed extends Schema.TaggedError<
	BuildStepFailed,
	{ readonly brand: unique symbol }
>()("BuildStepFailed", {
	step: Schema.Literals(["install", "typecheck", "build"]),
	exitCode: Schema.Int,
	stdout: Schema.Uint8Array,
	stderr: Schema.Uint8Array
}) {}

/** The generated manifest's one bin, the built entry a user's `npx` runs. */
const Manifest = Schema.fromJsonString(
	Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) })
)

/** A manifest that names no bin or more than one. */
class ManifestBinUnclear extends Schema.TaggedError<
	ManifestBinUnclear,
	{ readonly brand: unique symbol }
>()("ManifestBinUnclear", { bins: Schema.Array(Schema.String) }) {}

/** Everything the harness runs on: Node's file system, path, child processes and digests. */
export const harnessLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest)

/** Writes a fixture file under a directory, making its parent directories. */
const writeUnder = Effect.fn("cliPackage.write")(function* (directory: string, file: FixtureFile) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = path.join(directory, file.path)
	yield* fs.makeDirectory(path.dirname(target), { recursive: true })
	yield* fs.writeFileString(target, file.text)
	return target
})

/** The fixed URI diagnostics name a fixture file by. */
const documentOf = (file: FixtureFile) =>
	Schema.decodeEffect(DocumentUri)(`file:///fixture/${file.path}`)

/**
 * Generates the fixture through `generate` into `<root>/out`, where `root` is a temporary directory the scope removes,
 * then writes the author's files into the package.
 */
export const generateFixture = Effect.fn("cliPackage.generate")(function* (fixture: Fixture) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "generated-cli-" })
	const inputs = path.join(root, "fixture")
	const dir = path.join(root, "out")
	const specPath = yield* writeUnder(inputs, fixture.spec)
	const configPath = yield* writeUnder(inputs, fixture.config)
	const specDocument = yield* documentOf(fixture.spec)
	const configDocument = yield* documentOf(fixture.config)
	const result = yield* generate(
		{
			document: specDocument,
			outDir: dir,
			source: { _tag: "File", path: specPath },
			strict: false
		},
		{ document: configDocument, path: configPath }
	)
	yield* Effect.forEach(fixture.authorFiles, (file) => writeUnder(dir, file), { discard: true })
	const generated: GeneratedPackage = { dir, result }
	return generated
})

/** Runs one build step in the package's directory under the test process's environment. */
const buildStep = Effect.fn("cliPackage.step")(function* (
	dir: string,
	step: BuildStep,
	args: ReadonlyArray<string>
) {
	const run = yield* finished(ChildProcess.make("pnpm", args, { cwd: dir }))
	if (run.exitCode !== 0) {
		return yield* BuildStepFailed.make({ step, ...run })
	}
})

/**
 * Builds a generated package as a user would: `pnpm install --prefer-offline --ignore-workspace` (the store's packages
 * resolve locally, only what is missing is fetched), then its own `typecheck` and `build` scripts, one after another.
 * Answers the package with the built bin its manifest names.
 */
export const buildPackage = Effect.fn("cliPackage.build")(function* (generated: GeneratedPackage) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* buildStep(generated.dir, "install", ["install", "--prefer-offline", "--ignore-workspace"])
	yield* buildStep(generated.dir, "typecheck", ["run", "typecheck"])
	yield* buildStep(generated.dir, "build", ["run", "build"])
	const manifestText = yield* fs.readFileString(path.join(generated.dir, "package.json"))
	const manifest = yield* Schema.decodeEffect(Manifest)(manifestText)
	const bins = Rec.values(manifest.bin)
	return yield* Option.match(Arr.length(bins) === 1 ? Arr.head(bins) : Option.none(), {
		onNone: () => Effect.fail(ManifestBinUnclear.make({ bins })),
		onSome: (bin) =>
			Effect.succeed<BuiltPackage>({ dir: generated.dir, bin: path.join(generated.dir, bin) })
	})
})

/**
 * Type-checks a generated package without installing it: its `node_modules` is a link to the workspace root's, whose
 * packages are the very versions the package pins, read from their installed manifests; then its own `typecheck`
 * script runs through `node --run`, never pnpm, which would take the linked directory for the package's own install
 * and rewrite the workspace's. A refusal is the `typecheck` step's BuildStepFailed, with the compiler's output.
 */
export const typecheckPackage = Effect.fn("cliPackage.typecheck")(function* (
	generated: GeneratedPackage
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.symlink(
		path.join(import.meta.dirname, "..", "..", "..", "..", "node_modules"),
		path.join(generated.dir, "node_modules")
	)
	const run = yield* finished(
		ChildProcess.make("node", ["--run", "typecheck"], { cwd: generated.dir })
	)
	if (run.exitCode !== 0) {
		return yield* BuildStepFailed.make({ step: "typecheck", ...run })
	}
})

/**
 * Runs a built bin with Node to its exit, under the testing library's hardened flags (no `__proto__` accessor, no
 * inspector on SIGUSR1, deprecations thrown, strict unhandled rejections and the rest), since a generated CLI must work
 * under them; in the package's directory, under exactly the invocation's environment. The bin runs as a child process,
 * so a server in the test process keeps answering it. Interrupting the run kills it.
 */
export const runBin = (
	built: BuiltPackage,
	invocation: BinInvocation
): Effect.Effect<Finished, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
	finished(
		ChildProcess.make(process.execPath, [...HARDENED_FLAGS, built.bin, ...invocation.args], {
			cwd: built.dir,
			env: invocation.env,
			extendEnv: false,
			stdin: { stream: Stream.make(invocation.stdin) },
			killSignal: "SIGKILL"
		})
	)
