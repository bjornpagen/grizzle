import { defineTestConfig } from "@bjornpagen/testing/vitest/config"
import { mergeConfig } from "vitest/config"
import { derived, type Limit } from "#compiler/core/limits.ts"
import { hangLimit } from "#test/support/limits.ts"

/**
 * How long one test or hook of a mutation tester's run may take: the hang limit, since a mutant can make any test
 * loop forever, where the test tiers' own tests are unbounded and run their counted budgets.
 */
const mutationTestTimeout: Limit = derived({
	owner: "grizzle's mutation tester",
	unit: "milliseconds",
	scope:
		"one Vitest test or hook of a run of the mutation tester (main.ts runFiles), on the unmutated tree or a mutant's",
	from: [hangLimit],
	derivation:
		"a run's files are the test tiers' own: the unit project's in stage 1, and in stage 2 the network tier's PostgreSQL files or the oracle subset, which runs the network tier's oracles over fewer cases; the hang limit's measurement is of whole files of those tiers, so a test of them ends within it on the machine it was measured on, and a mutant that loops is cut there",
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
 * end (take-coverage.ts), which a coverage pass reads. Examples are allowed: the tiers' own configs refuse a test case
 * that runs no search, and a mutant is judged by its tests' verdicts alone; main.ts names its run's reporters, which
 * replace the configured ones, so no run of it reads this stance anyway.
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
		conditions: [],
		timeouts: {
			test: { kind: "bounded", millis: mutationTestTimeout.value },
			hook: { kind: "bounded", millis: mutationTestTimeout.value }
		},
		smallStack: [],
		examples: { kind: "allowed" }
	}),
	{ test: { setupFiles: [`${import.meta.dirname}/take-coverage.ts`] } }
)
