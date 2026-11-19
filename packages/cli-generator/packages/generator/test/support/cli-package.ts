import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { HARDENED_FLAGS } from "@bjornpagen/testing/runner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	type PlatformError,
	Record as Rec,
	Ref,
	Schema,
	type Scope,
	Stream,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
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

/**
 * A suite's fixture as a need, `key` naming it: `open` (a capture server, the package generated and built against its
 * origin) runs once on each worker that runs a property needing it, in that worker's scope, with the harness's
 * services, so the server stops and the package's directory goes when the worker ends; every case the worker runs is
 * given what it opened. No case changes it: a built package is only run, and a capture server observes one run at a
 * time, each observation the case's own. A fixture that does not open refuses its properties on that worker, with its
 * failure.
 */
export const workerFixture = <A, E>(
	key: string,
	open: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices | Digest.Digest>
): Need<A> => ({
	key,
	open: Effect.mapBoth(
		Effect.flatMap(Layer.build(NodeCrypto.layerDigest), (context) =>
			Effect.provideService(open, Digest.Digest, Context.get(context, Digest.Digest))
		),
		{
			onFailure: (error) => NeedFailed.make({ need: key, message: Formatter.format(error) }),
			onSuccess: (opened) => Effect.succeed(opened)
		}
	)
})

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
 * resolve locally, only what is missing is fetched), then its own `build` script. The build's tsc checks every source
 * the package's `typecheck` script checks (tsconfig.build.json extends tsconfig.json over the same src, changing only
 * how it emits) and exits non-zero on any error, so running `typecheck` first would compute the same answer again; the
 * emitted-package suite runs that script itself over every package it draws (typecheckPackage). Answers the package
 * with the built bin its manifest names.
 */
export const buildPackage = Effect.fn("cliPackage.build")(function* (generated: GeneratedPackage) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* buildStep(generated.dir, "install", ["install", "--prefer-offline", "--ignore-workspace"])
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
 * The flag that keeps a built bin's compiled code in Node's compile cache: a module `--import` runs before the bin's
 * first import, which enables the cache (module.enableCompileCache) under node_modules/.cache of the run's directory,
 * the package's own (runBin's and runBinOnTerminal's cwd), so a run reads the V8 code of every module an earlier run of
 * the package compiled (effect, the runtime, its commands) instead of compiling it again. Node checks each entry
 * against its module's source and the cache changes nothing a module does, only how fast a run starts; the bin's
 * arguments and environment stay exactly its invocation's. The cache goes with the package's directory.
 */
const COMPILE_CACHE = `--import=data:text/javascript,${encodeURIComponent(
	'import { enableCompileCache } from "node:module"\nenableCompileCache("node_modules/.cache/node-compile-cache")'
)}`

/**
 * Node's arguments for a run of a built bin, before the bin's own: the testing library's hardened flags (no `__proto__`
 * accessor, no inspector on SIGUSR1, deprecations thrown, strict unhandled rejections and the rest), since a generated
 * CLI must work under them, and the compile cache's flag.
 */
const binArguments = (built: BuiltPackage, args: ReadonlyArray<string>): ReadonlyArray<string> => [
	...HARDENED_FLAGS,
	COMPILE_CACHE,
	built.bin,
	...args
]

/**
 * Runs a built bin with Node to its exit, under binArguments' flags, in the package's directory, under exactly the
 * invocation's environment. The bin runs as a child process, so a server in the test process keeps answering it.
 * Interrupting the run kills it.
 */
export const runBin = (
	built: BuiltPackage,
	invocation: BinInvocation
): Effect.Effect<Finished, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
	finished(
		ChildProcess.make(process.execPath, binArguments(built, invocation.args), {
			cwd: built.dir,
			env: invocation.env,
			extendEnv: false,
			stdin: { stream: Stream.make(invocation.stdin) },
			killSignal: "SIGKILL"
		})
	)

/** A run of a built bin on a terminal: its exit code, and every byte the terminal showed, prompts and output alike. */
type TerminalRun = Readonly<{ exitCode: number; terminal: Uint8Array }>

/** One terminal run: its arguments, its whole environment, and the line the operator types once the terminal shows anything. */
export type TerminalInvocation = Readonly<{
	args: ReadonlyArray<string>
	env: Readonly<Record<string, string>>
	typed: string
}>

/**
 * A command line as the POSIX shell reads it back word for word: each word in single quotes, a quote inside one closed,
 * escaped and reopened. util-linux script(1) takes the command it runs as one `--command` string, which the shell
 * splits, and `--return` makes its exit status the command's.
 */
const shellCommand = (words: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(words, (word) => `'${Str.replaceAll("'", "'\\''")(word)}'`),
		" "
	)

/**
 * Runs a built bin under binArguments' flags on a pseudo-terminal that script(1) opens, as an operator at a terminal runs
 * it: its stdin, stdout and stderr are the terminal, which a prompt needs. Once the terminal shows its first bytes, the
 * operator types `typed` and a carriage return; the run then reads the terminal until the bin exits. What the terminal
 * shows holds whatever the terminal echoes, so a secret typed without echo never appears in it.
 */
export const runBinOnTerminal = Effect.fn("cliPackage.terminal")(function* (
	built: BuiltPackage,
	invocation: TerminalInvocation
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(
		ChildProcess.make(
			"/usr/bin/script",
			[
				"--quiet",
				"--return",
				"--command",
				shellCommand([process.execPath, ...binArguments(built, invocation.args)]),
				"/dev/null"
			],
			{ cwd: built.dir, env: invocation.env, extendEnv: false, killSignal: "SIGKILL" }
		)
	)
	const shown = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
	const prompted = yield* Deferred.make<void>()
	const reading = yield* Effect.forkScoped(
		Stream.runForEach(handle.stdout, (chunk) =>
			Ref.update(shown, (chunks) => Arr.append(chunks, chunk)).pipe(
				Effect.andThen(Deferred.succeed(prompted, undefined))
			)
		)
	)
	yield* Effect.forkScoped(Stream.runDrain(handle.stderr))
	yield* Deferred.await(prompted)
	yield* Stream.run(Stream.make(new TextEncoder().encode(`${invocation.typed}\r`)), handle.stdin)
	const exitCode = yield* handle.exitCode
	yield* Fiber.join(reading)
	const chunks = yield* Ref.get(shown)
	const run: TerminalRun = { exitCode, terminal: Uint8Array.from(Buffer.concat(chunks)) }
	return run
}, Effect.scoped)
