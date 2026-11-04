import { defineTestConfig } from "@grizzle/testing/vitest/config"
import { Option } from "effect"

/**
 * The mutation tester's own Vitest config (main.ts runFiles), which every run of a mutant's files names with --config:
 * stage 1's unit files, stage 2's oracle subset (oracle/*.test.ts, which no test run runs), and the PostgreSQL files
 * --stage2 may name. It has no global setup of its own, as its runs have none of `pnpm test`'s concerns: a run of
 * PostgreSQL files claims and clones the shared databases it needs (test/support/substrate/shared.ts), and no type test
 * runs. Its tests and hooks take as long as they take: main.ts bounds each run with its own budget, and kills a run
 * that outlives it.
 */
export default defineTestConfig({
	include: [
		"test/unit/**/*.test.ts",
		"test/pg/**/*.test.ts",
		"test/schedules/**/*.test.ts",
		"scripts/dev/mutate/oracle/*.test.ts"
	],
	exclusive: ["**/*.exclusive.test.ts"],
	guided: ["test/pg/world-model/random.test.ts"],
	setup: [],
	conditions: ["grizzle-source"],
	timeouts: { test: { kind: "unbounded" }, hook: { kind: "unbounded" } },
	maxWorkers: Option.none(),
	smallStack: []
})
