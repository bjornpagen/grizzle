import { defineTestConfig } from "@bjornpagen/testing/vitest/config"

export default defineTestConfig({
	include: ["test/**/*.test.ts"],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: 120_000 },
		hook: { kind: "bounded", millis: 120_000 }
	},
	smallStack: []
})
