import { defineTestConfig } from "@grizzle/testing/vitest/config"
import { Option } from "effect"

/**
 * `pnpm test`: the tests that need no network, the unit tier, the type tier and the testing library's own suite. The type tier's checks are one tsgo
 * program, built once per run by its global setup while the files run (test/types/batch/global-setup.ts). A file named
 * `<name>.exclusive.test.ts` runs alone, after every other.
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
	maxWorkers: Option.none()
})
