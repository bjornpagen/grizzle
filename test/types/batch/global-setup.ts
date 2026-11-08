import { NodeServices } from "@effect/platform-node"
import { RUN_KEY } from "@grizzle/testing/vitest/run"
import {
	Array as Arr,
	Cause,
	Console,
	Effect,
	Exit,
	FileSystem,
	Path,
	Result,
	Scope,
	String as Str
} from "effect"
import type { TestProject } from "vitest/node"
import { type TypeRun, typeRunKey } from "#test/types/batch/provided.ts"

/** The run's seed, as the testing library's global setup provided it to the root project before this one runs. */
const runSeedOf = (project: TestProject): number => project.getProvidedContext()[RUN_KEY].seed

/**
 * A run of the type tier as its global setup starts it: the repository's root, the run's seed, its test modules by
 * absolute path, the builder that builds its batch (build.ts), and how the run is handed to every test process.
 */
type TypeRunStart = Readonly<{
	root: string
	seed: number
	moduleIds: ReadonlyArray<string>
	builder: string
	provide: (run: TypeRun) => void
}>

/**
 * Starts the type-test batch of a run (test/types/batch/batch.ts): its builder, a process of its own, builds the groups
 * of the run's type-test files as one tsgo program while the files run, and this provides the run's seed and the file
 * the result will be written to, which each type test waits for. No program is drawn in this process, Vitest's own,
 * whose timers start every test process, so however long a build runs, it never holds them. The temporary directory and
 * the builder live in the scope this runs in, so closing it removes the one and kills the other. A run without
 * type-test files provides no batch and loads nothing of it: the unit tier never pays for it.
 */
export const startBatch = Effect.fn("startBatch")(function* (start: TypeRunStart) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const files = Arr.filterMap(start.moduleIds, (id) => {
		const relative = path.relative(start.root, id)
		return Str.startsWith("test/types/")(relative) ? Result.succeed(relative) : Result.failVoid
	})
	if (!Arr.isReadonlyArrayNonEmpty(files)) {
		return yield* Effect.sync(() => start.provide({ seed: start.seed, batch: { kind: "none" } }))
	}
	const { writeBatch } = yield* Effect.promise(() => import("#test/types/batch/batch.ts"))
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-types-" })
	const file = path.join(dir, "batch.json")
	yield* Effect.forkScoped(
		writeBatch({ seed: start.seed, files }, start.builder, file).pipe(
			Effect.andThen(
				Console.log(`types: the batch of ${files.length} type-test file(s) is written`)
			),
			Effect.catchCause((cause) =>
				Console.error(`types: the type-test batch failed\n${Cause.pretty(cause)}`)
			)
		)
	)
	yield* Effect.sync(() => start.provide({ seed: start.seed, batch: { kind: "batch", file } }))
})

/** The batch of a run, in a scope of its own, returned for the caller to close when the run's batch is done with. */
const startRun = (start: TypeRunStart): Promise<Scope.Closeable> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			yield* Scope.provide(startBatch(start), scope)
			return scope
		}).pipe(Effect.provide(NodeServices.layer))
	)

/**
 * Vitest's global setup of the type tier (vitest.config.ts), after the library's: it starts the batch of the files the
 * run collected before its global setup, and returns the teardown, which closes the batch once every file has ended.
 * Vitest's state is the one place a global setup learns the run's files; a watch-mode rerun, which runs no global
 * setup again, starts the batch of the files it reruns, after closing the previous run's.
 */
export const setup = (project: TestProject): Promise<() => Promise<void>> => {
	const startOf = (moduleIds: ReadonlyArray<string>): TypeRunStart => ({
		root: project.config.root,
		seed: runSeedOf(project),
		moduleIds,
		builder: `${import.meta.dirname}/build.ts`,
		provide: (run) => project.provide(typeRunKey, run)
	})
	return startRun(startOf(project.vitest.state.getPaths())).then((first) => {
		let current = first
		project.onTestsRerun((specifications) =>
			Effect.runPromise(Scope.close(current, Exit.void))
				.then(() =>
					startRun(startOf(Arr.map(specifications, (specification) => specification.moduleId)))
				)
				.then((next) => {
					current = next
				})
		)
		return () => Effect.runPromise(Scope.close(current, Exit.void))
	})
}
