import { Array as Arr, Record } from "effect"
import type { DummyRuleMap } from "oxlint"
import type { Rule } from "#oxlint/rule.ts"
import { noBooleanAssert } from "#oxlint/rules/no-boolean-assert.ts"
import { noErrorProse } from "#oxlint/rules/no-error-prose.ts"
import { noExampleTable } from "#oxlint/rules/no-example-table.ts"
import { noFixedSeed } from "#oxlint/rules/no-fixed-seed.ts"
import { noOrderedUnordered } from "#oxlint/rules/no-ordered-unordered.ts"
import { noRetryOrConcurrency } from "#oxlint/rules/no-retry-or-concurrency.ts"
import { noSerializedComparison } from "#oxlint/rules/no-serialized-comparison.ts"
import { noSleepWait } from "#oxlint/rules/no-sleep-wait.ts"
import { noWallClockVerdict } from "#oxlint/rules/no-wall-clock-verdict.ts"

/** Every rule of the plugin, by its name. */
const RULES = {
	"no-boolean-assert": noBooleanAssert,
	"no-error-prose": noErrorProse,
	"no-example-table": noExampleTable,
	"no-fixed-seed": noFixedSeed,
	"no-ordered-unordered": noOrderedUnordered,
	"no-retry-or-concurrency": noRetryOrConcurrency,
	"no-serialized-comparison": noSerializedComparison,
	"no-sleep-wait": noSleepWait,
	"no-wall-clock-verdict": noWallClockVerdict
} as const satisfies Readonly<Record<string, Rule>>

/**
 * The testing library's oxlint plugin: each rule refuses a brittle test shape and names the expressive API that
 * replaces it. A consuming configuration loads it through `jsPlugins` and scopes its rules to test files; the rules
 * read syntax alone and know nothing of file names.
 */
const plugin: Readonly<{ meta: Readonly<{ name: string }>; rules: typeof RULES }> = {
	meta: { name: "testing" },
	rules: RULES
}

export default plugin

const LAYERS_REPLACE_MOCKS =
	"A mock couples the test to how the code calls its dependency. Provide the dependency's test implementation as an Effect Layer and assert the outcome."
const TEST_CLOCK_REPLACES_TIMERS =
	"Fake timers patch globals behind Effect's back. Move time with TestClock under it.effect."
const SNAPSHOTS_HOLD_IRRELEVANT_DETAIL =
	"A snapshot is a golden copy of every detail, relevant or not, and fails for innocuous changes. Assert what the contract promises with agree under a named equivalence."
const CALLS_ARE_NOT_THE_CONTRACT =
	"How often and in which order a dependency was called is the implementation, not the contract. Assert the outcome the contract promises."

/**
 * oxlint's own Vitest rules as the library recommends them for test files, to spread into the block that scopes the
 * plugin's rules. They need oxlint's `vitest` plugin enabled in that block. A test runs every time, unconditionally,
 * under a title of its own; it replaces collaborators with Effect layers and moves time with TestClock instead of
 * mocking and faking timers; and it asserts the contract instead of snapshots or call counts.
 */
export const VITEST_RULES = {
	"vitest/no-conditional-tests": "error",
	"vitest/no-disabled-tests": "error",
	"vitest/no-focused-tests": "error",
	"vitest/no-identical-title": "error",
	"vitest/no-import-node-test": "error",
	"vitest/no-standalone-expect": "error",
	"vitest/valid-title": "error",
	"vitest/no-restricted-vi-methods": [
		"error",
		{
			mock: LAYERS_REPLACE_MOCKS,
			doMock: LAYERS_REPLACE_MOCKS,
			spyOn: LAYERS_REPLACE_MOCKS,
			fn: LAYERS_REPLACE_MOCKS,
			useFakeTimers: TEST_CLOCK_REPLACES_TIMERS,
			advanceTimersByTime: TEST_CLOCK_REPLACES_TIMERS,
			advanceTimersToNextTimer: TEST_CLOCK_REPLACES_TIMERS,
			runAllTimers: TEST_CLOCK_REPLACES_TIMERS
		}
	],
	"vitest/no-restricted-matchers": [
		"error",
		{
			toMatchSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toMatchInlineSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toMatchFileSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toThrowErrorMatchingSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toThrowErrorMatchingInlineSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toHaveBeenCalledTimes: CALLS_ARE_NOT_THE_CONTRACT,
			toHaveBeenLastCalledWith: CALLS_ARE_NOT_THE_CONTRACT,
			toHaveBeenNthCalledWith: CALLS_ARE_NOT_THE_CONTRACT
		}
	]
} as const satisfies DummyRuleMap

/**
 * What a repository holds its test files to: every rule of the plugin at error, under the name the plugin loads as,
 * and oxlint's own Vitest rules as the library recommends them.
 */
export const TEST_RULES: DummyRuleMap = {
	...Record.fromEntries(
		Arr.map(Record.keys(RULES), (rule): readonly [string, "error"] => [
			`${plugin.meta.name}/${rule}`,
			"error"
		])
	),
	...VITEST_RULES
}

/** The plugin's rule that refuses a read of the current time. */
const CLOCK_RULE: keyof typeof RULES = "no-wall-clock-verdict"

/**
 * What a repository holds its clock-free code to beyond its test files, the testing library and the tests' support
 * modules: the plugin's clock rule, so no verdict rests on a hidden clock, an input the run's seed does not bind. A
 * module whose job is the clock (a case's hang guard, a lease's timeout) is the repository's own exception.
 */
export const CLOCK_RULES: DummyRuleMap = {
	[`${plugin.meta.name}/${CLOCK_RULE}`]: "error"
}
