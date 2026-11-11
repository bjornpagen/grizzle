import { defineTestConfig } from "@grizzle/testing/vitest/config"
import { Option } from "effect"
import { testTimeout } from "#test/support/limits.ts"

/**
 * `pnpm test`: the tests that need no network, the unit tier, the type tier and the testing library's own suite. The type tier's checks are one tsgo
 * program, built once per run by its global setup while the files run (test/types/batch/global-setup.ts). The engine's
 * generative suites of the SQL printer and audit,
 * the lowerings, the migration drafter, the write compiler and the text refinements, and the canonical serializer's and
 * the shapes', which read values nested to any depth, run a second time in the small-stack project, at about a sixth of
 * Node's default stack.
 */
export default defineTestConfig({
	include: [
		"test/unit/**/*.test.ts",
		"test/types/**/*.test.ts",
		"packages/testing/src/**/*.test.ts"
	],
	guided: ["packages/testing/src/sense.test.ts"],
	setup: ["test/types/batch/global-setup.ts"],
	conditions: ["grizzle-source"],
	timeouts: {
		test: { kind: "bounded", millis: testTimeout.value },
		hook: { kind: "bounded", millis: testTimeout.value }
	},
	maxWorkers: Option.none(),
	smallStack: [
		"test/unit/sql/**/*.test.ts",
		"test/unit/lower/**/*.test.ts",
		"test/unit/deploy/**/*.test.ts",
		"test/unit/write/**/*.test.ts",
		"test/unit/text/**/*.test.ts",
		"test/unit/core/lines.test.ts",
		"test/unit/core/canonical.test.ts",
		"test/unit/ir/shape.test.ts"
	]
})
