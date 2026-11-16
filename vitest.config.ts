import { defineTestConfig } from "@bjornpagen/testing/vitest/config"
import { Array as Arr } from "effect"
import properties from "#test.config.ts"
import { unitExamples } from "#test/support/examples.ts"
import { hangLimit } from "#test/support/limits.ts"
import { includeOf, tiers } from "#test/support/tiers.ts"

/** The property modules toolchain-test runs (test.config.ts), each left out of every project here. */
const leftToRunner = Arr.map(properties.include, (glob) => `!${glob}`)

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
 * test/support/examples.ts exempts, each set with its reason. A test module converted to properties runs under
 * toolchain-test instead (test.config.ts), and is left out here, small-stack project included; the small-stack modules
 * are the runner config's, so the two lists cannot drift apart.
 */
export default defineTestConfig({
	include: [...includeOf(tiers.unit), ...leftToRunner],
	guided: [],
	setup: ["test/types/batch/global-setup.ts"],
	conditions: [],
	timeouts: {
		test: { kind: "unbounded" },
		hook: { kind: "bounded", millis: hangLimit.value }
	},
	smallStack: [...properties.smallStack, ...leftToRunner],
	examples: unitExamples
})
