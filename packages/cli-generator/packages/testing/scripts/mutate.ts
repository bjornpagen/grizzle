import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Console,
	Duration,
	Effect,
	FileSystem,
	Inspectable,
	Option,
	Order,
	Path,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { Command, Flag } from "effect/cli"
import { createFileSystemLayer, type FileSystemCallbacks, serverFS } from "typescript/fs"
import { API, DiagnosticCategory, type Diagnostic, type Snapshot } from "typescript/sync"
import {
	createVitest,
	ForksPoolWorker,
	type PoolOptions,
	type PoolRunnerInitializer,
	type Reporter,
	type TestRunResult,
	type Vitest
} from "vitest/node"
import { applied, type Mutant, mutantsOf, OPERATORS, type Operator } from "#mutants.ts"
import { fnv1a32, mix } from "#random.ts"
import {
	type OpenSuite,
	type RunVerdict,
	type TimedVerdict,
	timedRun,
	verdictWithin
} from "#vitest/mutant-verdict.ts"
import { type MutatedFile, type RealPath, realPathOf } from "#vitest/mutated-file.ts"

/**
 * `pnpm mutate --package <dir> --file <path>... [--workers N]`: measures a package's suite by source mutation, a
 * measurement and never a gate. A mutant is a value, a MutatedFile: one source file's canonical path and its mutated
 * text. Nothing is written to the checkout or anywhere else, and no second tree exists: the package's own tsconfig
 * is checked in process through TypeScript 7's native API, the target's text overlaid on one snapshot of the
 * unmutated program, and a mutant with a type error the unmutated program does not have is set aside as invalid; the
 * package's own Vitest config runs in process through Vitest's Node API, in the package's directory, stopped at its
 * first failing test, with the MutatedFile provided to every test process, where the library's mutated-setup.ts
 * hooks Node's module loader so every import of the target loads the mutated text. A failing test, or a test file
 * that no longer loads, kills the mutant; one every test passes on survives, naming behaviour no test pins; one whose
 * run takes ten times as long as the unmutated suite's run times out, however long its workers then take to stop.
 * Every mutant runs in a Vitest of its own, whose test files each run in a fresh process, so no process that loaded
 * one mutant's target loads another's; `--workers N` judges N mutants at once, each in its own Vitest. `--sample N`
 * judges N mutants drawn by `--seed`, which is also the suite's run seed; `--operator` and `--mutant` choose some;
 * `--list` prints them and runs nothing. A test that reads the target's source from disk, or loads it in a child
 * process of its own, sees the unmutated file.
 */
class MutationRunRefused extends Schema.TaggedError<
	MutationRunRefused,
	{ readonly brand: unique symbol }
>()("MutationRunRefused", { message: Schema.String }) {}

/** Diagnostics a mutant raises only by leaving code unused or unreachable: no type error. */
const UNUSED: ReadonlySet<number> = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7027])

/** How many times the unmutated suite's run a mutant's run may take before it times out. */
const DEADLINE_FACTOR = 10

/** A mutant's verdict: its run's, timed against its deadline, or invalid when its program has a type error. */
type Verdict = TimedVerdict | Readonly<{ kind: "invalid" }>

/** A mutant, and the file it makes of its target. */
type Candidate = Readonly<{ mutant: Mutant; mutated: MutatedFile }>

type Flags = Readonly<{
	package: string
	files: ReadonlyArray<string>
	seed: number
	sample: number
	operators: ReadonlyArray<Operator>
	mutants: ReadonlyArray<string>
	list: boolean
	workers: number
}>

const describe = (mutant: Mutant) =>
	`${mutant.id} ${mutant.file}:${String(mutant.line)}:${String(mutant.column)} ${mutant.operator} in ${mutant.fn}: ${Str.replaceAll("\n", " ")(mutant.original)} -> ${Str.replaceAll("\n", " ")(mutant.replacement)}`

const refused = (message: string) => (cause: unknown) =>
	MutationRunRefused.make({ message: `${message}: ${Inspectable.toStringUnknown(cause)}` })

/** The compiler reads the package from disk and writes nothing. */
const readOnlyHost: FileSystemCallbacks = {
	directoryExists: serverFS.useOS,
	fileExists: serverFS.useOS,
	getAccessibleEntries: serverFS.useOS,
	readFile: serverFS.useOS,
	realpath: serverFS.useOS,
	stat: serverFS.useOS,
	writeFile: serverFS.noop,
	removeFile: serverFS.noop
}

