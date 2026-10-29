import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Console,
	Duration,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	Pool,
	Record as Rec,
	Ref,
	Schema,
	String as Str
} from "effect"
import { Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { applied, type Mutant, mutantsOf, OPERATORS, type Operator } from "#mutants.ts"
import { fnv1a32, mix } from "#random.ts"

/**
 * `pnpm mutate --package <dir> --file <path>... [--config <vitest config>] [--workers N]`: measures a package's suite by
 * source mutation, a measurement and never a gate. Every mutant of the named files (mutants.ts) is judged in a copy of
 * the package in a temporary directory, never in the checkout, so a run killed mid-mutant leaves nothing mutated and
 * people and agents working in the checkout never see a mutant: the package's `typecheck` script sets aside one the
 * compiler refuses as invalid, the package's Vitest run (`--bail=1`) kills one some test fails on, and one every test
 * passes on survives, naming behaviour no test pins. A copy holds the package's own files, links its `node_modules` and
 * dot directories, and extends the original tsconfig's base by absolute path; the workspace's `node_modules` is linked
 * beside the copies, so a module resolves from a copy as it does from the package. `--workers N` judges N mutants at
 * once, each in a copy of its own. `--sample N` judges N mutants drawn by `--seed`; `--operator` and `--mutant` choose some;
 * `--list` prints them and runs nothing.
 */
class MutationRunRefused extends Schema.TaggedError<
	MutationRunRefused,
	{ readonly brand: unique symbol }
>()("MutationRunRefused", { message: Schema.String }) {}

/** Diagnostics a mutant raises only by leaving code unused or unreachable: no type error. */
const UNUSED: ReadonlySet<string> = new Set([
	"TS6133",
	"TS6138",
	"TS6192",
	"TS6196",
	"TS6198",
	"TS6199",
	"TS6205",
	"TS7027"
])

const DIAGNOSTIC = regex("error (TS[0-9]+)")

/** A package's tsconfig: the base it extends, by a path relative to the package, and whatever else it sets. */
const PackageTsconfig = Schema.fromJsonString(
	Schema.StructWithRest(Schema.Struct({ extends: Schema.String }), [
		Schema.Record(Schema.String, Schema.Unknown)
	])
)

/** What a Vitest JSON report says of its tests: each test's title and status. */
const SuiteReport = Schema.fromJsonString(
	Schema.Struct({
		testResults: Schema.Array(
			Schema.Struct({
				assertionResults: Schema.Array(
					Schema.Struct({ title: Schema.String, status: Schema.String })
				)
			})
		)
	})
)

type Verdict = "killed" | "survived" | "invalid" | "timeout"

type Outcome =
	| Readonly<{ verdict: "killed"; by: string }>
	| Readonly<{ verdict: Exclude<Verdict, "killed"> }>

type Flags = Readonly<{
	package: string
	files: ReadonlyArray<string>
	config: string
	seed: number
	sample: number
	operators: ReadonlyArray<Operator>
	mutants: ReadonlyArray<string>
	list: boolean
	timeout: number
	workers: number
}>

/** The workspace a package sits in: the nearest directory above it with a `pnpm-workspace.yaml`. */
const rootOf = Effect.fn("testing.mutate.root")(function* (
	from: string
): Effect.fn.Return<
	string,
	MutationRunRefused | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	if (yield* fs.exists(path.join(from, "pnpm-workspace.yaml"))) {
		return from
	}
	const parent = path.dirname(from)
	if (parent === from) {
		return yield* MutationRunRefused.make({ message: "the package sits in no pnpm workspace" })
	}
	return yield* rootOf(parent)
})

const describe = (mutant: Mutant) =>
	`${mutant.id} ${mutant.file}:${String(mutant.line)}:${String(mutant.column)} ${mutant.operator} in ${mutant.fn}: ${Str.replaceAll("\n", " ")(mutant.original)} -> ${Str.replaceAll("\n", " ")(mutant.replacement)}`

