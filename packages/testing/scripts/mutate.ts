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
	Result,
	Schema,
	String as Str
} from "effect"
import { Command, Flag } from "effect/cli"
import { createFileSystemLayer, type FileSystemCallbacks, serverFS } from "typescript/fs"
import { API, DiagnosticCategory, type Diagnostic, type Snapshot } from "typescript/sync"
import type { Plugin } from "vite"
import {
	createVitest,
	ForksPoolWorker,
	type PoolOptions,
	type PoolRunnerInitializer,
	type Reporter,
	type TestRunResult,
	type Vitest
} from "vitest/node"
import {
	applied,
	type KeptMutant,
	keptApplied,
	type Mutant,
	mutantsOf,
	noFamilies,
	OPERATORS,
	type Operator
} from "#mutants.ts"
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
 * `pnpm mutate --package <dir> --file <path>... [--test <path>...] [--workers N]`, or `pnpm mutate --package <dir>
 * --kept <file.json>`: measures a package's suite by source mutation, a measurement and never a gate. A package that has
 * this library in its node_modules runs the same tester as `grizzle-mutate`, the package's bin (scripts/mutate.sh),
 * with the same flags. A mutant is a value, a MutatedFile: one source file's canonical path and its mutated text.
 * Nothing is written to the checkout or anywhere else, and no second tree exists: the package's own tsconfig is checked
 * in process through TypeScript 7's native API, the target's text overlaid on one snapshot of the unmutated program,
 * and a mutant with a type error the unmutated program does not have is set aside as invalid; the package's own Vitest
 * config runs in process through Vitest's Node API, in the package's directory, stopped at its first failing test, with
 * the MutatedFile in every place a test's import of the target can be loaded from: a Vite plugin that serves the
 * mutated text in place of the file, for a suite that loads its modules through Vite's module runner, and a setup file
 * that hooks Node's module loader in every test process (mutated-setup.ts), for one that loads them as Node does, with
 * Vitest's module cache on disk off, since it keys a module by the file it reads. `--test` names the test files every
 * run runs, the unmutated one included, which must pass: a package whose whole suite is not green measures a file by
 * the tests that are its own. Before any mutant, each target's probe runs, a mutant that throws as soon as the module
 * loads, which the suite must kill: one that survives means no test of the run loaded the mutated text, so every mutant
 * would survive unseen, and the run refuses. A failing test, or a test file that no longer loads, kills a mutant; one
 * every test passes on survives, naming behaviour no test pins; one whose run takes ten times as long as the unmutated
 * suite's run times out, however long its workers then take to stop. Every mutant runs in a Vitest of its own, whose
 * test files each run in a fresh process, so no process that loaded one mutant's target loads another's; `--workers N`
 * judges N mutants at once, each in its own Vitest. `--sample N` judges N mutants drawn by `--seed`, which is also the
 * suite's run seed; `--operator` and `--mutant` choose some; `--list` prints them and runs nothing. `--kept
 * <file.json>` runs instead the kept mutants the file lists, each a hand-written `KeptMutant` (its name, its file, the
 * original text it replaces once, its replacement and the test files that must kill it), against those test files
 * alone, each after its file's probe against them: a kept mutant whose original no longer stands once in its file is
 * stale, and one its killers pass on survived, the measurement "revert the fix and see the test fail" asks for, run on
 * every call and never written to the tree. A test that reads the target's source from disk, or loads it in a child
 * process of its own, sees the unmutated file.
 */
class MutationRunRefused extends Schema.TaggedError<
	MutationRunRefused,
	{ readonly brand: unique symbol }
>()("MutationRunRefused", { message: Schema.String }) {}

/**
 * A target's probe, a mutant that throws as its module loads, was not killed: no test of the run loaded the mutated text
 * the tester gives it, so every mutant of the target would survive unseen, and the run refuses before judging any.
 */
class MutationProbeSurvived extends Schema.TaggedError<
	MutationProbeSurvived,
	{ readonly brand: unique symbol }
>()("MutationProbeSurvived", {
	target: Schema.String,
	verdict: Schema.Literals(["survived", "timeout"]),
	message: Schema.String
}) {}

/** Diagnostics a mutant raises only by leaving code unused or unreachable: no type error. */
const UNUSED: ReadonlySet<number> = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7027])

/** How many times the unmutated suite's run a mutant's run may take before it times out. */
const DEADLINE_FACTOR = 10

/**
 * A mutant's verdict: its run's, timed against its deadline, invalid when its program has a type error, or stale when
 * it is a kept mutant whose original no longer stands once in its file.
 */
type Verdict = TimedVerdict | Readonly<{ kind: "invalid" }> | Readonly<{ kind: "stale" }>

/** A mutant, and the file it makes of its target. */
type Candidate = Readonly<{ mutant: Mutant<Operator>; mutated: MutatedFile }>

/** The file of kept mutants `--kept` names: JSON, a list of `KeptMutant`s. */
const KeptMutants = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			name: Schema.String,
			file: Schema.String,
			original: Schema.String,
			replacement: Schema.String,
			killers: Schema.NonEmptyArray(Schema.String)
		})
	)
)

type Flags = Readonly<{
	package: string
	files: ReadonlyArray<string>
	tests: ReadonlyArray<string>
	kept: Option.Option<string>
	seed: number
	sample: number
	operators: ReadonlyArray<Operator>
	mutants: ReadonlyArray<string>
	list: boolean
	workers: number
}>

const describe = (mutant: Mutant<Operator>) =>
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

/**
 * The Vite plugin that serves a mutant's text in place of its target's, for a suite whose test processes load their
 * modules through Vite's module runner: Vite reads every such module in the run's own process, through its plugins,
 * where no Node loader hook of a test process reaches. It runs before every other plugin, and the run's Vite transforms
 * what it serves as it would the file.
 */
const mutantPlugin = (mutated: MutatedFile): Plugin => ({
	name: "grizzle-testing-mutant",
	enforce: "pre",
	load: (id) => (Arr.headNonEmpty(Str.split(id, "?")) === mutated.target ? mutated.text : undefined)
})

/**
 * A target's probe: its text with a statement after it that throws as the module finishes loading, so any test that
 * loads the mutated text fails, and the suite kills it whatever the target does.
 */
const probeOf = (target: RealPath, text: string): MutatedFile => ({
	target,
	text: `${text}\n;throw new Error("the mutation tester's probe: this module was loaded with the mutated text the tester gave it")\n`
})

/**
 * Refuses the run unless `target`'s probe is killed by `files`, which must load it with the mutated text the run
 * gives it: a probe that survives means no test of the run loaded that text, so every mutant of it would survive unseen.
 */
const probed = (
	suite: (mutated: MutatedFile, files: ReadonlyArray<string>) => OpenSuite<MutationRunRefused>,
	target: RealPath,
	text: string,
	files: ReadonlyArray<string>,
	deadline: Duration.Duration
) =>
	Effect.flatMap(verdictWithin(suite(probeOf(target, text), files), deadline), (verdict) =>
		verdict.kind === "killed"
			? Effect.void
			: Effect.fail(
					MutationProbeSurvived.make({
						target,
						verdict: verdict.kind,
						message: `the probe of ${target}, a mutant that throws as soon as the module loads, ${verdict.kind === "survived" ? "survived" : "timed out"}: no test of this run loaded the text the tester gives it, so every mutant of it would survive unseen. Name the tests that import it with --test; a suite whose modules load neither through Node's loader nor through the Vite server of the run's own config, which is where the tester gives them its text (a project with a Vite server of its own does not have the tester's plugin), cannot be measured`
					})
				)
	)

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
 * to every test process and served by the run's Vite (mutantPlugin), and no module cache on disk. Its run, the suite's
 * given test files, or all of them, to its first failing test, is the verdict. Closing the scope is its release,
 * however the run ended, finished, failed, past its deadline or interrupted: it stops every worker still running
 * (SIGTERM, then SIGKILL once Vitest's SIGKILL_TIMEOUT has passed) and then closes the Vitest, whose close waits for the
 * run in flight and so never ends a hung worker, and at most Vitest's STOP_TIMEOUT for a worker it was already
 * stopping. The release follows the verdict and never decides it.
 */
const suiteOf =
	(pkg: RealPath, setup: string, seed: number) =>
	(mutated: MutatedFile, files: ReadonlyArray<string>): OpenSuite<MutationRunRefused> =>
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
								fsModuleCache: false,
								env: { TEST_SEED: String(seed) },
								provide: { "grizzle.testing.mutated": mutated }
							},
							{
								plugins: [mutantPlugin(mutated)],
								test: { setupFiles: [setup], pool: ownedForks(running) }
							}
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
							try: () => vitest.start(Arr.copy(files)),
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

