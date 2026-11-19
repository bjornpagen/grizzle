import { availableParallelism } from "node:os"
import { DevtoolFailure } from "@bjornpagen/devtools/devtool"
import { runDevtool } from "@bjornpagen/devtools/run"
import { Array as Arr, Cause, Console, Effect, Exit, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { propertyModules } from "#test/support/roster.ts"

/** The repository's root, from this script's place in it. */
const root = new URL("../..", import.meta.url).pathname

/** One child's verdict on its share: the modules it failed to import, each with why. */
const failedIn = (paths: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [import.meta.filename, "--share", ...paths], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
					killSignal: "SIGKILL"
				})
			)
			const [out, err, status] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(child.stdout)),
					Stream.mkString(Stream.decodeText(child.stderr)),
					child.exitCode
				],
				{ concurrency: "unbounded" }
			)
			return status === 0 ? [] : [`${out}${err}`]
		})
	)

/** A share's modules imported in turn: every one that throws as it loads, named with what it threw. */
const share = (paths: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const loaded = yield* Effect.forEach(paths, (path) =>
			Effect.map(
				Effect.exit(
					Effect.tryPromise({
						try: () => import(new URL(path, `file://${root}`).href),
						catch: (cause) => DevtoolFailure.make({ detail: `${path}: ${String(cause)}` })
					})
				),
				(exit) => [path, exit] as const
			)
		)
		const failed = Arr.flatMap(loaded, ([path, exit]) =>
			Exit.isFailure(exit) ? [`${path}: ${Cause.pretty(exit.cause)}`] : []
		)
		if (Arr.isReadonlyArrayNonEmpty(failed)) {
			return yield* DevtoolFailure.make({ detail: Arr.join(failed, "\n") })
		}
	})

/**
 * `pnpm load-modules`: every test module the runner runs (test/support/roster.ts propertyModules) imported, as every
 * full run (`toolchain-test run`, `pnpm mutate`) imports each before any case runs, so a module that throws as it loads
 * (a const read in its temporal dead zone, a template built from one) fails the check, named with what it threw, where
 * it failed every run that loads every module before anything ran. The modules are split over one child process per
 * core (availableParallelism), each importing its share in turn.
 */
const main = Effect.gen(function* () {
	const argv = process.argv.slice(2)
	if (argv[0] === "--share") {
		return yield* Effect.as(share(argv.slice(1)), 0)
	}
	const cores = availableParallelism()
	const shares = Arr.filter(
		Array.from({ length: cores }, (_, at) =>
			Arr.filter(propertyModules, (_module, index) => index % cores === at)
		),
		Arr.isReadonlyArrayNonEmpty
	)
	const verdicts = yield* Effect.forEach(shares, failedIn, { concurrency: "unbounded" })
	const failed = Arr.flatten(verdicts)
	if (Arr.isReadonlyArrayNonEmpty(failed)) {
		return yield* DevtoolFailure.make({ detail: Arr.join(failed, "\n") })
	}
	yield* Console.log(`load-modules: every one of the ${propertyModules.length} test modules loads`)
	return 0
})

runDevtool(main)
