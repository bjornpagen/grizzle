import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Path,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * The runtime gate: generates the runtime-gate fixture, whose operations reach every module of the generated runtime,
 * into a fresh directory and runs the generated package's own typecheck against the workspace's installed
 * dependencies. It fails when generation fails, when the generator refuses anything other than token acquisition
 * (which it refuses for every OAuth 2 flow and OpenID Connect, schemes the fixture holds on purpose), or when the
 * package does not typecheck. It stands until the property that every emitted package typechecks covers it.
 */

/** The generator package. */
const PACKAGE = `${import.meta.dirname}/..`

/** The repository root, whose installed dependencies the generated package resolves. */
const ROOT = `${PACKAGE}/../..`

const FIXTURE = `${PACKAGE}/test/fixtures/runtime-gate`

/** The suffix of every refusal code for a token the generated CLI does not acquire itself. */
const TOKEN_ACQUISITION = "/token-acquisition"

/** A failure of the gate: a step did not run or did not pass, or the generator's report could not be read. */
class RuntimeGateFailure extends Schema.TaggedError<
	RuntimeGateFailure,
	{ readonly brand: unique symbol }
>()("RuntimeGateFailure", {
	detail: Schema.String
}) {}

/** The generation report, as the gate reads it: each refusal's code and the pointer it names. */
const Report = Schema.fromJsonString(
	Schema.Struct({
		refusals: Schema.Array(Schema.Struct({ code: Schema.String, pointer: Schema.String }))
	})
)

const decodeReport = Schema.decodeUnknownEffect(Report)

/** Runs one step of the gate to its end and answers its standard output; any exit but zero fails the gate. */
const run = Effect.fn("runtimeGate.run")(function* (
	step: string,
	command: string,
	args: ReadonlyArray<string>,
	directory: string
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [stdout, stderr, exitCode] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(ChildProcess.make(command, [...args], { cwd: directory, extendEnv: true })),
			(handle) =>
				Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr)),
						handle.exitCode
					],
					{ concurrency: "unbounded" }
				)
		)
	).pipe(Effect.mapError(() => RuntimeGateFailure.make({ detail: `${step} could not run` })))
	if (exitCode !== 0) {
		return yield* RuntimeGateFailure.make({
			detail: `${step} exited with ${String(exitCode)}:\n${stdout}${stderr}`
		})
	}
	return stdout
})

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const node = yield* Effect.sync(() => process.execPath)
	const scratch = yield* fs
		.makeTempDirectoryScoped()
		.pipe(
			Effect.mapError(() =>
				RuntimeGateFailure.make({ detail: "no scratch directory could be made" })
			)
		)
	const out = path.join(scratch, "cli")
	const report = yield* run(
		"generation",
		node,
		[
			"src/bin.ts",
			"generate",
			`${FIXTURE}/openapi.json`,
			"--config",
			`${FIXTURE}/author-config.json`,
			"--out",
			out,
			"--report",
			"json"
		],
		PACKAGE
	).pipe(
		Effect.flatMap((stdout) =>
			decodeReport(stdout).pipe(
				Effect.mapError(() =>
					RuntimeGateFailure.make({ detail: "the generation report is unreadable" })
				)
			)
		)
	)
	const unexpected = Arr.filter(
		report.refusals,
		(refusal) => !Str.endsWith(TOKEN_ACQUISITION)(refusal.code)
	)
	if (Arr.isReadonlyArrayNonEmpty(unexpected)) {
		return yield* RuntimeGateFailure.make({
			detail: Arr.join(
				[
					"the generator refused part of the runtime-gate fixture, so it no longer reaches the whole runtime:",
					...Arr.map(unexpected, (refusal) => `  ${refusal.code} at ${refusal.pointer}`)
				],
				"\n"
			)
		})
	}
	yield* fs
		.symlink(path.resolve(ROOT, "node_modules"), path.join(out, "node_modules"))
		.pipe(
			Effect.mapError(() =>
				RuntimeGateFailure.make({ detail: "the workspace's dependencies could not be linked" })
			)
		)
	yield* run("the generated package's typecheck", node, ["--run", "typecheck"], out)
	yield* Console.log("runtime gate: the runtime-gate fixture's generated package typechecks.")
})

NodeRuntime.runMain(
	main.pipe(
		Effect.scoped,
		Effect.catchTag("RuntimeGateFailure", (failure) =>
			Effect.flatMap(Console.error(`runtime gate: ${failure.detail}`), () =>
				Effect.sync(() => {
					process.exitCode = 1
				})
			)
		),
		Effect.provide(NodeServices.layer)
	)
)
