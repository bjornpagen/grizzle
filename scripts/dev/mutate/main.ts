#!/usr/bin/env -S node
import { availableParallelism } from "node:os"
import { parseArgs } from "node:util"
import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import { runDevtool } from "@bjornpagen/devtools/run"
import { shuffled } from "@bjornpagen/testing/gen"
import { applied, type Mutant as LibraryMutant, mutantsOf } from "@bjornpagen/testing/mutants"
import { wordsOf } from "@bjornpagen/testing/random"
import { generate, randomChooser, recorder } from "@bjornpagen/testing/source"
import { regex } from "arkregex"
import {
	Array as Arr,
	Clock,
	Console,
	DateTime,
	Effect,
	Fiber,
	FileSystem,
	Formatter,
	Option,
	Order,
	Path,
	Queue,
	Record as Rec,
	Ref,
	Result,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { indices, maxOf } from "#compiler/core/array.ts"
import { jsonDocument, trustedJson } from "#compiler/core/trusted.ts"
import { covered, isDump, type ScriptRanges, scriptsOfDump } from "#scripts/dev/mutate/coverage.ts"

import {
	type Entry,
	merged,
	pruneTriage,
	readStored,
	readTriage,
	type Report,
	type ReportInput,
	reportOf,
	type Stored,
	type Verdict
} from "#scripts/dev/mutate/report.ts"
import { type RunLine, runLineMarker } from "#scripts/dev/mutate/reporter.ts"
import {
	defaultOperators,
	families,
	type Operator,
	operators,
	setSemantics,
	sqlWorld
} from "#scripts/dev/mutate/world.ts"
import { hardenedNode } from "#test/support/process.ts"

/** This tool's directory, which every worker tree takes from the working tree rather than from the commit. */
const self = "scripts/dev/mutate"

/** The toolchain's submodule, whose testing library every test runs on: git archive leaves it empty. */
const toolchain = "vendor/toolchain"

/**
 * grizzle's own mutation tester for the compiler and the adapter: it breaks a rewrite, a proof, a guard or a runtime
 * decision on purpose and checks that some test notices.
 *
 *   pnpm mutate [--sample N] [--seed S] [--workers W] [--no-stage2] [--oracle-cases N] [--scope PREFIX]...
 *               [--operators OP|FAMILY,...] [--mutant ID]... [--stage1 PREFIX]... [--stage2 FILE]... [--report FILE]
 *               [--merge] [--resume FILE] [--commit REV] [--first-kill] [--keep] [--plan]
 *   pnpm mutate --retriage [--report FILE]
 *   pnpm mutate --prune-triage
 *
 * --operators takes operators and families, comma-separated: `classic` (comparison, conjunct, boolean-return, bound and
 * guard from the library's mutants, and set-semantics), `sql-world` (world.ts, aimed at the code that builds the
 * emitted world SQL), `library` (every operator of @bjornpagen/testing/mutants); the classic and sql-world families when
 * absent. --scope limits the mutants to the files under the given prefixes. --plan lists the planned
 * mutants and runs nothing. --prune-triage drops from triage.json every verdict whose mutant is in no current
 * population, and runs nothing. --plan, --retriage and --prune-triage exclude one another.
 *
 * 1. The committed tree (git archive HEAD, or the commit --commit names), with this directory as it is in the working
 *    tree, is unpacked under the system temporary directory once per worker; the repository itself is never written,
 *    except for the report and the logs.
 * 2. The mutants are every mutant @bjornpagen/testing/mutants finds in the scoped source modules with grizzle's two
 *    families (world.ts), of the operators chosen, or with --sample N a seeded sample of
 *    N spread over the areas and operators, or with --mutant the named ones (to recheck a triaged survivor).
 * 3. A coverage pass runs every stage-1 test file (the unit project, less the generators' own tests) once on the
 *    unmutated tree under NODE_V8_COVERAGE, each of its tests bounded as `pnpm test` bounds it, recording its failing
 *    tests (never counted against a mutant) and which sampled mutants it executes (coverage.ts).
 * 4. Stage 0 typechecks each mutant's tree: a mutant the type checker rejects is `invalid`, can never be committed,
 *    and is left out of the score.
 * 5. Stage 1 runs, for each valid mutant, the stage-1 files that execute it, in one Vitest run (runFiles), mutant
 *    per worker in parallel, each file of it bounded as every run's are (reporter.ts fileTimeout), so a mutant that
 *    loops where no timer of its test process fires times out. A mutant no file executes is `no-coverage`. The stage-1 verdicts go to test/support/mutation/logs/stage1.json, and --resume FILE takes a
 *    mutant's verdict from such a file instead of running stages 0 and 1 again.
 * 6. Stage 2 runs each stage-1 survivor against the PostgreSQL files that execute it, by their own coverage pass: the
 *    seeded oracle subset (oracle/), and the migration suites that alone reach the deployment's code, the generated
 *    migration paths (test/pg/migrate/paths.test.ts) and the runner's hand edits (test/pg/migrate/admission.test.ts).
 * 7. The report, test/support/mutation/report.json (report.ts), gives the score per area and per module, every mutant
 *    with its status and killing files and tests, the survivors with their triage from
 *    test/support/mutation/triage.json, per test file and per test the mutants it kills and those only it kills, and
 *    per test file how many mutants it executes. Each mutant's raw test output goes to test/support/mutation/logs/
 *    (gitignored). With --merge the run merges into the report already there, so scoped runs with their own stage-2
 *    suites add up to one report; --retriage runs no stage and rebuilds the report with the current triage. A triage
 *    verdict whose mutant is in no current population refuses every run.
 *
 * With --first-kill a mutant's run stops at the first test it fails that passes on the unmutated tree, or at the first
 * file it hangs in, so a killed mutant names its first killer only and the kill sets are partial; a mutant that
 * survives still runs every file.
 * Workers default to the cores. An interrupted run writes no report: its verdicts are incomplete.
 *
 * These are the source modules in scope, by area: the compiler's analyses, lowerings, checker, law models, writes,
 * deployment, world DDL and SQL, the Compute catalogue, the aggregate overloads and the ledger, which the sql-world
 * family also aims at, and the adapter, the runtime between them and PostgreSQL. A file belongs to the first area whose
 * prefix its path starts with; a prefix ending in `.ts` names one file.
 */
const areas: ReadonlyArray<{ readonly area: string; readonly prefix: string }> = [
	{ area: "analysis/logical", prefix: "packages/engine/src/analysis/logical/" },
	{ area: "logical", prefix: "packages/engine/src/logical/" },
	{ area: "analysis", prefix: "packages/engine/src/analysis/" },
	{ area: "lower/optimize", prefix: "packages/engine/src/lower/optimize/" },
	{ area: "lower/shapes", prefix: "packages/engine/src/lower/shapes/" },
	{ area: "lower/conservative", prefix: "packages/engine/src/lower/conservative/" },
	{ area: "check", prefix: "packages/engine/src/check/" },
	{ area: "laws/model", prefix: "packages/engine/src/laws/model/" },
	{ area: "physical/ddl", prefix: "packages/engine/src/physical/ddl/" },
	{ area: "write/put/choose", prefix: "packages/engine/src/write/put/choose.ts" },
	{ area: "write/insert", prefix: "packages/engine/src/write/insert/" },
	{ area: "write", prefix: "packages/engine/src/write/" },
	{ area: "deploy/diff", prefix: "packages/engine/src/deploy/diff/" },
	{ area: "deploy/render", prefix: "packages/engine/src/deploy/render/" },
	{ area: "deploy/admission", prefix: "packages/engine/src/deploy/admission/" },
	{ area: "deploy/ledger", prefix: "packages/engine/src/deploy/ledger/ledger.ts" },
	{ area: "scalar/compute/registry", prefix: "packages/engine/src/scalar/compute/registry.ts" },
	{ area: "scalar/aggregate", prefix: "packages/engine/src/scalar/aggregate.ts" },
	{ area: "sql/print", prefix: "packages/engine/src/sql/print.ts" },
	{ area: "adapter", prefix: "packages/grizzle/src/adapter/" }
]

/** What a run does: test the mutants, list them, or one of the triage chores, which run no stage. */
type Command = "run" | "plan" | "prune-triage" | "retriage"

/** The command line, parsed once. */
interface Settings {
	readonly command: Command
	readonly seed: number
	readonly workers: number
	readonly sample: Option.Option<number>
	readonly oracleCases: number
	readonly operators: ReadonlyArray<Operator>
	readonly scope: Option.Option<ReadonlyArray<string>>
	readonly stage1: Option.Option<ReadonlyArray<string>>
	/**
	 * Stage 2's files: the seeded oracle subset, or with --stage2 the named PostgreSQL test files (to recheck against a
	 * full suite); none with --no-stage2.
	 */
	readonly stage2Files: Option.Option<ReadonlyArray<string>>
	readonly mutants: Option.Option<ReadonlyArray<string>>
	readonly report: string
	readonly merge: boolean
	readonly resume: Option.Option<string>
	readonly commit: string
	readonly firstKill: boolean
	readonly keep: boolean
}

const positive = (raw: string, what: string): Effect.Effect<number, DevtoolFailure> => {
	const n = Number(raw)
	return Number.isInteger(n) && n >= 1
		? Effect.succeed(n)
		: Effect.fail(DevtoolFailure.make({ detail: `${what} must be a positive integer, not ${raw}` }))
}

const positiveOption = (
	raw: string | undefined,
	what: string
): Effect.Effect<Option.Option<number>, DevtoolFailure> =>
	Effect.transposeOption(Option.map(Option.fromUndefinedOr(raw), (r) => positive(r, what)))

/** An operator name stands for itself, a family name for its operators. */
const operatorsNamed = (name: string): Effect.Effect<ReadonlyArray<Operator>, DevtoolFailure> =>
	Option.match(Rec.get(families, name), {
		onSome: Effect.succeed,
		onNone: () =>
			Option.match(
				Arr.findFirst(operators, (o) => o === name),
				{
					onSome: (operator) => Effect.succeed([operator]),
					onNone: () =>
						Effect.fail(
							DevtoolFailure.make({
								detail: `unknown operator or family ${name}; one of ${Arr.join([...Rec.keys(families), ...operators], ", ")}`
							})
						)
				}
			)
	})

const commandFlags = ["plan", "prune-triage", "retriage"] as const

const parseSettings = Effect.fn("parseSettings")(function* (args: ReadonlyArray<string>) {
	const { values } = yield* Effect.try({
		try: () =>
			parseArgs({
				args: [...args],
				options: {
					sample: { type: "string" },
					seed: { type: "string", default: "1" },
					workers: { type: "string" },
					"no-stage2": { type: "boolean", default: false },
					"oracle-cases": { type: "string", default: "100" },
					scope: { type: "string", multiple: true },
					stage1: { type: "string", multiple: true },
					stage2: { type: "string", multiple: true },
					operators: { type: "string" },
					plan: { type: "boolean", default: false },
					"prune-triage": { type: "boolean", default: false },
					mutant: { type: "string", multiple: true },
					report: { type: "string", default: "test/support/mutation/report.json" },
					merge: { type: "boolean", default: false },
					retriage: { type: "boolean", default: false },
					resume: { type: "string" },
					commit: { type: "string", default: "HEAD" },
					"first-kill": { type: "boolean", default: false },
					keep: { type: "boolean", default: false }
				}
			}),
		catch: failureFrom("mutate")
	})
	const commands = Arr.filter(commandFlags, (flag) => values[flag])
	if (commands.length > 1) {
		return yield* DevtoolFailure.make({
			detail: `mutate: --${Arr.join(commands, " and --")} exclude one another`
		})
	}
	const workers = yield* Option.match(Option.fromUndefinedOr(values.workers), {
		onNone: () => Effect.succeed(availableParallelism()),
		onSome: (raw) => positive(raw, "--workers")
	})
	const wanted = yield* Option.match(Option.fromUndefinedOr(values.operators), {
		onNone: () => Effect.succeed(defaultOperators),
		onSome: (named) =>
			Effect.map(Effect.forEach(Str.split(named, ","), operatorsNamed), Arr.flatten)
	})
	const settings: Settings = {
		command: Option.getOrElse(Arr.head(commands), () => "run" as const),
		seed: yield* positive(values.seed, "--seed"),
		workers,
		sample: yield* positiveOption(values.sample, "--sample"),
		oracleCases: yield* positive(values["oracle-cases"], "--oracle-cases"),
		operators: wanted,
		scope: Option.fromUndefinedOr(values.scope),
		stage1: Option.fromUndefinedOr(values.stage1),
		stage2Files: values["no-stage2"]
			? Option.none()
			: Option.some(
					values.stage2 ?? [
						`${self}/oracle/queries.test.ts`,
						`${self}/oracle/writes.test.ts`,
						`${self}/oracle/laws.test.ts`,
						`${self}/oracle/public.test.ts`,
						"test/pg/migrate/paths.test.ts",
						"test/pg/migrate/admission.test.ts"
					]
				),
		mutants: Option.fromUndefinedOr(values.mutant),
		report: values.report,
		merge: values.merge,
		resume: Option.fromUndefinedOr(values.resume),
		commit: values.commit,
		firstKill: values["first-kill"],
		keep: values.keep
	}
	return settings
})

/** A mutant of one of grizzle's operators. */
type Mutant = LibraryMutant<Operator>

/** A planned mutant: the mutant, with the unmutated text of its file, and its area. */
interface Planned extends Mutant {
	readonly area: string
}

/** The repository, the run's scratch directory and its unpacked tree, the commit under test, and the settings. */
interface Workspace {
	readonly repo: string
	readonly runDir: string
	readonly base: string
	readonly commit: string
	readonly settings: Settings
}

/** A scratch directory under the system's, by its real path (coverage names scripts by theirs), removed at the end. */
const scratchDirectory = Effect.fn("scratchDirectory")(function* (keep: boolean) {
	const fs = yield* FileSystem.FileSystem
	const made = yield* fs.makeTempDirectory({ prefix: "grizzle-mutate-" })
	const runDir = yield* fs.realPath(made)
	yield* Effect.addFinalizer(() =>
		keep ? Console.log(`kept ${runDir}`) : Effect.orDie(fs.remove(runDir, { recursive: true }))
	)
	return runDir
})

const resolveCommit = Effect.fn("resolveCommit")(function* (repo: string, revision: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const out = yield* spawner.string(
		ChildProcess.make("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
			cwd: repo,
			stderr: "ignore"
		})
	)
	const commit = Str.trim(out)
	if (commit === "") {
		return yield* DevtoolFailure.make({ detail: `--commit ${revision} names no commit` })
	}
	return commit
})

