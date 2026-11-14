import { defineTestConfig } from "@bjornpagen/testing/vitest/config"

/**
 * `pnpm test`: every suite but the grizzle tier (test/grizzle), which needs grizzle's checkout and its PostgreSQL
 * cluster and runs on its own as `pnpm test:grizzle` (vitest.grizzle.config.ts).
 */
export default defineTestConfig({
	include: ["test/**/*.test.ts", "!test/grizzle/**"],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: 120_000 },
		hook: { kind: "bounded", millis: 120_000 }
	},
	smallStack: []
})