const diagnosticText = (diagnostic: Diagnostic) =>
	`${diagnostic.fileName ?? "(program)"}:${String((diagnostic.startPosition?.line ?? 0) + 1)}: TS${String(diagnostic.code)} ${diagnostic.text}`

/** A snapshot's errors in the package's program; a snapshot that holds no such program fails the run. */
const errorsOf = (snapshot: Snapshot, config: string) =>
	Effect.flatMap(
		Effect.try({
			try: () => snapshot.getConfiguredProject(config),
			catch: refused("the native compiler failed")
		}),
		(project) =>
			project === undefined
				? Effect.fail(
						MutationRunRefused.make({
							message: `the native compiler opened no project for ${config}`
						})
					)
				: Effect.try({
						try: () =>
							Arr.filter(
								[
									...project.program.getConfigFileParsingDiagnostics(),
									...project.program.getProgramDiagnostics(),
									...project.program.getGlobalDiagnostics(),
									...project.program.getSyntacticDiagnostics(),
									...project.program.getSemanticDiagnostics()
								],
								(diagnostic) => diagnostic.category === DiagnosticCategory.Error
							),
						catch: refused("the native compiler failed")
					})
	)

/**
 * The package's program, opened once in one native compiler session, and whether a mutant's program has a type error
 * the unmutated program does not: the unmutated snapshot with the target's text overlaid, in a snapshot of its own.
 * The unmutated program must have no error at all.
 */
const typecheckerOf = Effect.fnUntraced(function* (pkg: RealPath) {
	const path = yield* Path.Path
	const config = path.join(pkg, "tsconfig.json")
	const api = yield* Effect.acquireRelease(
		Effect.try({
			try: () => new API({ cwd: pkg, fs: readOnlyHost }),
			catch: refused("the native compiler did not start")
		}),
		(session) =>
			Effect.sync(() => {
				session.close()
			})
	)
	const unmutated = yield* Effect.acquireDisposable(
		Effect.try({
			try: () => api.createSnapshot({ openProjects: [config] }),
			catch: refused("the native compiler did not open the package")
		})
	)
	const baseline = yield* errorsOf(unmutated, config)
	if (Arr.isReadonlyArrayNonEmpty(baseline)) {
		return yield* MutationRunRefused.make({
			message: `the unmutated package does not typecheck:\n${Arr.join(Arr.map(baseline, diagnosticText), "\n")}`
		})
	}
	return (mutated: MutatedFile) =>
		Effect.scoped(
			Effect.flatMap(
				Effect.acquireDisposable(
					Effect.try({
						try: () =>
							unmutated.update({
								fileSystem: createFileSystemLayer([[mutated.target, mutated.text]]),
								ensurePrograms: true
							}),
						catch: refused("the native compiler did not overlay the mutant")
					})
				),
				(snapshot) =>
					Effect.map(errorsOf(snapshot, config), (errors) =>
						Arr.some(errors, (error) => !UNUSED.has(error.code))
					)
			)
		)
})

/** A run's output: none. Its verdict is read from the run's result, in memory. */
const silent: Reporter = {}

/** What a run of the suite says of its mutant: the first failing test, or a test file that no longer loads. */
const verdictOf = (result: TestRunResult): RunVerdict => {
	const failedTest = Arr.head(
		Arr.flatMap(result.testModules, (module) =>
			Arr.fromIterable(module.children.allTests("failed"))
		)
	)
	if (Option.isSome(failedTest)) {
		return { kind: "killed", by: failedTest.value.name }
	}
	const broken = Arr.findFirst(result.testModules, (module) => module.errors().length > 0)
	if (Option.isSome(broken)) {
		return { kind: "killed", by: `${broken.value.relativeModuleId} did not load` }
	}
	return Arr.isReadonlyArrayNonEmpty(result.unhandledErrors)
		? { kind: "killed", by: "an unhandled error" }
		: { kind: "survived" }
}

/**
 * A forks worker its run owns from the moment its process is forked (start forks before it awaits anything) to its
 * stop, so the run's release can end it whatever it is doing. Its stop is Vitest's own: SIGTERM, then SIGKILL once
 * ForksPoolWorker's grace has passed (Vitest's SIGKILL_TIMEOUT, 500 ms in Vitest 5.1), which is how long a worker that
 * ignores SIGTERM, one looping in a mutant, keeps running.
 */
class OwnedFork extends ForksPoolWorker {
	readonly #running: Set<OwnedFork>

	constructor(options: PoolOptions, running: Set<OwnedFork>) {
		super(options)
		this.#running = running
	}