/** Clones `from` to `to` by APFS clone; symbolic links stay links, so a relative one resolves inside the tree. */
const cloneInto = Effect.fn("cloneInto")(function* (from: string, to: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const status = yield* spawner.exitCode(
		ChildProcess.make("cp", ["-cR", from, to], { stderr: "inherit" })
	)
	if (status !== 0) {
		return yield* DevtoolFailure.make({ detail: `cp -cR ${from} ${to} exited ${status}` })
	}
})

/**
 * The workspace's node_modules in `into`: the root's with its package store linked to the repository's, and each
 * package's the tests load, so the workspace packages' own links (the root's to the packages, the shell's to the
 * engine) resolve to the packages of this tree, never the repository's: the engine, the shell, and the toolchain's
 * testing library every test runs on and dev tools the root's configs load.
 */
const linkNodeModules = Effect.fn("linkNodeModules")(function* (repo: string, into: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory(path.join(into, "node_modules"), { recursive: true })
	const entries = yield* fs.readDirectory(path.join(repo, "node_modules"))
	yield* Effect.forEach(
		entries,
		Effect.fnUntraced(function* (entry) {
			const from = path.join(repo, "node_modules", entry)
			const to = path.join(into, "node_modules", entry)
			if (entry === ".pnpm") {
				return yield* fs.symlink(from, to)
			}
			return yield* cloneInto(from, to)
		}),
		{ discard: true }
	)
	yield* Effect.forEach(
		[
			"packages/engine/node_modules",
			"packages/grizzle/node_modules",
			`${toolchain}/packages/devtools/node_modules`,
			`${toolchain}/packages/testing/node_modules`
		],
		(dir) => cloneInto(path.join(repo, dir), path.join(into, dir)),
		{ discard: true }
	)
})

