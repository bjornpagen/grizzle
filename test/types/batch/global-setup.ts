import { NodeServices } from "@effect/platform-node"
import { RUN_KEY } from "@grizzle/testing/vitest/run"
import {
	Array as Arr,
	Cause,
	Clock,
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
import { typeRunKey } from "#test/types/batch/provided.ts"

/** The run's seed, as the testing library's global setup provided it to the root project before this one runs. */
const runSeedOf = (project: TestProject): number => project.getProvidedContext()[RUN_KEY].seed

/**
 * Starts the type-test batch of a run whose test modules are `moduleIds` (test/types/batch/batch.ts): it builds, in the
 * background, the groups of the run's type-test files as one tsgo program, while the files run, and provides the
 * run's seed and the file the result will be written to, which each type test waits for. The temporary directory and
 * the build live in the scope this runs in, so closing it removes the one and interrupts the other. A run without
 * type-test files provides no batch and loads nothing of it: the unit tier never pays for it.
 */
const startBatch = Effect.fn("startBatch")(function* (
	project: TestProject,
	moduleIds: ReadonlyArray<string>
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const seed = runSeedOf(project)
	const typeFiles = Arr.filterMap(moduleIds, (id) => {
		const relative = path.relative(project.config.root, id)
		return Str.startsWith("test/types/")(relative) ? Result.succeed(relative) : Result.failVoid
	})
	const groups = Arr.isReadonlyArrayNonEmpty(typeFiles)
		? (yield* Effect.promise(() => import("#test/types/batch/groups.ts"))).groupsFor(typeFiles)
		: []
	if (!Arr.isReadonlyArrayNonEmpty(groups)) {
		return yield* Effect.sync(() => project.provide(typeRunKey, { seed, batch: { kind: "none" } }))
	}
	const { writeBatch } = yield* Effect.promise(() => import("#test/types/batch/batch.ts"))
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-types-" })
	const file = path.join(dir, "batch.json")
	const started = yield* Clock.currentTimeMillis
	yield* Effect.forkScoped(
		writeBatch(groups, seed, file).pipe(
			Effect.andThen(Clock.currentTimeMillis),
			Effect.flatMap((now) =>
				Console.log(
					`types: the batch of ${groups.length} group(s) typechecked in ${((now - started) / 1000).toFixed(1)} s`
				)
			),
			Effect.catchCause((cause) =>
				Console.error(`types: the type-test batch failed\n${Cause.pretty(cause)}`)
			)
		)
	)
	yield* Effect.sync(() => project.provide(typeRunKey, { seed, batch: { kind: "batch", file } }))
})

/** The batch of a run, in a scope of its own, returned for the caller to close when the run's batch is done with. */
const startRun = (
	project: TestProject,
	moduleIds: ReadonlyArray<string>
): Promise<Scope.Closeable> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			yield* Scope.provide(startBatch(project, moduleIds), scope)
			return scope
		}).pipe(Effect.provide(NodeServices.layer))
	)

/**
 * Vitest's global setup of the type tier (vitest.config.ts), after the library's: it starts the batch of the files the
 * run collected before its global setup, and returns the teardown, which closes the batch once every file has ended.
 * Vitest's state is the one place a global setup learns the run's files; a watch-mode rerun, which runs no global
 * setup again, starts the batch of the files it reruns, after closing the previous run's.
 */
export const setup = (project: TestProject): Promise<() => Promise<void>> =>
	startRun(project, project.vitest.state.getPaths()).then((first) => {
		let current = first
		project.onTestsRerun((specifications) =>
			Effect.runPromise(Scope.close(current, Exit.void))
				.then(() =>
					startRun(
						project,
						Arr.map(specifications, (specification) => specification.moduleId)
					)
				)
				.then((next) => {
					current = next
				})
		)
		return () => Effect.runPromise(Scope.close(current, Exit.void))
	})
