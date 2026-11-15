import { availableParallelism } from "node:os"
import { parseArgs } from "node:util"
import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import { runDevtool } from "@bjornpagen/devtools/run"
import {
	Array as Arr,
	Console,
	Duration,
	Effect,
	FileSystem,
	Option,
	Path,
	Record as Rec,
	Result,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import {
	findingsOf,
	findingText,
	type Pair,
	pairsOf,
	planOf,
	readTree,
	repositoryRoot,
	type Targets,
	type Trial
} from "#scripts/dev/plants/tree.ts"
import {
	type Blob,
	type Kept,
	keep,
	keptAt,
	keyOf,
	verdictDirectory
} from "#scripts/dev/plants/verdicts.ts"
import { tiers } from "#test/support/tiers.ts"

/**
 * What a plant's trial says of one test that cites it:
 * - `red`: the test fails while the plant is planted and passes without it, as a plant must make it;
 * - `green`: the test passes while the plant is planted, so the bug the plant introduces is one no test catches;
 * - `stale`: the plant no longer applies to the tree, so it plants nothing until it is made again;
 * - `unjudged`: the test fails with no plant planted, so a red under the plant says nothing.
 */
type Verdict = "red" | "green" | "stale" | "unjudged"

/** One verdict: the plant, the test, and what the test did while the plant was planted. */
interface Judged {
	readonly plant: string
	readonly test: string
	readonly verdict: Verdict
}

/** A child run to completion: its exit status, its output on both streams in one log, and how long it took. */
interface Ran {
	readonly status: number
	readonly log: string
	readonly took: Duration.Duration
}

/** Runs `command` with `args` in `root` to completion, its stdin empty and both streams kept, in this process's environment. */
const runToEnd = Effect.fn("runToEnd")(function* (
	root: string,
	command: string,
	args: ReadonlyArray<string>
) {
	const [took, [stdout, stderr, status]] = yield* Effect.timed(
		Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* ChildProcess.make(command, args, {
					cwd: root,
					stdin: "ignore",
					extendEnv: true
				})
				return yield* Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr)),
						handle.exitCode
					],
					{ concurrency: "unbounded" }
				)
			})
		)
	).pipe(Effect.mapError(failureFrom(`${command} ${Arr.join(args, " ")} could not be run`)))
	const ran: Ran = { status, log: `${stdout}${stderr}`, took }
	return ran
})

/** Runs git with `args` in `root`, failing unless it exits 0, and answers its output. */
const git = Effect.fn("git")(function* (root: string, args: ReadonlyArray<string>) {
	const ran = yield* runToEnd(root, "git", args)
	if (ran.status !== 0) {
		return yield* DevtoolFailure.make({
			detail: `git ${Arr.join(args, " ")} exited with ${ran.status}:\n${ran.log}`
		})
	}
	return ran.log
})

/** The files a plant changes, by path from the root, as git reads its patch. */
const touchedBy = Effect.fn("touchedBy")(function* (root: string, plant: string) {
	const numstat = yield* git(root, ["apply", "--numstat", plant])
	return Arr.flatMap(Str.split("\n")(numstat), (line) =>
		Option.toArray(Option.fromNullishOr(Str.split("\t")(line)[2]))
	)
})

/** The files among `paths` that differ from HEAD or that git does not track, as `git status` lists them. */
const changedAmong = Effect.fn("changedAmong")(function* (
	root: string,
	paths: ReadonlyArray<string>
) {
	const status = yield* git(root, [
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		...paths
	])
	return Arr.filter(Str.split("\n")(status), Str.isNonEmpty)
})

/** The pnpm script of the tier whose Vitest config includes `test`, or a failure naming the test no tier includes. */
const scriptOf = (test: string) =>
	Option.match(
		Arr.findFirst(Rec.values(tiers), (tier) =>
			Arr.some(tier.roots, (root) => Str.startsWith(root)(test))
		),
		{
			onNone: () =>
				Effect.fail(
					DevtoolFailure.make({
						detail: `${test} is in no test tier's include (test/support/tiers.ts)`
					})
				),
			onSome: (tier) => Effect.succeed(tier.script)
		}
	)