/**
 * The kept mutants `keptFile` lists, each run against its killers alone: stale when its original no longer stands once
 * in its file, invalid when its program has a type error, and otherwise its killers' verdict, timed against ten times
 * their unmutated run, which must pass, once its file's probe against the same killers was killed (probed).
 */
const keptRun = Effect.fn("testing.mutate.kept")(function* (
	pkg: RealPath,
	keptFile: string,
	seed: number
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const listed = yield* fs.readFileString(keptFile)
	const kept: ReadonlyArray<KeptMutant> = yield* Schema.decodeEffect(KeptMutants)(listed).pipe(
		Effect.mapError(refused(`${keptFile} is no list of kept mutants`))
	)
	const mistyped = yield* typecheckerOf(pkg)
	const setupUrl = yield* Effect.try({
		try: () => new URL(import.meta.resolve("#vitest/mutated-setup.ts")),
		catch: refused("the mutation setup file did not resolve")
	})
	const setup = yield* path.fromFileUrl(setupUrl)
	const suite = suiteOf(pkg, setup, seed)
	const probedFiles = new Set<string>()
	yield* Console.log(
		`mutate: ${String(kept.length)} kept mutants of ${keptFile}, TEST_SEED=${String(seed)}`
	)
	const judged = yield* Effect.forEach(kept, (mutant) =>
		Effect.gen(function* () {
			const target = yield* realPathOf(path.join(pkg, mutant.file))
			const original = yield* fs.readFileString(target)
			const mutatedText = keptApplied(mutant, original)
			if (Result.isFailure(mutatedText)) {
				yield* Console.log(`STALE ${mutant.name}: ${mutatedText.failure.message}`)
				const stale: Verdict = { kind: "stale" }
				return stale
			}
			const [unmutatedTime, unmutated] = yield* timedRun(
				suite({ target, text: original }, mutant.killers)
			)
			if (unmutated.kind !== "survived") {
				return yield* MutationRunRefused.make({
					message: `${mutant.name}: its killers fail on the unmutated package: ${unmutated.by}`
				})
			}
			const deadline = Duration.times(unmutatedTime, DEADLINE_FACTOR)
			const probe = Arr.join([target, ...mutant.killers], "\u0000")
			if (!probedFiles.has(probe)) {
				yield* probed(suite, target, original, mutant.killers, deadline)
				probedFiles.add(probe)
			}
			const mutated: MutatedFile = { target, text: mutatedText.success }
			const invalid = yield* mistyped(mutated)
			const verdict: Verdict = invalid
				? { kind: "invalid" }
				: yield* verdictWithin(suite(mutated, mutant.killers), deadline)
			yield* Console.log(
				`${mutant.name} ${mutant.file} ${verdict.kind}${verdict.kind === "killed" ? ` by "${verdict.by}"` : ""}`
			)
			return verdict
		})
	)
	const count = (kind: Verdict["kind"]) =>
		Arr.filter(judged, (verdict) => verdict.kind === kind).length
	yield* Console.log(
		`\nmutate: ${String(count("killed"))} killed, ${String(count("survived"))} survived, ${String(count("timeout"))} timed out, ${String(count("invalid"))} invalid, ${String(count("stale"))} stale, of ${String(kept.length)} kept mutants`
	)
	yield* judgedEvery
})