/** The tree of `revision` in the repository at `repo`, unpacked into `into`. */
const archiveInto = Effect.fn("archiveInto")(function* (
	repo: string,
	revision: string,
	into: string
) {
	const fs = yield* FileSystem.FileSystem
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	yield* fs.makeDirectory(into, { recursive: true })
	const [archived, extracted] = yield* Effect.scoped(
		Effect.gen(function* () {
			const archive = yield* spawner.spawn(
				ChildProcess.make("git", ["archive", "--format=tar", revision], {
					cwd: repo,
					stderr: "inherit"
				})
			)
			const tar = yield* spawner.spawn(
				ChildProcess.make("tar", ["-x", "-C", into], { stdin: archive.stdout, stderr: "inherit" })
			)
			return yield* Effect.all([archive.exitCode, tar.exitCode], { concurrency: "unbounded" })
		})
	)
	if (archived !== 0 || extracted !== 0) {
		return yield* DevtoolFailure.make({
			detail: `git archive ${revision} in ${repo} | tar -x exited ${archived} and ${extracted}`
		})
	}
})

/** The toolchain commit `commit` pins (its gitlink at vendor/toolchain). */
const toolchainOf = Effect.fn("toolchainOf")(function* (repo: string, commit: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const out = yield* spawner.string(
		ChildProcess.make("git", ["rev-parse", "--verify", `${commit}:${toolchain}`], {
			cwd: repo,
			stderr: "ignore"
		})
	)
	const pinned = Str.trim(out)
	if (pinned === "") {
		return yield* DevtoolFailure.make({
			detail: `${commit} pins no ${toolchain}: the testing library its tests run on is the toolchain's submodule`
		})
	}
	return pinned
})

/**
 * The commit's tree unpacked into `into`, with the toolchain at the commit it pins, this tool's directory from the
 * working tree, and the workspace's node_modules.
 */
const unpack = Effect.fn("unpack")(function* (repo: string, commit: string, into: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* archiveInto(repo, commit, into)
	const pinned = yield* toolchainOf(repo, commit)
	yield* archiveInto(path.join(repo, toolchain), pinned, path.join(into, toolchain))
	yield* fs.copy(path.join(repo, self), path.join(into, self), { overwrite: true })
	yield* linkNodeModules(repo, into)
})

/** One worker's tree: an APFS clone of the unpacked base. */
const cloneTree = Effect.fn("cloneTree")(function* (base: string, tree: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const status = yield* spawner.exitCode(
		ChildProcess.make("cp", ["-cR", base, tree], { stderr: "inherit" })
	)
	if (status !== 0) {
		return yield* DevtoolFailure.make({ detail: `cp -cR ${base} ${tree} exited ${status}` })
	}
	return tree
})

/** The population a run plans from, and every mutant id of every area file, which the triage judges. */
interface Population {
	readonly areaPopulation: Readonly<Record<string, number>>
	readonly planned: ReadonlyArray<Planned>
	readonly ids: ReadonlySet<string>
}

/**
 * Every area's mutants, and those of the scoped files, the population a run plans from. A file belongs to the first
 * area whose prefix it starts with, and every file is parsed in one native batch. An operator of grizzle's own families
 * (world.ts) that finds no site in the areas' files refuses every run, since it would measure nothing.
 */
const populationOf = Effect.fn("populationOf")(function* (base: string, settings: Settings) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const listed = yield* Effect.forEach(["packages/engine/src", "packages/grizzle/src"], (src) =>
		Effect.map(fs.readDirectory(path.join(base, src), { recursive: true }), (entries) =>
			Arr.map(entries, (entry) => `${src}/${entry}`)
		)
	)
	const sources = Arr.sort(Arr.filter(Arr.flatten(listed), Str.endsWith(".ts")), Order.String)
	const areaOf = (file: string): Option.Option<string> =>
		Option.map(
			Arr.findFirst(areas, ({ prefix }) => Str.startsWith(prefix)(file)),
			({ area }) => area
		)
	const placed = Arr.flatMap(areas, ({ area }) =>
		Arr.filterMap(sources, (file) =>
			Option.contains(areaOf(file), area) ? Result.succeed({ area, file }) : Result.failVoid
		)
	)
	const inputs = yield* Effect.forEach(placed, ({ area, file }) =>
		Effect.map(fs.readFileString(path.join(base, file)), (text) => ({ area, file, text }))
	)
	const found = yield* mutantsOf(inputs, [setSemantics, sqlWorld])
	const unaimed = Arr.filter(
		[...setSemantics.operators, ...sqlWorld.operators],
		(operator) => !Arr.some(found, (m) => m.operator === operator)
	)
	if (Arr.isReadonlyArrayNonEmpty(unaimed)) {
		return yield* DevtoolFailure.make({
			detail: `mutate: ${Arr.join(unaimed, ", ")} find no site in the areas' files: the code each is aimed at changed, or its file is in no area`
		})
	}
	const byFile = Arr.groupBy(found, (m) => m.file)
	const files = Arr.map(inputs, (input) => ({ input, mutants: byFile[input.file] ?? [] }))
	const wanted = (m: Mutant): boolean => Arr.contains(settings.operators, m.operator)
	const inScope = (file: string): boolean =>
		Option.match(settings.scope, {
			onNone: () => true,
			onSome: (prefixes) => Arr.some(prefixes, (p) => Str.startsWith(p)(file))
		})
	const population: Population = {
		areaPopulation: Rec.map(
			Arr.groupBy(files, ({ input }) => input.area),
			(group) => Arr.reduce(group, 0, (n, { mutants }) => n + Arr.filter(mutants, wanted).length)
		),
		planned: Arr.flatMap(files, ({ input, mutants }) =>
			inScope(input.file)
				? Arr.map(Arr.filter(mutants, wanted), (m): Planned => ({
						...m,
						area: input.area
					}))
				: []
		),
		ids: new Set(Arr.flatMap(files, ({ mutants }) => Arr.map(mutants, (m) => m.id)))
	}
	return population
})

