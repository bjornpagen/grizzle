import { defineTestConfig } from "@grizzle/testing/vitest/config"
import { Option } from "effect"
import { mergeConfig } from "vitest/config"
import { derived, type Limit } from "#compiler/core/limits.ts"
import { testTimeout } from "#test/support/limits.ts"

/**
 * How long one test or hook of a mutation tester's run may take: as long as the same test may under the test tiers, so
 * a coverage pass runs the unmutated tree as `pnpm test` would.
 */
const mutationTestTimeout: Limit = derived({
	owner: "grizzle's mutation tester",
	unit: "milliseconds",
	scope:
		"one Vitest test or hook of a run of the mutation tester (main.ts runFiles), on the unmutated tree or a mutant's",
	from: [testTimeout],
	derivation:
		"a run's files are the test tiers' own: the unit project's in stage 1, and in stage 2 the network tier's PostgreSQL files or the oracle subset, which runs the network tier's oracles over fewer cases; so a test of them may run as long as its tier lets it",
	compute: ([test]) => test.value
})

/**
 * The mutation tester's own Vitest config (main.ts runFiles), which every run of a mutant's files names with --config:
 * stage 1's unit files, stage 2's oracle subset (oracle/*.test.ts, which no test run runs), and the PostgreSQL files
 * --stage2 may name. It has no global setup of its own, as its runs have none of `pnpm test`'s concerns: a run of
 * PostgreSQL files claims and clones the shared databases it needs (test/support/substrate/shared.ts), and no type test
 * runs. Its tests and hooks are bounded by mutationTestTimeout, timers of their test process that a mutant looping
 * without yielding never lets fire, so the mutation tester's reporter also bounds each file (reporter.ts fileTimeout),
 * and main.ts kills a run with a file the reporter calls hung. Every file's process takes its coverage when its tests
 * end (take-coverage.ts), which a coverage pass reads.
 */
export default mergeConfig(
	defineTestConfig({
		include: [
			"test/unit/**/*.test.ts",
			"test/pg/**/*.test.ts",
			"test/schedules/**/*.test.ts",
			"scripts/dev/mutate/oracle/*.test.ts"
		],
		guided: ["test/pg/world-model/random.test.ts"],
		setup: [],
		conditions: ["grizzle-source"],
		timeouts: {
			test: { kind: "bounded", millis: mutationTestTimeout.value },
			hook: { kind: "bounded", millis: mutationTestTimeout.value }
		},
		maxWorkers: Option.none(),
		smallStack: []
	}),
	{ test: { setupFiles: [`${import.meta.dirname}/take-coverage.ts`] } }
)