const run = Effect.fn("testing.mutate.run")(function* (flags: Flags) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const pkg = path.resolve(flags.package)
	const sources = yield* Effect.forEach(flags.files, (file) =>
		Effect.map(fs.readFileString(path.join(pkg, file)), (text) => ({ file, text }))
	)
	const every = yield* mutantsOf(sources)
	const wanted: ReadonlySet<Operator> = new Set(
		flags.operators.length === 0 ? OPERATORS : flags.operators
	)
	const chosen = Arr.filter(
		every,
		(m) =>
			wanted.has(m.operator) && (flags.mutants.length === 0 || Arr.contains(flags.mutants, m.id))
	)
	const ranked = Arr.sort(
		chosen,
		Order.mapInput(Order.Number, (m: Mutant) => mix(flags.seed ^ fnv1a32(m.id)))
	)
	const population = flags.sample > 0 ? Arr.take(ranked, flags.sample) : chosen
	if (flags.list) {
		yield* Effect.forEach(population, (m) => Console.log(describe(m)), { discard: true })
		return
	}
	if (population.length === 0) {
		return yield* MutationRunRefused.make({
			message: "no mutant matches the chosen files, operators and ids"
		})
	}

	const workspace = yield* rootOf(pkg)
	const searchPath = `${path.join(workspace, "node_modules", ".bin")}:${yield* Config.String("PATH")}`
	const runDir = yield* fs.realPath(
		yield* fs.makeTempDirectoryScoped({ prefix: "testing-mutate-" })
	)
	yield* fs.symlink(path.join(workspace, "node_modules"), path.join(runDir, "node_modules"))
	const entries = yield* fs.readDirectory(pkg)
	const tsconfig = yield* Effect.flatMap(
		fs.readFileString(path.join(pkg, "tsconfig.json")),
		Schema.decodeEffect(PackageTsconfig)
	)
	const rebased = yield* Schema.encodeEffect(PackageTsconfig)({
		...tsconfig,
		extends: path.resolve(pkg, tsconfig.extends)
	})
	const made = yield* Ref.make(0)
	/** A fresh copy of the package: its own files copied, and what it only reads linked. */
	const copy = Effect.gen(function* () {
		const tree = path.join(runDir, `copy-${String(yield* Ref.getAndUpdate(made, (n) => n + 1))}`)
		yield* fs.makeDirectory(tree)
		yield* Effect.forEach(
			entries,
			(entry) =>
				entry === "node_modules" || Str.startsWith(".")(entry)
					? fs.symlink(path.join(pkg, entry), path.join(tree, entry))
					: fs.copy(path.join(pkg, entry), path.join(tree, entry)),
			{ discard: true }
		)
		yield* fs.writeFileString(path.join(tree, "tsconfig.json"), rebased)
		return tree
	})
	const copies = yield* Pool.make({ acquire: copy, size: flags.workers })

	/** A copy's type errors, those that only leave code unused or unreachable aside. */
	const typeErrors = (tree: string) =>
		Effect.map(
			spawner.string(
				ChildProcess.make("pnpm", ["-s", "run", "typecheck"], {
					cwd: tree,
					env: { PATH: searchPath },
					extendEnv: true,
					stdin: "ignore"
				})
			),
			(output) =>
				Arr.filter(
					Str.split(output, "\n"),
					(line) =>
						Str.includes("error TS")(line) &&
						!Option.exists(Option.fromNullishOr(DIAGNOSTIC.exec(line)), (code) =>
							UNUSED.has(code[1])
						)
				)
		)
	/** A copy's suite, stopped at its first failing test, which kills the mutant. */
	const suite = (tree: string) =>
		Effect.gen(function* () {
			const report = `${tree}.json`
			yield* fs.remove(report, { force: true })
			const handle = yield* spawner.spawn(
				ChildProcess.make(
					"pnpm",
					[
						"-s",
						"exec",
						"vitest",
						"run",
						"--config",
						flags.config,
						"--bail=1",
						"--reporter=json",
						`--outputFile=${report}`
					],
					{
						cwd: tree,
						env: { TEST_SEED: String(flags.seed), PATH: searchPath },
						extendEnv: true,
						stdin: "ignore",
						stdout: "ignore",
						stderr: "ignore",
						killSignal: "SIGKILL"
					}
				)
			)
			const passed = yield* Effect.match(handle.exitCode, {
				onFailure: () => false,
				onSuccess: (code) => code === ChildProcessSpawner.ExitCode(0)
			})
			const failed = (yield* fs.exists(report))
				? yield* Effect.map(
						Effect.flatMap(fs.readFileString(report), Schema.decodeEffect(SuiteReport)),
						({ testResults }) =>
							Arr.findFirst(
								Arr.flatMap(testResults, ({ assertionResults }) => assertionResults),
								({ status }) => status === "failed"
							)
					)
				: Option.none()
			return Option.match(failed, {
				onSome: ({ title }): Outcome => ({ verdict: "killed", by: title }),
				onNone: (): Outcome => ({ verdict: passed ? "survived" : "timeout" })
			})
		}).pipe(
			Effect.scoped,
			Effect.timeoutOption(Duration.seconds(flags.timeout)),
			Effect.map(Option.getOrElse((): Outcome => ({ verdict: "timeout" })))
		)

	yield* Effect.scoped(
		Effect.gen(function* () {
			const tree = yield* Pool.get(copies)
			const baseline = yield* typeErrors(tree)
			if (baseline.length > 0) {
				return yield* MutationRunRefused.make({
					message: `the unmutated package does not typecheck:\n${Arr.join(baseline, "\n")}`
				})
			}
			const unmutated = yield* suite(tree)
			if (unmutated.verdict !== "survived") {
				return yield* MutationRunRefused.make({
					message: "the unmutated package's suite does not pass"
				})
			}
		})
	)
	yield* Console.log(
		`mutate: ${String(population.length)} of ${String(every.length)} mutants of ${Arr.join(flags.files, ", ")}, TEST_SEED=${String(flags.seed)}, ${String(flags.workers)} at once`
	)
	/** One mutant written into a copy of its own, its file put back whatever the verdict. */
	const judge = (mutant: Mutant, at: number) =>
		Effect.scoped(
			Effect.flatMap(Pool.get(copies), (tree) =>
				Effect.acquireUseRelease(
					fs.writeFileString(path.join(tree, mutant.file), applied(mutant)),
					() =>
						Effect.flatMap(typeErrors(tree), (errors) =>
							errors.length > 0 ? Effect.succeed<Outcome>({ verdict: "invalid" }) : suite(tree)
						),
					() => fs.writeFileString(path.join(tree, mutant.file), mutant.source).pipe(Effect.orDie)
				)
			)
		).pipe(
			Effect.tap((outcome) =>
				Console.log(
					`[${String(at + 1)}/${String(population.length)}] ${mutant.id} ${mutant.file}:${String(mutant.line)} ${mutant.operator} ${outcome.verdict}${outcome.verdict === "killed" ? ` by "${outcome.by}"` : ""}`
				)
			),
			Effect.map((outcome) => ({ mutant, outcome }))
		)
	const results = yield* Effect.forEach(population, judge, { concurrency: flags.workers })
	const count = (verdict: Verdict) =>
		Arr.filter(results, ({ outcome }) => outcome.verdict === verdict).length
	const valid = results.length - count("invalid")
	yield* Console.log(
		`\nmutate: ${String(count("killed"))} killed, ${String(count("survived"))} survived, ${String(count("timeout"))} timed out, ${String(count("invalid"))} invalid; score ${String(count("killed"))}/${String(valid)}`
	)
	const killers = Arr.groupBy(
		Arr.flatMap(results, ({ outcome }) => (outcome.verdict === "killed" ? [outcome.by] : [])),
		(by) => by
	)
	yield* Effect.forEach(
		Rec.toEntries(killers),
		([by, killed]) => Console.log(`  killed by "${by}": ${String(killed.length)}`),
		{ discard: true }
	)
	yield* Effect.forEach(
		Arr.filter(
			results,
			({ outcome }) => outcome.verdict === "survived" || outcome.verdict === "timeout"
		),
		({ mutant, outcome }) => Console.log(`${Str.toUpperCase(outcome.verdict)} ${describe(mutant)}`),
		{ discard: true }
	)
}, Effect.scoped)