/** The queues' items taken in turns, one from each queue per round, until every queue is spent. */
const interleaved = <T>(queues: Arr.NonEmptyReadonlyArray<ReadonlyArray<T>>): ReadonlyArray<T> =>
	Arr.flatMap(
		indices(
			maxOf(
				Arr.map(queues, (q) => q.length),
				Number.NEGATIVE_INFINITY
			)
		),
		(round) => Arr.getSomes(Arr.map(queues, (q) => Arr.get(q, round)))
	)

/**
 * N mutants spread over the areas, each area's share its population's square root, at least ten; within an area the
 * operators take turns, each operator's mutants in seeded random order.
 */
const sampleOf = (all: ReadonlyArray<Planned>, n: number, seed: number): ReadonlyArray<Planned> => {
	const chooser = randomChooser(wordsOf(seed))
	const recorded = recorder()
	const weights = Arr.map(Rec.values(Arr.groupBy(all, (m): string => m.area)), (ms) => ({
		ms,
		w: Math.sqrt(ms.length)
	}))
	const total = Arr.reduce(weights, 0, (s, x) => s + x.w)
	return Arr.flatMap(weights, ({ ms, w }) => {
		const quota = Math.min(ms.length, Math.max(10, Math.round((n * w) / total)))
		const byOperator = Arr.map(
			Rec.values(Arr.groupBy(ms, (m): string => m.operator)),
			(q) => generate(recorded, shuffled(q, { min: q.length, max: q.length }), chooser).value
		)
		return Arr.isReadonlyArrayNonEmpty(byOperator) ? Arr.take(interleaved(byOperator), quota) : []
	})
}

/** A failed test: its file and its path of suite and test names, `(file)` for the file's own suite. */
interface Failure {
	readonly file: string
	readonly test: string
}

const failureKey = (f: Failure): string => `${f.file}\u0000${f.test}`

/**
 * How a child run ended: it printed its end or a failure ended it early, a file of it ran past the reporter's bound
 * (reporter.ts fileTimeout), or it died first.
 */
type RunEnd =
	| { readonly kind: "finished" }
	| { readonly kind: "hung"; readonly file: string }
	| { readonly kind: "crash" }

interface RunResult {
	readonly failures: ReadonlyArray<Failure>
	readonly end: RunEnd
	readonly wallMs: number
	readonly output: string
}

/** One child run: the tree, its files, the environment it adds, and the failure that ends it early. */
interface FileRun {
	readonly tree: string
	readonly files: ReadonlyArray<string>
	readonly env: Readonly<Record<string, string>>
	readonly stop: (failure: Failure) => boolean
}

/**
 * Where reading a child's stdout stands: reading on, past the child's last line, past its last line saying a test
 * process died with an error no file claims, stopped by a failure, or stopped by a file the reporter calls hung.
 */
type Reading =
	| { readonly kind: "reading" }
	| { readonly kind: "done" }
	| { readonly kind: "died" }
	| { readonly kind: "stopped" }
	| { readonly kind: "hung"; readonly file: string }

/**
 * Whether a child's stdout closed by itself, so its stderr and its exit are its own to wait for, rather than reading
 * stopped early, after which closing the run's scope kills its process group.
 */
const closedByItself = (reading: Reading): boolean => {
	switch (reading.kind) {
		case "reading":
		case "done":
		case "died":
			return true
		case "stopped":
		case "hung":
			return false
	}
}

/**
 * How a run whose reading stands so has ended, once its stdout is read: a run whose stdout closed early died, and so did
 * one whose reporter says a test process did.
 */
const endOf = (reading: Reading): RunEnd => {
	switch (reading.kind) {
		case "reading":
		case "died":
			return { kind: "crash" }
		case "done":
		case "stopped":
			return { kind: "finished" }
		case "hung":
			return { kind: "hung", file: reading.file }
	}
}

/**
 * Runs the files in one Vitest run in the tree, under the mutation tester's config (vitest.config.ts), one file at a
 * time, each in a process of its own, with the reporter that prints a line per failed test (reporter.ts), the run seed
 * and the oracle subset's case count. Every test and hook of it is bounded by the mutation tester's Vitest config
 * (vitest.config.ts mutationTestTimeout), as under `pnpm test`, and every file by the reporter (reporter.ts
 * fileTimeout), whose clock runs in Vitest's own process and so fires where a mutant loops without yielding. The run is
 * killed with its whole process group as soon as the reporter calls a file hung, or a test fails that `stop` accepts,
 * which counts as finished.
 */
