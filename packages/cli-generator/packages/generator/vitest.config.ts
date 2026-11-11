import { defineTestConfig } from "@superstarter/testing/vitest/config"
import { Option } from "effect"

export default defineTestConfig({
	include: ["test/**/*.test.ts"],
	exclusive: [],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: 120_000 },
		hook: { kind: "bounded", millis: 120_000 }
	},
	maxWorkers: Option.none(),
	smallStack: []
})
