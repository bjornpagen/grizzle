import {
	Array as Arr,
	type Cause,
	Effect,
	FileSystem,
	Path,
	type PlatformError,
	Queue,
	Ref,
	Schema,
	type Scope,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { finished } from "#test/support/process.ts"

/**
 * Grizzle's side of the end-to-end suites (test/grizzle): grizzle's checkout at the commit this repository pins,
 * vendor/grizzle, a git submodule, and the driver test/fixtures/grizzle/driver.ts running inside it.
 *
 * The driver imports grizzle's own modules, so it is checked and run where they resolve: `grizzleDriver` installs the
 * checkout's packages from its lockfile, copies the driver to `.probe-eocg/driver.ts` in it (a directory grizzle's
 * .gitignore keeps out of its tree), typechecks it under grizzle's own compiler options and Effect diagnostics with
 * one file override (`driverOverride`), and runs it with Node, talking to it one JSON line each way. The driver reaches
 * the local PostgreSQL cluster grizzle's own suites reach, the one GRIZZLE_PG_CLUSTER names by its port or else the
 * shared default, through their substrate, which claims a shared database of the cluster, never one of a Vitest worker
 * of this repository. A checkout that is missing, an install or a typecheck
 * that fails, fails the suite: nothing here is skipped.
 */

/** The workspace root: four directories above this file's. */
const workspaceRoot = (path: Path.Path): string =>
	path.join(import.meta.dirname, "..", "..", "..", "..")

/** vendor/grizzle holds no checkout: the submodule was never initialized. */
class GrizzleAbsent extends Schema.TaggedError<GrizzleAbsent, { readonly brand: unique symbol }>()(
	"GrizzleAbsent",
	{ root: Schema.String }
) {
	override get message(): string {
		return `${this.root} holds no checkout of grizzle: run git submodule update --init vendor/grizzle`
	}
}

/** A step of setting the driver up that exited non-zero: which one, its exit code and its output. */
class GrizzleStepFailed extends Schema.TaggedError<
	GrizzleStepFailed,
	{ readonly brand: unique symbol }
>()("GrizzleStepFailed", {
	step: Schema.Literals(["install", "typecheck"]),
	exitCode: Schema.Int,
	output: Schema.String
}) {
	override get message(): string {
		return `grizzle's ${this.step} exited ${this.exitCode}:\n${this.output}`
	}
}

/** The driver ended, or closed its stdout, before it answered a command: what it wrote to stderr. */
class DriverEnded extends Schema.TaggedError<DriverEnded, { readonly brand: unique symbol }>()(
	"DriverEnded",
	{ stderr: Schema.String }
) {
	override get message(): string {
		return `the grizzle driver ended before it answered:\n${this.stderr}`
	}
}

/**
 * The Effect language service's entry in grizzle's root tsconfig.json: its name and its per-file overrides, beside
 * every other option it states, kept as they are.
 */
const LanguageService = Schema.StructWithRest(
	Schema.Struct({
		name: Schema.Literal("@effect/language-service"),
		overrides: Schema.Array(Schema.Json)
	}),
	[Schema.Record(Schema.String, Schema.Json)]
)

/** Grizzle's root tsconfig.json, as far as the driver's own config derives from it. */
const RootTsconfig = Schema.fromJsonString(
	Schema.Struct({
		extends: Schema.String,
		references: Schema.Array(Schema.Struct({ path: Schema.String })),
		compilerOptions: Schema.StructWithRest(
			Schema.Struct({ plugins: Schema.Tuple([LanguageService]) }),
			[Schema.Record(Schema.String, Schema.Json)]
		)
	})
)

/**
 * The driver's one file override of grizzle's diagnostics, as grizzle states its own entry points' (its tsconfig.json
 * overrides): it is an entry point, which provides its layers once with Effect.provide (strictEffectProvide), and it
 * serves over node:http, whose server grizzle's nodeListener is written for (nodeBuiltinImport).
 */
const driverOverride: Schema.Json = {
	include: ["driver.ts"],
	options: { diagnosticSeverity: { strictEffectProvide: "off", nodeBuiltinImport: "off" } }
}

/**
 * The driver's tsconfig.json in the probe directory: grizzle's root config with its paths taken from one directory down,
 * the driver its one file, and `driverOverride` beside grizzle's own overrides.
 */
const probeTsconfig = (rootText: string) =>
	Effect.map(Schema.decodeEffect(RootTsconfig)(rootText), (root) => {
		const [service] = root.compilerOptions.plugins
		const config: Schema.Json = {
			extends: `../${root.extends}`,
			compilerOptions: {
				...root.compilerOptions,
				plugins: [{ ...service, overrides: [...service.overrides, driverOverride] }]
			},
			references: Arr.map(root.references, (reference) => ({ path: `../${reference.path}` })),
			include: ["driver.ts"]
		}
		return config
	})

/** Runs one setup step in the checkout, failing with its output when it exits non-zero. */
const step = Effect.fn("grizzle.step")(function* (
	root: string,
	name: "install" | "typecheck",
	command: string,
	args: ReadonlyArray<string>
) {
	const run = yield* finished(ChildProcess.make(command, args, { cwd: root }))
	if (run.exitCode !== 0) {
		const decoder = new TextDecoder()
		return yield* GrizzleStepFailed.make({
			step: name,
			exitCode: run.exitCode,
			output: `${decoder.decode(run.stdout)}${decoder.decode(run.stderr)}`
		})
	}
})

/** A command the driver reads (test/fixtures/grizzle/driver.ts). */
export type DriverCommand =
	| Readonly<{ op: "install" }>
	| Readonly<{ op: "store"; stored: ReadonlyArray<Schema.Json> }>
	| Readonly<{ op: "once"; program: string; body: Schema.Json }>
	| Readonly<{ op: "uninstall" }>

/** The driver, running: `ask` writes one command and reads its one answer, as JSON. */
export type GrizzleDriver = Readonly<{
	ask: (command: DriverCommand) => Effect.Effect<Schema.Json, DriverEnded | Schema.SchemaError>
}>

/** The prefix of the driver's answers on its stdout; any other line there is a diagnostic. */
const replyPrefix = "reply "

const decodeReply = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

/**
 * The driver set up in vendor/grizzle and running (see the header), for the scope: closing it ends the driver's stdin,
 * which uninstalls whatever it installed, and waits for it to exit. Its stderr and its stdout's other lines are kept,
 * and a command it does not answer fails with them.
 */
export const grizzleDriver: Effect.Effect<
	GrizzleDriver,
	GrizzleAbsent | GrizzleStepFailed | Schema.SchemaError | PlatformError.PlatformError,
	Scope.Scope | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const root = path.join(workspaceRoot(path), "vendor", "grizzle")
	if (!(yield* fs.exists(path.join(root, "package.json")))) {
		return yield* GrizzleAbsent.make({ root })
	}
	yield* step(root, "install", "pnpm", ["install", "--frozen-lockfile"])
	const probe = path.join(root, ".probe-eocg")
	yield* fs.makeDirectory(probe, { recursive: true })
	yield* fs.copyFile(
		path.join(import.meta.dirname, "..", "fixtures", "grizzle", "driver.ts"),
		path.join(probe, "driver.ts")
	)
	const rootTsconfig = yield* fs.readFileString(path.join(root, "tsconfig.json"))
	const tsconfig = yield* probeTsconfig(rootTsconfig)
	const tsconfigText = yield* encodeCommand(tsconfig)
	yield* fs.writeFileString(path.join(probe, "tsconfig.json"), tsconfigText)
	yield* step(root, "typecheck", path.join(root, "node_modules", ".bin", "effect-tsgo"), [
		"tsrs",
		"-b",
		path.join(".probe-eocg", "tsconfig.json")
	])
	const commands = yield* Queue.unbounded<Uint8Array, Cause.Done>()
	const replies = yield* Queue.unbounded<string, Cause.Done>()
	const diagnostics = yield* Ref.make<ReadonlyArray<string>>([])
	const handle = yield* spawner.spawn(
		ChildProcess.make(process.execPath, [path.join(".probe-eocg", "driver.ts")], {
			cwd: root,
			extendEnv: true,
			env: { VITEST_POOL_ID: undefined, VITEST_WORKER_ID: undefined },
			stdin: { stream: Stream.fromQueue(commands), endOnDone: true }
		})
	)
	yield* Effect.forkScoped(
		Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (line) =>
			Str.startsWith(replyPrefix)(line)
				? Queue.offer(replies, Str.slice(replyPrefix.length)(line))
				: Ref.update(diagnostics, Arr.append(line))
		).pipe(Effect.ensuring(Queue.end(replies)))
	)
	yield* Effect.forkScoped(
		Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stderr)), (line) =>
			Ref.update(diagnostics, Arr.append(line))
		)
	)
	yield* Effect.addFinalizer(() =>
		Effect.andThen(Queue.end(commands), Effect.ignore(handle.exitCode))
	)
	const ended = Effect.flatMap(Ref.get(diagnostics), (lines) =>
		DriverEnded.make({ stderr: Arr.join(lines, "\n") })
	)
	const encoder = new TextEncoder()
	const driver: GrizzleDriver = {
		ask: (command) =>
			Effect.gen(function* () {
				const text = yield* encodeCommand(command)
				yield* Queue.offer(commands, encoder.encode(`${text}\n`))
				const answer = yield* Effect.catchTag(Queue.take(replies), "Done", () => ended)
				return yield* decodeReply(answer)
			})
	}
	return driver
})