const runFiles = Effect.fn("runFiles")(function* (settings: Settings, run: FileRun) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const path = yield* Path.Path
	const started = yield* Clock.currentTimeMillis
	const failures = new Map<string, Failure>()
	const output: Array<string> = []
	const reading = yield* Ref.make<Reading>({ kind: "reading" })
	const record = (line: string): Effect.Effect<void> =>
		Effect.sync(() => {
			output.push(line)
		})
	const onFailure = (failure: Failure): Effect.Effect<boolean> =>
		Effect.flatMap(
			Effect.sync(() => {
				failures.set(failureKey(failure), failure)
			}),
			() =>
				run.stop(failure)
					? Effect.as(Ref.set(reading, { kind: "stopped" }), false)
					: Effect.succeed(true)
		)
	const onLine = (line: RunLine): Effect.Effect<boolean> => {
		switch (line.kind) {
			case "fail":
				return onFailure({ file: line.file, test: line.test })
			case "hung":
				return Effect.as(Ref.set(reading, { kind: "hung", file: line.file }), false)
			case "done":
				return Effect.as(Ref.set(reading, { kind: "done" }), true)
			case "died":
				return Effect.as(Ref.set(reading, { kind: "died" }), true)
		}
	}
	/** Records one stdout line and says whether to read on: a line of the reporter's (reporter.ts) is a RunLine. */
	const read = (line: string): Effect.Effect<boolean> =>
		Effect.flatMap(record(line), () =>
			Str.startsWith(runLineMarker)(line)
				? onLine(trustedJson<RunLine>(Str.slice(runLineMarker.length)(line)))
				: Effect.succeed(true)
		)
	const watch = Effect.scoped(
		Effect.gen(function* () {
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						path.join(run.tree, "node_modules/vitest/vitest.mjs"),
						"run",
						"--config",
						path.join(run.tree, self, "vitest.config.ts"),
						"--maxWorkers=1",
						"--reporter=default",
						`--reporter=${path.join(run.tree, self, "reporter.ts")}`,
						...run.files
					],
					{
						cwd: run.tree,
						env: {
							NODE_OPTIONS: Arr.join(hardenedNode, " "),
							TEST_SEED: String(settings.seed),
							MUTATE_ORACLE_CASES: String(settings.oracleCases),
							...run.env
						},
						extendEnv: true,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						killSignal: "SIGKILL"
					}
				)
			)
			const stderr = yield* Effect.forkScoped(
				Stream.runForEach(Stream.splitLines(Stream.decodeText(child.stderr)), record)
			)
			yield* Stream.runForEachWhile(Stream.splitLines(Stream.decodeText(child.stdout)), read)
			const afterStdout = yield* Ref.get(reading)
			if (closedByItself(afterStdout)) {
				yield* Fiber.join(stderr)
				yield* Effect.ignore(child.exitCode)
			}
		})
	).pipe(
		Effect.mapError(
			failureFrom(`mutate: the run of ${Arr.join(run.files, " ")} in ${run.tree} failed`)
		)
	)
	yield* watch
	const ended = yield* Clock.currentTimeMillis
	const finalReading = yield* Ref.get(reading)
	const result: RunResult = {
		failures: [...failures.values()],
		end: endOf(finalReading),
		wallMs: ended - started,
		output: Arr.join(output, "\n")
	}
	return result
})

/** The worker trees, each taken by one job at a time: take one free, give it back, and how many there are. */
interface Trees {
	readonly take: Effect.Effect<string>
	readonly give: (tree: string) => Effect.Effect<void>
	readonly count: number
}

/** Runs `job` on every item, at most one per worker tree at a time; the results in the items' order. */
const pooled = <T, A, E, R>(
	trees: Trees,
	items: ReadonlyArray<T>,
	job: (item: T, tree: string) => Effect.Effect<A, E, R>
): Effect.Effect<Array<A>, E, R> =>
	Effect.forEach(
		items,
		(item) => Effect.acquireUseRelease(trees.take, (tree) => job(item, tree), trees.give),
		{
			concurrency: trees.count
		}
	)

/** One file of a coverage pass: its failing tests, and the planned mutants it executes. */
interface FilePass {
	readonly file: string
	readonly failures: ReadonlyArray<Failure>
	readonly covers: ReadonlySet<string>
}

/** A coverage pass over the unmutated tree: each file as it ran, and every failure, which no mutant is charged with. */
interface Baseline {
	readonly passes: ReadonlyArray<FilePass>
	readonly failures: ReadonlySet<string>
}

/** How many planned mutants each file of a pass executes, the files that execute none left out. */
const coverageCounts = (b: Baseline): ReadonlyArray<readonly [string, number]> =>
	Arr.filterMap(b.passes, (p) =>
		p.covers.size > 0 ? Result.succeed([p.file, p.covers.size] as const) : Result.failVoid
	)

/** The ranges each dump a run wrote into `dir` reports for each wanted script under `root`, by its relative path. */
const coverageIn = Effect.fn("coverageIn")(function* (
	dir: string,
	root: string,
	wanted: ReadonlySet<string>
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = yield* fs.readDirectory(dir, { recursive: true })
	const dumps = Arr.filter(entries, isDump)
	const scripts = yield* Effect.forEach(dumps, (name) =>
		Effect.flatMap(fs.readFileString(path.join(dir, name)), (text) =>
			Effect.try({
				try: () => scriptsOfDump({ text, root, wanted }),
				catch: failureFrom(
					`mutate: the coverage dump ${path.join(dir, name)}, of ${text.length} characters, is no whole JSON document`
				)
			})
		)
	)
	return Rec.map(
		Arr.groupBy(Arr.flatten(scripts), (script) => script.path),
		(group): ReadonlyArray<ScriptRanges> =>
			Arr.map(group, (script) => Arr.flatMap(script.functions, (f) => f.ranges))
	)
})

/** The stage a pass or an attempt belongs to, and the planned mutants grouped by their file. */
interface Stage {
	readonly workspace: Workspace
	readonly trees: Trees
	readonly byFile: Readonly<Record<string, ReadonlyArray<Planned>>>
}

/** Runs each file alone on the unmutated tree under NODE_V8_COVERAGE, and records which planned mutants it executes. */
const coveragePass = Effect.fn("coveragePass")(function* (
	stage: Stage,
	label: string,
	files: ReadonlyArray<string>
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const done = yield* Ref.make(0)
	const wanted = new Set(Rec.keys(stage.byFile))
	const passOf = Effect.fn("passOf")(function* (file: string, tree: string) {
		const dir = path.join(
			stage.workspace.runDir,
			"coverage",
			`${label}-${Str.replaceAll("/", "_")(file)}`
		)
		yield* fs.makeDirectory(dir, { recursive: true })
		const result = yield* runFiles(stage.workspace.settings, {
			tree,
			files: [file],
			env: { NODE_V8_COVERAGE: dir },
			stop: () => false
		})
		const dumps = yield* coverageIn(dir, tree, wanted)
		const covers = Arr.flatMap(Rec.toEntries(stage.byFile), ([script, mutants]) =>
			Option.match(Rec.get(dumps, script), {
				onNone: () => [],
				onSome: (ranges) =>
					Arr.filterMap(mutants, (m) =>
						Arr.some(ranges, (r) => covered({ ranges: r, offset: m.start }))
							? Result.succeed(m.id)
							: Result.failVoid
					)
			})
		)
		yield* fs.remove(dir, { recursive: true })
		const count = yield* Ref.updateAndGet(done, (n) => n + 1)
		const failed = Arr.filter(result.failures, (f) => f.file === file).length
		yield* Console.log(
			`coverage ${label} [${count}/${files.length}] ${file} ${result.wallMs} ms${failed > 0 ? `, ${failed} failing in the baseline` : ""}${result.end.kind === "finished" ? "" : ", did not finish"}`
		)
		const pass: FilePass = {
			file,
			failures:
				result.end.kind === "finished"
					? result.failures
					: [...result.failures, { file, test: "(run)" }],
			covers: new Set(covers)
		}
		return pass
	})
	const passes = yield* pooled(stage.trees, files, passOf)
	const baseline: Baseline = {
		passes,
		failures: new Set(Arr.flatMap(passes, (p) => Arr.map(p.failures, failureKey)))
	}
	return baseline
})

/**
 * The unit project, less the generators' own tests (test/unit/oracle-gen), which judge test code, not the compiler; with
 * --stage1 the files under the given prefixes.
 */
