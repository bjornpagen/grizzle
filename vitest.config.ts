import { defineTestConfig } from "@bjornpagen/testing/vitest/config"
import { unitExamples } from "#test/support/examples.ts"
import { hangLimit } from "#test/support/limits.ts"

/**
 * `pnpm test`: the tests that need no network, the unit tier and the type tier. The type tier's checks are one tsgo
 * program, built once per run by its global setup while the files run (test/types/batch/global-setup.ts). The engine's
 * generative suites of the SQL printer and audit,
 * the lowerings, the migration drafter, the write compiler and the text refinements, and the canonical serializer's and
 * the shapes', which read values nested to any depth, run a second time in the small-stack project, at about a sixth of
 * Node's default stack. The rewrite universe runs once: its plans are a few operators over facts of two rows, which reach
 * no width the stack bounds, and the generated rewrite suites run the same pipeline under the small stack.
 *
 * No test is bounded by the clock: each search runs exactly its counted budget, however busy the machine is, and a case
 * that never ends is reported hung at the hang limit (limits.ts caseHang). A hook is bounded by the hang limit, so a
 * setup that never ends is reported under its hook's name. Every test case runs a search, outside the files
 * test/support/examples.ts exempts, each set with its reason.
 */
export default defineTestConfig({
	include: ["test/unit/**/*.test.ts", "test/types/**/*.test.ts"],
	guided: [],
	setup: ["test/types/batch/global-setup.ts"],
	conditions: [],
	timeouts: {
		test: { kind: "unbounded" },
		hook: { kind: "bounded", millis: hangLimit.value }
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
	],
	examples: unitExamples
})
