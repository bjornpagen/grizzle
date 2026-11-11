import { Option } from "effect"
import { defineTestConfig } from "#vitest/config.ts"

export default defineTestConfig({
	include: ["src/**/*.test.ts"],
	exclusive: [],
	guided: ["src/sense.test.ts"],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: 60_000 },
		hook: { kind: "bounded", millis: 60_000 }
	},
	maxWorkers: Option.none(),
	smallStack: []
})
