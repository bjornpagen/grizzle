import { defineTestConfig } from "@bjornpagen/testing/vitest/config"

/**
 * `pnpm test:network`: the tests that talk to the local PostgreSQL cluster, the pg tier and the schedules tier. The
 * global setup refuses to start unless the cluster passes the doctor's quick checks, sweeps what ended runs left, and
 * clones one shared database per worker (test/support/pg-global-setup.ts); its teardown sweeps again. Every file runs
 * beside every other on one cluster's SSI state, whose pool of finished SERIALIZABLE transactions, ten per backend,
 * fills while any transaction stays open (CONTRIBUTING.md): at one file per core one held open for seconds makes SSI
 * summarize every file's, so none holds one past its work. The world model's random suite steers by V8's block
 * coverage of the code under test.
 *
 * No test is bounded by the clock: each search runs exactly its counted budget, however busy the machine and the
 * cluster are, and a case that never ends is reported hung at the hang limit (limits.ts caseHang). A hook takes as long
 * as it takes: a suite's layer build may wait for a slot of the cluster-wide connection lease behind other runs' files,
 * as long as they hold it (substrate/shared.ts leaseConnections), and a wait for a resource others hold is no hang;
 * what the build does once it holds its lease is bounded by the hang limit (substrate/substrate.ts heldBuild). The
 * library runs one file per worker, testWorkers of them, and the setup clones a database for each
 * (substrate/workers.ts).
 */
export default defineTestConfig({
	include: ["test/pg/**/*.test.ts", "test/schedules/**/*.test.ts"],
	guided: ["test/pg/world-model/random.test.ts"],
	setup: ["test/support/pg-global-setup.ts"],
	conditions: [],
	timeouts: {
		test: { kind: "unbounded" },
		hook: { kind: "unbounded" }
	},
	smallStack: []
})