	override start() {
		const started = super.start()
		this.#running.add(this)
		return started
	}

	override stop() {
		this.#running.delete(this)
		return super.stop()
	}
}

/** The name of the run's pool. */
const OWNED_FORKS = "owned-forks"

/** The run's pool: Vitest's forks, every worker owned by the run while it runs. */
const ownedForks = (running: Set<OwnedFork>): PoolRunnerInitializer => ({
	name: OWNED_FORKS,
	createPoolWorker: (options) => new OwnedFork(options, running)
})

/**
 * Every project of the run runs each test file in a fresh process of the run's own pool, so no process that loaded one
 * mutant's target loads another's, and the run's release ends every one.
 */
const ownedFreshProcesses = (vitest: Vitest) => {
	const unowned = Arr.filter(
		vitest.projects,
		(project) => project.config.pool !== OWNED_FORKS || !project.config.isolate
	)
	return Arr.isReadonlyArrayNonEmpty(unowned)
		? Effect.fail(
				MutationRunRefused.make({
					message: `a mutant's run needs every test file in a fresh process of its own pool, and ${Arr.join(
						Arr.map(unowned, (project) => project.name),
						", "
					)} runs elsewhere`
				})
			)
		: Effect.void
}

/**
 * The package's suite, open for the enclosing scope in a Vitest of its own on a pool it owns, with `mutated` provided
 * to every test process. Its run, the suite to its first failing test, is the verdict. Closing the scope is its release,
 * however the run ended, finished, failed, past its deadline or interrupted: it stops every worker still running
 * (SIGTERM, then SIGKILL once Vitest's SIGKILL_TIMEOUT has passed) and then closes the Vitest, whose close waits for the
 * run in flight and so never ends a hung worker, and at most Vitest's STOP_TIMEOUT for a worker it was already
 * stopping. The release follows the verdict and never decides it.
 */
const suiteOf =
	(pkg: RealPath, setup: string, seed: number) =>
	(mutated: MutatedFile): OpenSuite<MutationRunRefused> =>
		Effect.suspend(() => {
			const running = new Set<OwnedFork>()
			return Effect.acquireRelease(
				Effect.tryPromise({
					try: () =>
						createVitest(
							{
								root: pkg,
								watch: false,
								bail: 1,
								reporters: [silent],
								env: { TEST_SEED: String(seed) },
								provide: { "superstarter.testing.mutated": mutated }
							},
							{ test: { setupFiles: [setup], pool: ownedForks(running) } }
						),
					catch: refused("Vitest did not start")
				}),
				(vitest) =>
					Effect.andThen(
						Effect.forEach(Arr.fromIterable(running), (fork) => Effect.promise(() => fork.stop()), {
							concurrency: "unbounded",
							discard: true
						}),
						Effect.promise(() => vitest.close())
					)
			).pipe(
				Effect.tap(ownedFreshProcesses),
				Effect.map((vitest) =>
					Effect.map(
						Effect.tryPromise({
							try: () => vitest.start(),
							catch: refused("the suite did not run")
						}),
						verdictOf
					)
				)
			)
		})

/**
 * A run that judged every mutant exits 0: the measurement succeeded, whatever exit status the suites it ran in process
 * left behind (Vitest sets 1 after every failing run, which is every killed mutant's).
 */
const judgedEvery = Effect.sync(() => {
	process.exitCode = 0
})