/** A file name for a log of `test`, under a stem: the test's path with each separator a dash. */
const logName = (stem: string, test: string): string =>
	`${stem}--${Str.replaceAll("/", "-")(test)}.log`

/**
 * Runs `test` alone through its tier's script, as `pnpm -s <script> <test>` runs it, writes its log under `logs` and
 * answers whether it passed.
 */
const runTest = Effect.fn("runTest")(function* (
	root: string,
	logs: string,
	stem: string,
	test: string
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const script = yield* scriptOf(test)
	const ran = yield* runToEnd(root, "pnpm", ["-s", script, test])
	const log = path.join(logs, logName(stem, test))
	yield* fs
		.writeFileString(log, ran.log)
		.pipe(Effect.mapError(failureFrom(`${log} could not be written`)))
	return { passed: ran.status === 0, took: ran.took, log }
})

/** A plant's name: the last segment of its path, without .patch. */
const stemOf = (plant: string): string =>
	Str.replace(".patch", "")(Arr.lastNonEmpty(Str.split("/")(plant)))

/**
 * One trial: the plant planted, each of its tests run, and the plant taken out again, whatever the runs did or however
 * they ended. Every test that passes without plants answers red or green; one that fails without them is unjudged and
 * not run. A plant that no longer applies is stale for every test. Once the plant is out, its files must be as they were
 * before it went in, or the run stops.
 */
const trialOf = Effect.fn("trialOf")(function* (
	root: string,
	logs: string,
	baseline: ReadonlyMap<string, boolean>,
	trial: Trial
) {
	const judged = (test: string, verdict: Verdict): Judged => ({ plant: trial.plant, test, verdict })
	const applies = yield* Effect.map(
		runToEnd(root, "git", ["apply", "--check", trial.plant]),
		(ran) => ran.status === 0
	)
	if (!applies) {
		return Arr.map(trial.tests, (test) => judged(test, "stale"))
	}
	const touched = yield* touchedBy(root, trial.plant)
	const plant = git(root, ["apply", trial.plant])
	const unplant = Effect.andThen(git(root, ["apply", "--reverse", trial.plant]), () =>
		Effect.flatMap(changedAmong(root, touched), (left) =>
			Arr.isReadonlyArrayNonEmpty(left)
				? Effect.die(
						DevtoolFailure.make({
							detail: `${trial.plant} came out but left its files changed:\n${Arr.join(left, "\n")}`
						})
					)
				: Effect.void
		)
	)
	return yield* Effect.acquireUseRelease(
		plant,
		() =>
			Effect.forEach(trial.tests, (test) =>
				baseline.get(test) === true
					? Effect.map(runTest(root, logs, stemOf(trial.plant), test), (ran) =>
							judged(test, ran.passed ? "green" : "red")
						)
					: Effect.succeed(judged(test, "unjudged"))
			),
		() => Effect.orDie(unplant)
	)
})

/**
 * What the command line asks: the citations with no kept verdict (`changed`), under the directories named when any
 * are, or the tests and plants named, and where logs go when given.
 */
type Asked =
	| Readonly<{ kind: "changed"; within: Option.Option<Arr.NonEmptyReadonlyArray<string>> }>
	| Readonly<{ kind: "named"; names: Arr.NonEmptyReadonlyArray<string> }>

