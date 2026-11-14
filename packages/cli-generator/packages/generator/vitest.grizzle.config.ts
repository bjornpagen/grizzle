import { defineTestConfig } from "@bjornpagen/testing/vitest/config"

/**
 * `pnpm test:grizzle`: the suites that call a live grizzle server (test/grizzle), through the driver in grizzle's pinned
 * checkout (test/support/grizzle.ts), which needs vendor/grizzle checked out and a local PostgreSQL cluster of grizzle's
 * running: the one GRIZZLE_PG_CLUSTER names, a private one where other suites' load cannot stall a call.
 * Their fixture installs grizzle's packages, typechecks the driver, installs a login twice and builds a CLI before the
 * first case, so neither a test nor a hook is bounded by wall time: each case's hang guard is what catches one that
 * stops.
 */
export default defineTestConfig({
	include: ["test/grizzle/**/*.test.ts"],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: { test: { kind: "unbounded" }, hook: { kind: "unbounded" } },
	smallStack: []
})
