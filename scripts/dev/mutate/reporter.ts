import { Array as Arr, Effect, Option, Schema } from "effect"
import type { Reporter, SerializedError, TestCase, TestModule, TestSuite } from "vitest/node"

/**
 * One line a mutation run prints for main.ts to read: a failed test, by its file relative to the tree and its path of
 * suite and test names (`(file)` when the file itself failed: it did not load, or a hook outside every suite threw), or
 * the run's end.
 */
export const RunLine = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("fail"), file: Schema.String, test: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("done") })
])
export type RunLine = typeof RunLine.Type

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(RunLine))

/** Prints one line on stdout, at once: main.ts reads each as it comes. */
const print = (line: RunLine): void =>
	Effect.runSync(
		Effect.flatMap(Effect.orDie(encodeLine(line)), (text) =>
			Effect.sync(() => {
				process.stdout.write(`${text}\n`)
			})
		)
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
 * file raised, and one when the run ends. A skipped or todo test never counts.
 */
export default class MutationReporter implements Reporter {
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
		if (testModule.errors().length > 0) {
			failed(testModule, "(file)")
		}
	}

	readonly onTestRunEnd = (
		testModules: ReadonlyArray<TestModule>,
		unhandledErrors: ReadonlyArray<SerializedError>
	): void => {
		for (const error of unhandledErrors) {
			const module = Option.flatMap(pathOf(error), (path) =>
				Arr.findFirst(testModules, (candidate) => candidate.moduleId === path)
			)
			if (Option.isSome(module)) {
				failed(module.value, "(file)")
			}
		}
		print({ kind: "done" })
	}
}