/** The command line: --changed and the directories it keeps to, or the tests and plants named, and where logs go. */
const argumentsOf = Effect.fn("argumentsOf")(function* (argv: ReadonlyArray<string>) {
	const parsed = yield* Effect.try({
		try: () =>
			parseArgs({
				args: Arr.copy(argv),
				allowPositionals: true,
				options: { changed: { type: "boolean", default: false }, logs: { type: "string" } }
			}),
		catch: failureFrom(
			"pnpm plants [--logs DIR] (--changed [<directory>...] | <test or plant>...): name the tests whose plants to run, or the plants, or --changed"
		)
	})
	const named = parsed.positionals
	const asked: Result.Result<Asked, string> = parsed.values.changed
		? Result.succeed({
				kind: "changed",
				within: Arr.isReadonlyArrayNonEmpty(named)
					? Option.some(
							Arr.map(named, (directory) =>
								Str.endsWith("/")(directory) ? directory : `${directory}/`
							)
						)
					: Option.none()
			})
		: Arr.isReadonlyArrayNonEmpty(named)
			? Result.succeed({ kind: "named", names: named })
			: Result.fail("Name the tests whose plants to run, or the plants, or pass --changed")
	const chosen = yield* Result.match(asked, {
		onFailure: (detail) => Effect.fail(DevtoolFailure.make({ detail })),
		onSuccess: (value) => Effect.succeed(value)
	})
	return { asked: chosen, logs: Option.fromNullishOr(parsed.values.logs) }
})

/** The files each of `plants` changes, read once each, as many at once as the machine has cores. */
const filesOf = Effect.fn("filesOf")(function* (root: string, plants: ReadonlyArray<string>) {
	const entries = yield* Effect.forEach(
		plants,
		(plant) => Effect.map(touchedBy(root, plant), (files) => [plant, files] as const),
		{ concurrency: availableParallelism() }
	)
	const files: ReadonlyMap<string, ReadonlyArray<string>> = new Map(entries)
	return files
})

/** The blob of each of `paths` as the tree holds it, in one `git hash-object`, absent where the tree has no file. */
const blobsOf = Effect.fn("blobsOf")(function* (root: string, paths: ReadonlyArray<string>) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const present = yield* Effect.filter(paths, (file) =>
		fs.exists(path.join(root, file)).pipe(Effect.mapError(failureFrom(`${file} could not be read`)))
	)
	const hashed = Arr.isReadonlyArrayNonEmpty(present)
		? yield* git(root, ["hash-object", "--", ...present])
		: ""
	const ids = Arr.filter(Str.split("\n")(hashed), Str.isNonEmpty)
	const blobs: ReadonlyMap<string, Blob> = new Map(
		Arr.zip(
			present,
			Arr.map(ids, (id): Blob => ({ kind: "blob", id }))
		)
	)
	return blobs
})

/**
 * Each citation's key (verdicts.ts keyOf): the content of its plant, its test and the files its plant changes, as the
 * tree holds them with no plant planted.
 */
const keysOf = Effect.fn("keysOf")(function* (root: string, pairs: ReadonlyArray<Pair>) {
	const files = yield* filesOf(root, Arr.dedupe(Arr.map(pairs, (pair) => pair.plant)))
	const filesOfPlant = (plant: string): ReadonlyArray<string> => files.get(plant) ?? []
	const blobs = yield* blobsOf(
		root,
		Arr.dedupe(Arr.flatMap(pairs, (pair) => [pair.plant, pair.test, ...filesOfPlant(pair.plant)]))
	)
	const blobOf = (file: string): Blob => blobs.get(file) ?? { kind: "absent" }
	return {
		files,
		keyed: Arr.map(
			pairs,
			(pair) =>
				[
					pair,
					keyOf({
						plant: [pair.plant, blobOf(pair.plant)],
						test: [pair.test, blobOf(pair.test)],
						files: Arr.map(filesOfPlant(pair.plant), (file) => [file, blobOf(file)] as const)
					})
				] as const
		)
	}
})

/** The key of a citation by its plant and test, from keysOf's list. */
const keyIn = (keyed: ReadonlyArray<readonly [Pair, string]>) => {
	const byPair: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
		Arr.map(
			Arr.dedupe(Arr.map(keyed, ([pair]) => pair.plant)),
			(plant) =>
				[
					plant,
					new Map(
						Arr.map(
							Arr.filter(keyed, ([pair]) => pair.plant === plant),
							([pair, key]) => [pair.test, key] as const
						)
					)
				] as const
		)
	)
	return (plant: string, test: string) => Option.fromUndefinedOr(byPair.get(plant)?.get(test))
}

