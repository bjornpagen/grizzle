import { defineTestConfig } from "@bjornpagen/testing/vitest/config"
import { Array as Arr } from "effect"
import { propertyModules } from "#test/support/roster.ts"

/** The property modules toolchain-test runs (test/support/roster.ts), each left out here. */
const leftToRunner = Arr.map(propertyModules, (module) => `!${module}`)

/**
 * `pnpm test`: every suite not yet converted to properties. A module converted to properties runs under toolchain-test
 * instead (test.config.ts, `pnpm test:properties`) and is left out here; the list of them is test/support/roster.ts's,
 * which both runners read, so they cannot drift apart.
 */
export default defineTestConfig({
	include: ["test/**/*.test.ts", ...leftToRunner],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: 120_000 },
		hook: { kind: "bounded", millis: 120_000 }
	},
	smallStack: [],
	examples: { kind: "allowed" }
})