const run = Effect.fn("testing.mutate.run")(function* (flags: Flags) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const pkg = yield* realPathOf(flags.package)
	if (Option.isSome(flags.kept)) {
		return yield* keptRun(pkg, flags.kept.value, flags.seed)
	}
	if (!Arr.isReadonlyArrayNonEmpty(flags.files)) {
		return yield* MutationRunRefused.make({
			message: "name the files to mutate with --file, or the kept mutants to run with --kept"
		})
	}
	const sources = yield* Effect.forEach(flags.files, (file) =>
		Effect.gen(function* () {
			const target = yield* realPathOf(path.join(pkg, file))
			const text = yield* fs.readFileString(target)
			return { file, target, text }
		})
	)
	const perFile = yield* Effect.forEach(sources, (source) =>
		Effect.map(
			mutantsOf([source], noFamilies),
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
		suite({ target: first.value.target, text: first.value.text }, flags.tests)
	)
	if (unmutated.kind !== "survived") {
		return yield* MutationRunRefused.make({
			message: `the unmutated package's ${Arr.isReadonlyArrayNonEmpty(flags.tests) ? `tests ${Arr.join(flags.tests, ", ")}` : "suite"} do not pass: ${unmutated.by}; name the tests that pass and pin the files with --test`
		})
	}
	const deadline = Duration.times(unmutatedTime, DEADLINE_FACTOR)
	yield* Effect.forEach(
		sources,
		(source) => probed(suite, source.target, source.text, flags.tests, deadline),
		{ discard: true }
	)
	yield* Console.log(
		`mutate: ${String(population.length)} of ${String(every.length)} mutants of ${Arr.join(flags.files, ", ")}, against ${Arr.isReadonlyArrayNonEmpty(flags.tests) ? Arr.join(flags.tests, ", ") : "the whole suite"}, TEST_SEED=${String(flags.seed)}, ${String(flags.workers)} at once`
	)
	/** One mutant: invalid when its program has a type error, otherwise its run's verdict, or a timeout when its run
	 * passes the deadline. */
	const judge = ({ mutant, mutated }: Candidate, at: number) =>
		Effect.gen(function* () {
			const invalid = yield* mistyped(mutated)
			if (invalid) {
				return { kind: "invalid" } satisfies Verdict
			}
			return yield* verdictWithin(suite(mutated, flags.tests), deadline)
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
		files: Flag.String("file").pipe(Flag.atLeast(0)),
		tests: Flag.String("test").pipe(Flag.atLeast(0)),
		kept: Flag.String("kept").pipe(Flag.optional),
		seed: Flag.Int("seed").pipe(Flag.withDefault(1)),
		sample: Flag.Int("sample").pipe(Flag.withDefault(0)),
		operators: Flag.Literals("operator", OPERATORS).pipe(Flag.atLeast(0)),
		mutants: Flag.String("mutant").pipe(Flag.atLeast(0)),
		list: Flag.Boolean("list").pipe(Flag.withDefault(false)),
		workers: Flag.Int("workers").pipe(Flag.withDefault(1))
	},
	run
)

/** A refused run's last line, `<tag>: <why>`, its tag first so a caller reads which refusal it was, and exit code 1. */
const refusedWith = (tag: string, message: string) =>
	Effect.andThen(
		Effect.sync(() => {
			process.exitCode = 1
		}),
		Console.error(`\n${tag}: ${message}`)
	)

NodeRuntime.runMain(
	Command.run(mutate, { version: "source" }).pipe(
		Effect.catchTags({
			MutationRunRefused: (runRefused) => refusedWith(runRefused._tag, runRefused.message),
			MutationProbeSurvived: (probe) => refusedWith(probe._tag, probe.message),
			MutationSourceRefused: (sourceRefused) =>
				refusedWith(
					sourceRefused._tag,
					`the compiler did not read ${sourceRefused.file} as a source file`
				)
		}),
		Effect.provide(NodeServices.layer)
	)
)
