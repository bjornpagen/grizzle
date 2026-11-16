import { defineTestConfig } from "@bjornpagen/testing/vitest/config"
import { Array as Arr } from "effect"
import { unitExamples } from "#test/support/examples.ts"
import { hangLimit } from "#test/support/limits.ts"
import { propertyModules, smallStackModules } from "#test/support/roster.ts"
import { includeOf, tiers } from "#test/support/tiers.ts"

/** The property modules toolchain-test runs (test/support/roster.ts), each left out of every project here. */
const leftToRunner = Arr.map(propertyModules, (glob) => `!${glob}`)

/**
 * The small-stack modules (test/support/roster.ts), left out of the default project: each runs once, in the small-stack
 * project. A case that passes on the small stack passes on the default one, as the engine reads nothing of how much
 * stack it has (it catches no stack overflow), and both projects draw the same cases under the run's seed, so a second
 * run on the default stack would repeat the small-stack run and find nothing it cannot.
 */
const smallStackOnly = Arr.map(smallStackModules, (glob) => `!${glob}`)

/**
 * `pnpm test`: the tests that need no network, the unit tier. The type tier runs on the toolchain's runner
 * (test.config.ts). The engine's generative suites of the SQL printer and audit,
 * the lowerings, the migration drafter, the write compiler and the text refinements, and the canonical serializer's and
 * the shapes', which read values nested to any depth, run in the small-stack project alone, at about a sixth of Node's
 * default stack (smallStackOnly). The rewrite universe runs on the default stack: its plans are a few operators over
 * facts of two rows, which reach no width the stack bounds, and the generated rewrite suites run the same pipeline under
 * the small stack.
 *
 * No test is bounded by the clock: each search runs exactly its counted budget, however busy the machine is, and a case
 * that never ends is reported hung at the hang limit (limits.ts caseHang). A hook is bounded by the hang limit, so a
 * setup that never ends is reported under its hook's name. Every test case runs a search, outside the files
 * test/support/examples.ts exempts, each set with its reason. A test module converted to properties runs under
 * toolchain-test instead (test.config.ts), and is left out here, small-stack project included; the list of them and
 * the small-stack modules are test/support/roster.ts's, which both runners read, so they cannot drift apart.
 */
export default defineTestConfig({
	include: [...includeOf(tiers.unit), ...leftToRunner, ...smallStackOnly],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "unbounded" },
		hook: { kind: "bounded", millis: hangLimit }
	},
	smallStack: [...smallStackModules, ...leftToRunner],
	examples: unitExamples
})