const mutate = Command.make(
	"mutate",
	{
		package: Flag.String("package"),
		files: Flag.String("file").pipe(Flag.atLeast(1)),
		config: Flag.String("config").pipe(Flag.withDefault("vitest.config.ts")),
		seed: Flag.Int("seed").pipe(Flag.withDefault(1)),
		sample: Flag.Int("sample").pipe(Flag.withDefault(0)),
		operators: Flag.Literals("operator", OPERATORS).pipe(Flag.atLeast(0)),
		mutants: Flag.String("mutant").pipe(Flag.atLeast(0)),
		list: Flag.Boolean("list").pipe(Flag.withDefault(false)),
		timeout: Flag.Int("timeout").pipe(Flag.withDefault(300)),
		workers: Flag.Int("workers").pipe(Flag.withDefault(1))
	},
	run
)

const refusedWith = (message: string) =>
	Effect.andThen(
		Effect.sync(() => {
			process.exitCode = 1
		}),
		Console.error(`\n${message}`)
	)

NodeRuntime.runMain(
	Command.run(mutate, { version: "source" }).pipe(
		Effect.catchTags({
			MutationRunRefused: (refused) => refusedWith(refused.message),
			MutationSourceRefused: (refused) =>
				refusedWith(`the compiler did not read ${refused.file} as a source file`)
		}),
		Effect.provide(NodeServices.layer)
	)
)