const stage1FilesOf = Effect.fn("stage1FilesOf")(function* (base: string, settings: Settings) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const listed = yield* fs.readDirectory(path.join(base, "test/unit"), { recursive: true })
	const tests = Arr.sort(
		Arr.filterMap(listed, (entry) =>
			Str.endsWith(".test.ts")(entry) ? Result.succeed(`test/unit/${entry}`) : Result.failVoid
		),
		Order.String
	)
	return Option.match(settings.stage1, {
		onNone: () => Arr.filter(tests, (f) => !Str.startsWith("test/unit/oracle-gen/")(f)),
		onSome: (prefixes) => Arr.filter(tests, (f) => Arr.some(prefixes, (p) => Str.startsWith(p)(f)))
	})
})

const writeSource = Effect.fn("writeSource")(function* (tree: string, file: string, text: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.writeFileString(path.join(tree, file), text)
})

/** Runs `use` with the mutant written into the tree, and puts the unmutated text back after, however `use` ends. */
const withMutant = <A, E, R>(tree: string, m: Planned, use: Effect.Effect<A, E, R>) =>
	Effect.acquireUseRelease(
		writeSource(tree, m.file, applied(m)),
		() => use,
		() => Effect.orDie(writeSource(tree, m.file, m.source))
	)

/** The verdict on a mutant from its new failures: killed (or killed by timing out) by their files and leaf tests, or survived. */
const verdictOf = (failures: ReadonlyArray<Failure>, timedOut: boolean, stage: 1 | 2): Verdict => {
	const leaves = Arr.filter(
		failures,
		(t) =>
			!Arr.some(
				failures,
				(u) =>
					u.file === t.file &&
					u.test !== t.test &&
					(t.test === "(file)" || Str.startsWith(`${t.test} > `)(u.test))
			)
	)
	const killedBy = Arr.sort(Arr.dedupe(Arr.map(failures, (t) => t.file)), Order.String)
	if (!Arr.isReadonlyArrayNonEmpty(killedBy)) {
		return { status: "survived" }
	}
	return {
		status: timedOut ? "timeout" : "killed",
		stage,
		killedBy,
		killedByTests: Arr.sort(
			Arr.dedupe(Arr.map(leaves, (t) => `${t.file} > ${t.test}`)),
			Order.String
		)
	}
}

/** What running a mutant's files found: its new failures, whether a file ran out of time, and the raw output. */
interface Attempt {
	readonly failures: ReadonlyArray<Failure>
	readonly timedOut: boolean
	readonly log: ReadonlyArray<string>
}

const endNote = (r: RunResult): string => (r.end.kind === "hung" ? " (timeout)" : "")

/** What a run of the file `file` alone that did not finish charges it with: a timeout where it hung, a crash where it
 * died. */
const unfinishedOf = (file: string, end: RunEnd): ReadonlyArray<Failure> => {
	switch (end.kind) {
		case "finished":
			return []
		case "hung":
			return [{ file: end.file, test: "(timeout)" }]
		case "crash":
			return [{ file, test: "(crash)" }]
	}
}

/** The file a run that did not finish hung in, none where it died. */
const hungIn = (end: RunEnd): ReadonlyArray<string> => (end.kind === "hung" ? [end.file] : [])

/**
 * Each of `files` run alone by `runOne`, in order, until one of the runs `kills`: the attribution of a run that hung
 * or died, which stops at its first killer under --first-kill.
 */
const runAlone = <A, E, R>(
	files: ReadonlyArray<FilePass>,
	runOne: (p: FilePass) => Effect.Effect<A, E, R>,
	kills: (a: A) => boolean
): Effect.Effect<ReadonlyArray<A>, E, R> =>
	Effect.gen(function* () {
		const out: Array<A> = []
		for (const p of files) {
			const a = yield* runOne(p)
			out.push(a)
			if (kills(a)) {
				return out
			}
		}
		return out
	})

/**
 * Runs the files against the mutant in the tree; the killing files are those with a test that passes in the baseline
 * and fails here. A run that hangs is charged to the file it hung in, with that file's failures before it; it and a
 * run that dies are attributed by running each other file alone. Under --first-kill the file a run hangs in is its
 * killer, and a run that dies is attributed only up to the first file that kills alone.
 */
const attempt = Effect.fn("attempt")(function* (
	stage: Stage,
	m: Planned,
	tree: string,
	files: ReadonlyArray<FilePass>,
	baseline: Baseline
) {
	const settings = stage.workspace.settings
	const names = Arr.map(files, (p) => p.file)
	const isNew = (f: Failure): boolean =>
		!baseline.failures.has(failureKey(f)) && Arr.contains(names, f.file)
	const stop = (f: Failure): boolean => settings.firstKill && isNew(f)
	const run = (ps: ReadonlyArray<FilePass>) =>
		runFiles(settings, {
			tree,
			files: Arr.map(ps, (p) => p.file),
			env: {},
			stop
		})
	return yield* withMutant(
		tree,
		m,
		Effect.gen(function* () {
			const whole = yield* run(files)
			const wholeLog = [
				`$ ${files.length} files: ${whole.wallMs} ms${endNote(whole)}`,
				whole.output
			]
			if (whole.end.kind === "finished") {
				const found: Attempt = {
					failures: Arr.filter(whole.failures, isNew),
					timedOut: false,
					log: wholeLog
				}
				return found
			}
			const hung = hungIn(whole.end)
			const alone = yield* runAlone(
				settings.firstKill && Arr.isReadonlyArrayNonEmpty(hung)
					? []
					: Arr.filter(files, (p) => !Arr.contains(hung, p.file)),
				(p) => Effect.map(run([p]), (r) => ({ file: p.file, r })),
				({ r }) => settings.firstKill && (r.end.kind !== "finished" || Arr.some(r.failures, isNew))
			)
			const found: Attempt = {
				failures: [
					...Arr.filter(whole.failures, (f) => isNew(f) && Arr.contains(hung, f.file)),
					...Arr.map(hung, (file): Failure => ({ file, test: "(timeout)" })),
					...Arr.flatMap(alone, ({ file, r }) => [
						...Arr.filter(r.failures, isNew),
						...unfinishedOf(file, r.end)
					])
				],
				timedOut:
					Arr.isReadonlyArrayNonEmpty(hung) || Arr.some(alone, ({ r }) => r.end.kind === "hung"),
				log: [
					...wholeLog,
					...Arr.flatMap(alone, ({ file, r }) => [
						`$ ${file}: ${r.wallMs} ms${endNote(r)}`,
						r.output
					])
				]
			}
			return found
		})
	)
})

/** Diagnostics a mutant introduces only by leaving code unused or unreachable: not a type error. */
const unusedCodes: ReadonlySet<string> = new Set([
	"TS6133",
	"TS6138",
	"TS6192",
	"TS6196",
	"TS6198",
	"TS6199",
	"TS6205",
	"TS7027"
])

const diagnosticLine = regex("^(.+?)\\(\\d+,\\d+\\): (?:error|warning) (TS\\d+)")

/** A diagnostic line of tsc's: the file it is in and its code. */
const diagnosticOf = (
	line: string
): Option.Option<{ readonly file: string; readonly code: string }> =>
	Option.flatMap(Str.match(diagnosticLine)(line), (m) =>
		Option.all({ file: Arr.get(m, 1), code: Arr.get(m, 2) })
	)

