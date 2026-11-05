import { defineTestConfig } from "@grizzle/testing/vitest/config"
import { Option } from "effect"

/**
 * `pnpm test`: the tests that need no network, the unit tier, the type tier and the testing library's own suite. The type tier's checks are one tsgo
 * program, built once per run by its global setup while the files run (test/types/batch/global-setup.ts). A file named
 * `<name>.exclusive.test.ts` runs alone, after every other. The engine's generative suites of the SQL printer and audit,
 * the lowerings, the migration drafter and the write compiler, and the canonical serializer's and the shapes', which read
 * values nested to any depth, run a second time in the small-stack project, at about a sixth of Node's default stack.
 */
export default defineTestConfig({
	include: [
		"test/unit/**/*.test.ts",
		"test/types/**/*.test.ts",
		"packages/testing/src/**/*.test.ts"
	],
	exclusive: ["test/unit/**/*.exclusive.test.ts", "test/types/**/*.exclusive.test.ts"],
	guided: ["packages/testing/src/sense.test.ts"],
	setup: ["test/types/batch/global-setup.ts"],
	conditions: ["grizzle-source"],
	timeouts: {
		test: { kind: "bounded", millis: 3_600_000 },
		hook: { kind: "bounded", millis: 120_000 }
	},
	maxWorkers: Option.none(),
	smallStack: [
		"test/unit/sql/**/*.test.ts",
		"test/unit/lower/**/*.test.ts",
		"test/unit/deploy/**/*.test.ts",
		"test/unit/write/**/*.test.ts",
		"test/unit/core/lines.test.ts",
		"test/unit/core/canonical.test.ts",
		"test/unit/ir/shape.test.ts"
	]
})
