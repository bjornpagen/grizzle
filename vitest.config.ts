import { defineTestConfig } from "@bjornpagen/testing/vitest/config"
import { testTimeout } from "#test/support/limits.ts"

/**
 * `pnpm test`: the tests that need no network, the unit tier and the type tier. The type tier's checks are one tsgo
 * program, built once per run by its global setup while the files run (test/types/batch/global-setup.ts). The engine's
 * generative suites of the SQL printer and audit,
 * the lowerings, the migration drafter, the write compiler and the text refinements, and the canonical serializer's and
 * the shapes', which read values nested to any depth, run a second time in the small-stack project, at about a sixth of
 * Node's default stack. The rewrite universe runs once: its plans are a few operators over facts of two rows, which reach
 * no width the stack bounds, and the generated rewrite suites run the same pipeline under the small stack.
 */
export default defineTestConfig({
	include: ["test/unit/**/*.test.ts", "test/types/**/*.test.ts"],
	guided: [],
	setup: ["test/types/batch/global-setup.ts"],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: testTimeout.value },
		hook: { kind: "bounded", millis: testTimeout.value }
	},
	smallStack: [
		"test/unit/sql/**/*.test.ts",
		"test/unit/lower/*.test.ts",
		"test/unit/lower/!(rewrite)/**/*.test.ts",
		"test/unit/lower/rewrite/!(universe).test.ts",
		"test/unit/deploy/**/*.test.ts",
		"test/unit/write/**/*.test.ts",
		"test/unit/text/**/*.test.ts",
		"test/unit/core/lines.test.ts",
		"test/unit/core/canonical.test.ts",
		"test/unit/ir/shape.test.ts"
	]
})