/**
 * The type errors per source file of the tree's two package projects, built in order by one `tsc -b` of the shell's
 * (packages/engine/tsconfig.json, every module of the engine; packages/grizzle/tsconfig.json, the shell against the
 * engine's emitted declarations), the unused-code diagnostics and suggestions left out. The build writes, in the
 * tree, each package's declarations under its types/ and its build info beside its tsconfig.
 */
const typeErrors = Effect.fn("typeErrors")(function* (tree: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const path = yield* Path.Path
	const lines = yield* spawner.lines(
		ChildProcess.make(
			path.join(tree, "node_modules/.bin/tsc"),
			["-b", "packages/grizzle/tsconfig.json", "--pretty", "false"],
			{ cwd: tree, stderr: "ignore" }
		)
	)
	const errors = Arr.filter(
		Arr.getSomes(Arr.map(lines, diagnosticOf)),
		(d) => !unusedCodes.has(d.code)
	)
	return Rec.map(
		Arr.groupBy(errors, (d) => d.file),
		(group) => group.length
	)
})

/** The stage-1 verdicts of a run, which a later run resumes from. */
type Stage1 = {
	readonly commit: string
	readonly verdicts: Readonly<Record<string, Verdict>>
}

/** The mutants with their verdicts, in the planned order. */
type Judged = ReadonlyArray<readonly [Planned, Verdict]>

/** A mutant's verdict and the log of how it was reached. */
interface Judgement {
	readonly verdict: Verdict
	readonly log: ReadonlyArray<string>
}

const judgement = (verdict: Verdict, log: ReadonlyArray<string>): Judgement => ({ verdict, log })

const isSurvivor = (v: Verdict): boolean => v.status === "survived" || v.status === "no-coverage"

/** Stage 0 and stage 1 for every planned mutant, or its verdict from the resumed run. */
const stage1Of = Effect.fn("stage1Of")(function* (
	stage: Stage,
	planned: ReadonlyArray<Planned>,
	logDir: string
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { workspace } = stage
	const resumed = yield* Option.match(workspace.settings.resume, {
		onNone: () => Effect.succeed<Readonly<Record<string, Verdict>>>({}),
		onSome: (file) =>
			Effect.flatMap(fs.readFileString(path.resolve(workspace.repo, file)), (text) =>
				Effect.try({
					try: () => trustedJson<Stage1>(text).verdicts,
					catch: failureFrom(`${file} is not JSON`)
				})
			)
	})
	const baselineErrors = yield* typeErrors(workspace.base)
	const stage1Files = yield* stage1FilesOf(workspace.base, workspace.settings)
	const baseline = yield* coveragePass(stage, "stage1", stage1Files)
	const finished = yield* Ref.make(0)
	const judge = Effect.fn("judge")(function* (m: Planned, tree: string) {
		const files = Arr.filter(baseline.passes, (p) => p.covers.has(m.id))
		const log = [
			`${m.id} ${m.file}:${m.line}:${m.column} ${m.operator}`,
			`- ${m.original}`,
			`+ ${m.replacement}`
		]
		/** Stage 0: a mutant the type checker rejects can never be committed, so no test needs to catch it. */
		const errors = yield* withMutant(tree, m, typeErrors(tree))
		if ((errors[m.file] ?? 0) > (baselineErrors[m.file] ?? 0)) {
			return judgement({ status: "invalid" }, log)
		}
		if (!Arr.isReadonlyArrayNonEmpty(files)) {
			return judgement({ status: "no-coverage" }, log)
		}
		const tried = yield* attempt(stage, m, tree, files, baseline)
		return judgement(verdictOf(tried.failures, tried.timedOut, 1), [...log, ...tried.log])
	})
	const judged = yield* pooled(stage.trees, planned, (m, tree) =>
		Effect.gen(function* () {
			const files = Arr.filter(baseline.passes, (p) => p.covers.has(m.id)).length
			const earlier = Rec.get(resumed, m.id)
			if (Option.isSome(earlier)) {
				const count = yield* Ref.updateAndGet(finished, (n) => n + 1)
				yield* Console.log(
					`stage1 [${count}/${planned.length}] ${m.id} ${m.file}:${m.line} ${m.operator} ${earlier.value.status} (resumed)`
				)
				return [m, earlier.value] as const
			}
			const { verdict, log } = yield* judge(m, tree)
			yield* fs.writeFileString(path.join(logDir, `${m.id}.log`), `${Arr.join(log, "\n")}\n`)
			const count = yield* Ref.updateAndGet(finished, (n) => n + 1)
			const by =
				verdict.status === "killed" || verdict.status === "timeout"
					? ` by ${verdict.killedBy.length}`
					: ""
			yield* Console.log(
				`stage1 [${count}/${planned.length}] ${m.id} ${m.file}:${m.line} ${m.operator} ${verdict.status}${by} (${files} files)`
			)
			return [m, verdict] as const
		})
	)
	const recorded: Stage1 = {
		commit: workspace.commit,
		verdicts: Rec.fromEntries(Arr.map(judged, ([m, v]): readonly [string, Verdict] => [m.id, v]))
	}
	yield* fs.writeFileString(path.join(logDir, "stage1.json"), `${jsonDocument(recorded)}\n`)
	return { judged, baseline }
})

/** Stage 2: each stage-1 survivor against the PostgreSQL files that execute it; a kill replaces its verdict. */
const stage2Of = Effect.fn("stage2Of")(function* (
	stage: Stage,
	stage1: Judged,
	stage2Files: ReadonlyArray<string>,
	logDir: string
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const survivors = Arr.filter(stage1, ([, v]) => isSurvivor(v))
	const baseline = yield* coveragePass(stage, "stage2", stage2Files)
	const finished = yield* Ref.make(0)
	const retry = Effect.fn("retry")(function* (m: Planned, before: Verdict, tree: string) {
		const files = Arr.filter(baseline.passes, (p) => p.covers.has(m.id))
		const tried = Arr.isReadonlyArrayNonEmpty(files)
			? yield* Effect.asSome(attempt(stage, m, tree, files, baseline))
			: Option.none<Attempt>()
		const after = Option.match(tried, {
			onNone: () => before,
			onSome: (t) => {
				const v = verdictOf(t.failures, t.timedOut, 2)
				return isSurvivor(v) ? before : v
			}
		})
		const log = [
			`stage 2: ${m.id}`,
			...Option.match(tried, { onNone: () => [], onSome: (t) => t.log })
		]
		yield* fs.writeFileString(path.join(logDir, `${m.id}.log`), `${Arr.join(log, "\n")}\n`, {
			flag: "a"
		})
		const count = yield* Ref.updateAndGet(finished, (n) => n + 1)
		yield* Console.log(
			`stage2 [${count}/${survivors.length}] ${m.id} ${m.file}:${m.line} ${m.operator} ${after.status} (${files.length} files)`
		)
		return [m, after] as const
	})
	/** Every mutant in the planned order: a survivor retried, any other as stage 1 left it. */
	const judged: Judged = yield* pooled(stage.trees, stage1, ([m, before], tree) =>
		isSurvivor(before) ? retry(m, before, tree) : Effect.succeed([m, before] as const)
	)
	return { judged, baseline }
})