const run = Effect.fn("testing.mutate.run")(function* (flags: Flags) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const pkg = yield* realPathOf(flags.package)
	const sources = yield* Effect.forEach(flags.files, (file) =>
		Effect.gen(function* () {
			const target = yield* realPathOf(path.join(pkg, file))
			const text = yield* fs.readFileString(target)
			return { file, target, text }
		})
	)
	const perFile = yield* Effect.forEach(sources, (source) =>
		Effect.map(
			mutantsOf([source]),
			Arr.map((mutant): Candidate => ({
				mutant,
				mutated: { target: source.target, text: applied(mutant) }
			}))
		)
	)
	const every = Arr.flatten(perFile)
	const wanted: ReadonlySet<Operator> = new Set(
		flags.operators.length === 0 ? OPERATORS : flags.operators
	)
	const chosen = Arr.filter(
		every,
		({ mutant }) =>
			wanted.has(mutant.operator) &&
			(flags.mutants.length === 0 || Arr.contains(flags.mutants, mutant.id))
	)
	const ranked = Arr.sort(
		chosen,
		Order.mapInput(Order.Number, ({ mutant }: Candidate) => mix(flags.seed ^ fnv1a32(mutant.id)))
	)
	const population = flags.sample > 0 ? Arr.take(ranked, flags.sample) : chosen
	if (flags.list) {
		yield* Effect.forEach(population, ({ mutant }) => Console.log(describe(mutant)), {
			discard: true
		})
		return
	}
	const first = Arr.head(sources)
	if (population.length === 0 || Option.isNone(first)) {
		return yield* MutationRunRefused.make({
			message: "no mutant matches the chosen files, operators and ids"
		})
	}
	const mistyped = yield* typecheckerOf(pkg)
	const setupUrl = yield* Effect.try({
		try: () => new URL(import.meta.resolve("#vitest/mutated-setup.ts")),
		catch: refused("the mutation setup file did not resolve")
	})
	const setup = yield* path.fromFileUrl(setupUrl)
	const suite = suiteOf(pkg, setup, flags.seed)
	const [unmutatedTime, unmutated] = yield* timedRun(
		suite({ target: first.value.target, text: first.value.text })
	)
	if (unmutated.kind !== "survived") {
		return yield* MutationRunRefused.make({
			message: `the unmutated package's suite does not pass: ${unmutated.by}`
		})
	}
	const deadline = Duration.times(unmutatedTime, DEADLINE_FACTOR)
	yield* Console.log(
		`mutate: ${String(population.length)} of ${String(every.length)} mutants of ${Arr.join(flags.files, ", ")}, TEST_SEED=${String(flags.seed)}, ${String(flags.workers)} at once`
	)
	/** One mutant: invalid when its program has a type error, otherwise its run's verdict, or a timeout when its run
	 * passes the deadline. */
	const judge = ({ mutant, mutated }: Candidate, at: number) =>
		Effect.gen(function* () {
			const invalid = yield* mistyped(mutated)
			if (invalid) {
				return { kind: "invalid" } satisfies Verdict
			}
			return yield* verdictWithin(suite(mutated), deadline)
		}).pipe(
			Effect.tap((verdict) =>
				Console.log(
					`[${String(at + 1)}/${String(population.length)}] ${mutant.id} ${mutant.file}:${String(mutant.line)} ${mutant.operator} ${verdict.kind}${verdict.kind === "killed" ? ` by "${verdict.by}"` : ""}`
				)
			),
			Effect.map((verdict) => ({ mutant, verdict }))
		)
	const results = yield* Effect.forEach(population, judge, { concurrency: flags.workers })
	const count = (kind: Verdict["kind"]) =>
		Arr.filter(results, ({ verdict }) => verdict.kind === kind).length
	const valid = results.length - count("invalid")
	yield* Console.log(
		`\nmutate: ${String(count("killed"))} killed, ${String(count("survived"))} survived, ${String(count("timeout"))} timed out, ${String(count("invalid"))} invalid; score ${String(count("killed"))}/${String(valid)}`
	)
	const killers = Arr.groupBy(
		Arr.flatMap(results, ({ verdict }) => (verdict.kind === "killed" ? [verdict.by] : [])),
		(by) => by
	)
	yield* Effect.forEach(
		Rec.toEntries(killers),
		([by, killed]) => Console.log(`  killed by "${by}": ${String(killed.length)}`),
		{ discard: true }
	)
	yield* Effect.forEach(
		Arr.filter(results, ({ verdict }) => verdict.kind === "survived" || verdict.kind === "timeout"),
		({ mutant, verdict }) => Console.log(`${Str.toUpperCase(verdict.kind)} ${describe(mutant)}`),
		{ discard: true }
	)
	yield* judgedEvery
}, Effect.scoped)

const mutate = Command.make(
	"mutate",
	{
		package: Flag.String("package"),
		files: Flag.String("file").pipe(Flag.atLeast(1)),
		seed: Flag.Int("seed").pipe(Flag.withDefault(1)),
		sample: Flag.Int("sample").pipe(Flag.withDefault(0)),
		operators: Flag.Literals("operator", OPERATORS).pipe(Flag.atLeast(0)),
		mutants: Flag.String("mutant").pipe(Flag.atLeast(0)),
		list: Flag.Boolean("list").pipe(Flag.withDefault(false)),
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
			MutationRunRefused: (runRefused) => refusedWith(runRefused.message),
			MutationSourceRefused: (sourceRefused) =>
				refusedWith(`the compiler did not read ${sourceRefused.file} as a source file`)
		}),
		Effect.provide(NodeServices.layer)
	)
)