/** The verdict a run keeps, red or green; an unjudged or stale one judges nothing to keep. */
const keptOf = (verdict: Verdict): Option.Option<Kept> =>
	verdict === "red" || verdict === "green" ? Option.some(verdict) : Option.none()

/** A verdict's line: the verdict, the plant and the test. */
const lineOf = (judged: Judged): string =>
	`${Str.padEnd(9)(judged.verdict)}${judged.plant}  ${judged.test}`

/**
 * `pnpm plants`: each plant planted in turn, the tests that cite it run against it, and the plant taken out again.
 *
 *   pnpm plants [--logs DIR] <test or plant>...
 *   pnpm plants [--logs DIR] --changed [<directory>...]
 *
 * A test named runs against each plant it cites; a plant named runs against every test that cites it; --changed runs
 * every citation with no verdict kept for its content (verdicts.ts): the blobs of its plant, its test and the files its
 * plant changes, as the tree holds them. Every red or green verdict a run reaches is kept under its citation's key in the
 * user's cache, so a verdict nothing has moved is never computed again, and only a change of that content makes a
 * citation due again. Directories named after --changed keep it to the tests under them, so a run can go a tier at a
 * time. It refuses to start while the check finds anything (scripts/dev/plants/check.ts) or while any
 * file a plant changes differs from HEAD, so taking a plant out restores exactly what was there. Each test first runs
 * once with no plant planted; then each plant, one at a time, goes in, its tests run one at a time through their tier's
 * script (test/support/tiers.ts), and it comes out, on success, failure or interruption alike. A network test runs on
 * the cluster the environment names (GRIZZLE_PG_CLUSTER), as `pnpm test:network` does.
 *
 * It prints one line per plant and test, red, green, stale or unjudged, then for --changed each kept verdict that is not
 * red, and the directory of every run's log, and exits 0 when every line is red and 1 otherwise: a green plant is a bug no test catches, a stale one plants nothing, and an
 * unjudged one's test fails with no plant at all.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* repositoryRoot
	const { asked, logs: given } = yield* argumentsOf(process.argv.slice(2))
	const tree = yield* readTree(root)
	const findings = findingsOf(tree)
	if (Arr.isReadonlyArrayNonEmpty(findings)) {
		return yield* DevtoolFailure.make({
			detail: `The plant check finds ${findings.length} things, so no plant runs:\n${Arr.join(Arr.map(findings, findingText), "\n")}`
		})
	}
	const directory = yield* verdictDirectory
	const scoped =
		asked.kind === "changed"
			? Option.some(
					Arr.filter(pairsOf(tree), (pair) =>
						Option.match(asked.within, {
							onNone: () => true,
							onSome: (directories) =>
								Arr.some(directories, (directory) => Str.startsWith(directory)(pair.test))
						})
					)
				)
			: Option.none()
	const everyKey = yield* Effect.transposeOption(Option.map(scoped, (pairs) => keysOf(root, pairs)))
	const kept = yield* Option.match(everyKey, {
		onNone: () => Effect.succeed<ReadonlyArray<readonly [Pair, Kept]>>([]),
		onSome: ({ keyed }) =>
			Effect.map(
				Effect.forEach(keyed, ([pair, key]) =>
					Effect.map(keptAt(directory, key), (verdict) =>
						Option.toArray(Option.map(verdict, (found) => [pair, found] as const))
					)
				),
				Arr.flatten
			)
	})
	const targets: Targets =
		asked.kind === "changed"
			? {
					kind: "changed",
					known: new Map(
						Arr.map(
							Arr.dedupe(Arr.map(kept, ([pair]) => pair.plant)),
							(plant) =>
								[
									plant,
									new Set(
										Arr.map(
											Arr.filter(kept, ([pair]) => pair.plant === plant),
											([pair]) => pair.test
										)
									)
								] as const
						)
					),
					within: asked.within
				}
			: asked
	const trials = yield* Result.match(planOf(tree, targets), {
		onFailure: (unknown) =>
			Effect.fail(
				DevtoolFailure.make({
					detail: `Neither a test citing a plant nor a plant a test cites: ${Arr.join(unknown, ", ")}`
				})
			),
		onSuccess: (planned) => Effect.succeed(planned)
	})
	const planned = Arr.flatMap(trials, (trial) =>
		Arr.map(trial.tests, (test): Pair => ({ plant: trial.plant, test }))
	)
	const { files, keyed } = yield* Option.match(everyKey, {
		onNone: () => keysOf(root, planned),
		onSome: (keys) => Effect.succeed(keys)
	})
	const keyOfPair = keyIn(keyed)
	const touched = Arr.dedupe(Arr.flatMap(trials, (trial) => files.get(trial.plant) ?? []))
	const dirty = yield* changedAmong(root, touched)
	if (Arr.isReadonlyArrayNonEmpty(dirty)) {
		return yield* DevtoolFailure.make({
			detail: `Files the plants change differ from HEAD, so taking a plant out could not restore them: commit or set them aside first.\n${Arr.join(dirty, "\n")}`
		})
	}
	const logs = yield* Option.match(given, {
		onNone: () => fs.makeTempDirectory({ prefix: "grizzle-plants-" }),
		onSome: (dir) => Effect.as(fs.makeDirectory(dir, { recursive: true }), dir)
	}).pipe(Effect.mapError(failureFrom("The log directory could not be made")))
	const tests = Arr.dedupe(Arr.flatMap(trials, (trial) => trial.tests))
	yield* Console.log(`${trials.length} plants against ${tests.length} tests; logs in ${logs}`)
	const baselines = yield* Effect.forEach(tests, (test) =>
		Effect.tap(
			Effect.map(runTest(root, logs, "baseline", test), (ran) => [test, ran.passed] as const),
			([, passed]) =>
				Console.log(`${Str.padEnd(9)(passed ? "passes" : "FAILS")}(no plant)  ${test}`)
		)
	)
	const baseline = new Map(baselines)
	const trialLines = yield* Effect.forEach(trials, (trial) =>
		Effect.tap(trialOf(root, logs, baseline, trial), (lines) =>
			Effect.forEach(lines, (line) => Console.log(lineOf(line)), { discard: true })
		)
	)
	const judged = Arr.flatten(trialLines)
	yield* Effect.forEach(
		judged,
		(line) =>
			Option.match(
				Option.zipWith(keptOf(line.verdict), keyOfPair(line.plant, line.test), (verdict, key) =>
					keep(directory, key, verdict)
				),
				{ onNone: () => Effect.void, onSome: (keeping) => keeping }
			),
		{ discard: true }
	)
	const recalled = Arr.filter(kept, ([, verdict]) => verdict !== "red")
	yield* Effect.forEach(
		recalled,
		([pair, verdict]) =>
			Console.log(`${Str.padEnd(9)(verdict)}${pair.plant}  ${pair.test}  (kept)`),
		{ discard: true }
	)
	const unred = [
		...Arr.filter(judged, (line) => line.verdict !== "red"),
		...Arr.map(recalled, ([pair, verdict]): Judged => ({ ...pair, verdict }))
	]
	yield* Console.log(
		Arr.isReadonlyArrayNonEmpty(unred)
			? `${unred.length} of ${judged.length} plant and test pairs are not red:\n${Arr.join(Arr.map(unred, lineOf), "\n")}\nlogs in ${logs}`
			: `every one of ${judged.length} plant and test pairs is red; logs in ${logs}`
	)
	return Arr.isReadonlyArrayNonEmpty(unred) ? 1 : 0
})

runDevtool(main)
