import { Array as Arr, Duration, Effect, FiberMap, Option, Scope } from "effect"
import type { Reporter, SerializedError, TestCase, TestModule, TestSuite } from "vitest/node"
import { derived, type Limit } from "#compiler/core/limits.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { testTimeout } from "#test/support/limits.ts"

/**
 * One line a mutation run prints for main.ts to read: a failed test, by its file relative to the tree and its path of
 * suite and test names (`(file)` when the file itself failed: it did not load, or a hook outside every suite threw); a
 * file still running once fileTimeout has passed since Vitest queued it; or the run's end: done, or died, where a test
 * process failed with an error no file claims, as one that ran out of memory does.
 */
export type RunLine =
	| { readonly kind: "fail"; readonly file: string; readonly test: string }
	| { readonly kind: "hung"; readonly file: string }
	| { readonly kind: "done" }
	| { readonly kind: "died" }

/** What starts each of the reporter's lines, its RunLine's JSON after it: every other stdout line is Vitest's. */
export const runLineMarker = "GRIZZLE-MUTATE "

/**
 * How long one test file of a mutation run may run, from Vitest queueing it to its end, before the reporter calls it
 * hung. A test's and a hook's own timeouts (vitest.config.ts mutationTestTimeout) are timers of the file's test process,
 * which never fire while a mutant loops without yielding to its event loop; the reporter runs in Vitest's own process,
 * whose timers do.
 */
const fileTimeout: Limit = derived({
	owner: "grizzle's mutation tester",
	unit: "milliseconds",
	scope:
		"one test file of a run of the mutation tester (main.ts runFiles), from Vitest queueing it to its end, on the unmutated tree or a mutant's",
	from: [testTimeout],
	derivation:
		"testTimeout's own measurement is of whole files, and its value stands over the slowest passing file's run with headroom (its decision), so a file of the test tiers ends within it; a run's files are the tiers' own, the unit project's in stage 1, and in stage 2 the network tier's PostgreSQL files or the oracle subset, which runs the network tier's oracles over fewer cases; a coverage pass runs them under NODE_V8_COVERAGE, which the measurement did not, so a file whose coverage pass outruns the bound is cut there and its baseline records the run as failing",
	compute: ([test]) => test.value
})

/** Prints one line on stdout, at once: main.ts reads each as it comes. */
const print = (line: RunLine): void => {
	process.stdout.write(`${runLineMarker}${jsonText(line)}\n`)
}

/** The clock of one queued file, by its path relative to the tree: it calls the file hung once fileTimeout passes. */
const clockOf = (file: string): Effect.Effect<void> =>
	Effect.delay(
		Effect.sync(() => {
			print({ kind: "hung", file })
		}),
		Duration.millis(fileTimeout.value)
	)

/** The file a failure of `module` is charged to: its path relative to the tree, as main.ts names the files it runs. */
const failed = (module: TestModule, test: string): void => {
	print({ kind: "fail", file: module.relativeModuleId, test })
}

/** The test file an unhandled error names, when Vitest knows which file raised it. */
const pathOf = (error: SerializedError): Option.Option<string> => {
	const path = error["VITEST_TEST_PATH"]
	return typeof path === "string" ? Option.some(path) : Option.none()
}

/**
 * The mutation tester's reporter (main.ts runFiles): beside Vitest's default reporter, it prints one JSON line on
 * stdout per failed test as the test ends, so main.ts can stop a run at a first kill, one per suite whose own hooks
 * failed (a suite layer that did not build), one per file that failed outside every suite, one per unhandled error a
 * file raised, one for a file that runs past fileTimeout, after which main.ts kills the run, and one when the run ends,
 * which says the run died where an unhandled error names no file. A skipped or todo test never counts.
 */
export default class MutationReporter implements Reporter {
	/** The clock of each queued file that has not ended, by the file's Vitest id, in a scope as long as the reporter's. */
	readonly #clocks = Effect.runSync(
		Scope.provide(FiberMap.make<string, void, never>(), Scope.makeUnsafe())
	)

	readonly onTestModuleQueued = (testModule: TestModule): void => {
		Effect.runFork(FiberMap.run(this.#clocks, testModule.id, clockOf(testModule.relativeModuleId)))
	}

	readonly onTestCaseResult = (testCase: TestCase): void => {
		if (testCase.result().state === "failed") {
			failed(testCase.module, testCase.fullName)
		}
	}

	readonly onTestSuiteResult = (testSuite: TestSuite): void => {
		if (testSuite.state() === "failed" && testSuite.errors().length > 0) {
			failed(testSuite.module, testSuite.fullName)
		}
	}

	readonly onTestModuleEnd = (testModule: TestModule): void => {
		Effect.runFork(FiberMap.remove(this.#clocks, testModule.id))
		if (testModule.errors().length > 0) {
			failed(testModule, "(file)")
		}
	}

	readonly onTestRunEnd = (
		testModules: ReadonlyArray<TestModule>,
		unhandledErrors: ReadonlyArray<SerializedError>
	): void => {
		Effect.runFork(FiberMap.clear(this.#clocks))
		const claimed = Arr.map(unhandledErrors, (error) =>
			Option.flatMap(pathOf(error), (path) =>
				Arr.findFirst(testModules, (candidate) => candidate.moduleId === path)
			)
		)
		for (const module of Arr.getSomes(claimed)) {
			failed(module, "(file)")
		}
		print(Arr.some(claimed, Option.isNone) ? { kind: "died" } : { kind: "done" })
	}
}