const clip = (text: string): string => (text.length > 160 ? `${Str.slice(0, 157)(text)}...` : text)

const entryOf = ([m, v]: readonly [Planned, Verdict]): Entry => ({
	id: m.id,
	area: m.area,
	file: m.file,
	line: m.line,
	column: m.column,
	function: m.fn,
	operator: m.operator,
	original: clip(m.original),
	replacement: clip(m.replacement),
	...v
})

const keyOrder: Order.Order<readonly [string, number]> = Order.mapInput(
	Order.String,
	([key]: readonly [string, number]) => key
)

/** The run's report written to the report file, merged over the earlier one with --merge. */
const writeReport = Effect.fn("writeReport")(function* (file: string, input: ReportInput) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const report = reportOf(input)
	yield* fs.makeDirectory(path.dirname(file), { recursive: true })
	yield* fs.writeFileString(file, `${jsonDocument(report)}\n`)
	return report
})

/** Plans the mutants, runs the stages, and writes the report. */
const runStages = Effect.fn("runStages")(function* (
	workspace: Workspace,
	population: Population,
	planned: ReadonlyArray<Planned>,
	triage: ReportInput["triage"]
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { settings } = workspace
	const reportPath = path.resolve(workspace.repo, settings.report)
	const logDir = path.join(workspace.repo, "test/support/mutation/logs")
	const trees = yield* Effect.forEach(
		Array.from({ length: settings.workers }, (_, i) => i),
		(i) => cloneTree(workspace.base, path.join(workspace.runDir, `w${i}`))
	)
	const free = yield* Queue.unbounded<string>()
	yield* Queue.offerAll(free, trees)
	const pool: Trees = {
		take: Queue.take(free),
		give: (tree) => Effect.asVoid(Queue.offer(free, tree)),
		count: trees.length
	}
	const stage: Stage = { workspace, trees: pool, byFile: Arr.groupBy(planned, (m) => m.file) }
	yield* fs.makeDirectory(logDir, { recursive: true })
	const first = yield* stage1Of(stage, planned, logDir)
	const stage2Files = Option.filter(settings.stage2Files, () =>
		Arr.some(first.judged, ([, v]) => isSurvivor(v))
	)
	const second = yield* Effect.transposeOption(
		Option.map(stage2Files, (files) => stage2Of(stage, first.judged, files, logDir))
	)
	const judged = Option.match(second, { onNone: () => first.judged, onSome: (s) => s.judged })
	const now = yield* DateTime.now
	const thisRun: Stored = {
		runs: [
			{
				commit: workspace.commit,
				generated: DateTime.formatIso(now),
				settings: {
					seed: settings.seed,
					sample: Option.match(settings.sample, { onNone: () => "all", onSome: (n) => n }),
					scope: Option.match(settings.scope, { onNone: () => "all", onSome: (s) => s }),
					firstKill: settings.firstKill,
					mutants: planned.length,
					workers: settings.workers,
					operators: settings.operators,
					stage1Files: first.baseline.passes.length,
					stage2Files: Option.getOrElse(settings.stage2Files, () => []),
					oracleCases: settings.oracleCases
				}
			}
		],
		population: population.areaPopulation,
		covers: Rec.fromEntries(
			Arr.sort(
				[
					...coverageCounts(first.baseline),
					...Option.match(second, { onNone: () => [], onSome: (s) => coverageCounts(s.baseline) })
				],
				keyOrder
			)
		),
		mutants: Arr.map(judged, entryOf)
	}
	const prior = settings.merge ? yield* readStored(reportPath) : Option.none<Stored>()
	const stored = Option.match(prior, { onNone: () => thisRun, onSome: (p) => merged(p, thisRun) })
	const report: Report = yield* writeReport(reportPath, { stored, triage })
	yield* Console.log(
		`mutate: score ${report.total.score} (${Formatter.format(report.total)}); report ${reportPath}`
	)
	yield* Effect.forEach(
		Rec.toEntries(report.areas),
		([area, s]) => Console.log(`  ${area}: ${s.score} of ${s.mutants}`),
		{
			discard: true
		}
	)
})

/** Lists the planned mutants and the count per operator. */
const printPlan = Effect.fn("printPlan")(function* (
	settings: Settings,
	planned: ReadonlyArray<Planned>
) {
	yield* Effect.forEach(
		planned,
		(m) =>
			Console.log(
				`${m.id} ${m.file}:${m.line}:${m.column} ${m.operator} ${Formatter.format(m.original)} -> ${Formatter.format(m.replacement)}`
			),
		{ discard: true }
	)
	yield* Effect.forEach(
		settings.operators,
		(operator) =>
			Console.log(
				`plan: ${operator} ${Arr.filter(planned, (m) => m.operator === operator).length}`
			),
		{ discard: true }
	)
})

const main = Effect.gen(function* () {
	const path = yield* Path.Path
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const settings = yield* parseSettings(args)
	const repo = path.resolve(import.meta.dirname, "../../..")
	const runDir = yield* scratchDirectory(settings.keep)
	const commit = yield* resolveCommit(repo, settings.commit)
	const base = path.join(runDir, "base")
	yield* unpack(repo, commit, base)
	const workspace: Workspace = { repo, runDir, base, commit, settings }
	const population = yield* populationOf(base, settings)
	const triagePath = path.join(repo, "test/support/mutation/triage.json")
	if (settings.command === "prune-triage") {
		const { kept, dropped } = yield* pruneTriage({ path: triagePath, population: population.ids })
		return yield* Console.log(
			`mutate: triage.json keeps ${kept} verdicts and drops ${dropped.length}: ${Arr.join(dropped, " ")}`
		)
	}
	const triage = yield* readTriage({ path: triagePath, population: population.ids })
	const reportPath = path.resolve(repo, settings.report)
	if (settings.command === "retriage") {
		const stored = yield* readStored(reportPath)
		if (Option.isNone(stored)) {
			return yield* DevtoolFailure.make({
				detail: `--retriage: there is no report at ${reportPath}`
			})
		}
		const report = yield* writeReport(reportPath, { stored: stored.value, triage })
		return yield* Console.log(
			`mutate: retriaged ${report.mutants.length} mutants; score after triage ${report.total.scoreAfterTriage}`
		)
	}
	const planned = Option.match(settings.mutants, {
		onSome: (ids) => Arr.filter(population.planned, (m) => Arr.contains(ids, m.id)),
		onNone: () =>
			Option.match(settings.sample, {
				onNone: () => population.planned,
				onSome: (n) => sampleOf(population.planned, n, settings.seed)
			})
	})
	yield* Console.log(
		`mutate: ${planned.length} of ${population.planned.length} mutants, ${settings.workers} workers, seed ${settings.seed}, commit ${Str.slice(0, 10)(commit)}`
	)
	if (settings.command === "plan") {
		return yield* printPlan(settings, planned)
	}
	return yield* runStages(workspace, population, planned, triage)
}).pipe(Effect.scoped)

runDevtool(Effect.as(main, 0))
