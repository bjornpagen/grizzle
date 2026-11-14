/**
 * The test tiers' limits: every time a test, a case of its search or a test's own connection is bounded by, as a Limit
 * with its evidence (packages/engine/src/core/limits.ts). The tiers choose one number, how long a test may run,
 * measured on their own runs; every other bound a test reads derives from it, is a published constant, or is read from
 * the machine the tests run on.
 */
import { availableParallelism } from "node:os"
import { Duration } from "effect"
import { derived, type Limit, measured, published } from "#compiler/core/limits.ts"

/**
 * How long one test of `pnpm test` and `pnpm test:network` may run: the testTimeout of both tiers' Vitest configs, and
 * so the deadline every search of a test reads (Run.deadline), which stops a search PRINT_MARGIN_MILLIS before it to
 * report the case in flight or the smallest failing case its shrink reached. No test states a timeout of its own.
 */
export const testTimeout: Limit = measured({
	value: 3_600_000,
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one Vitest test of pnpm test or pnpm test:network, its hooks apart, in each test process alone",
	evidence:
		"node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json, Vitest's own record of each test file's last run (its duration, whether it failed, when it ran), SHA-256 4e9f397495c81884f158742f129f85e8c05f17b6ab00c1a3c384ddb37f7d0a6b when read on 2026-11-05",
	observed:
		"each file's last run between 2026-10-28 01:04 and 2026-11-05 04:30 UTC; the slowest passing file's at 2026-11-05 02:37 UTC",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0, Vitest 5.1.0, the local PostgreSQL 19rc1 cluster (scripts/pg/pin.env), the testing library's pool of forks under its hardened flags; the load of other sessions on the machine not recorded",
	workload:
		"535 file runs, one fork per file: 303 of the unit tier (the parallel and small-stack projects, a fork per core) and 232 of the network tier (6 at once, networkWorkers), the guided and exclusive projects among them, each test under the per-test timeout it then stated",
	result:
		"519 passed and 16 failed; the slowest passing files test/pg/world-model/inductive.test.ts in 1,740 s, privileges.test.ts in 1,349 s and isolation.test.ts in 1,306 s, the unit tier's slowest test/unit/lower/rewrite/universe.test.ts in 309 s on the small-stack project; the slowest failure test/pg/write/oracle/oracle-0.test.ts, cut at its own timeout of 1,800 s while it shrank a failure since fixed; no test's own duration, event-loop lag or machine load recorded",
	decision:
		"60 minutes is 2.07 times the slowest passing file, and a file runs its tests one after another, so no passing test took longer than its file; a search the deadline cuts still reports, so the bound can cut a failure's shrink short but never decides a verdict",
	revalidate:
		"a passing file slower than 30 minutes; a suite's search budget raised (its runs, steered cases or shrink candidates); a Node, Vitest or PostgreSQL pin change; another machine; and Vitest's record overwritten by later runs, after which the next run of both tiers is the measurement"
})

/**
 * How many candidates the flight bound's search (test/unit/adapter/flight-bound.test.ts, "the flight bound") shrinks a
 * failing case by, each a call written twice on fresh verify-full TLS sessions to the test's own server, one at a
 * time: every planted failure of the bound reached its smallest case within it, and a failure that needs more reports
 * the smallest it reached, with its replay token, minutes rather than half an hour after it failed.
 */
export const flightBoundShrinkCandidates: Limit = measured({
	value: 2_161,
	owner: "grizzle's unit tier",
	unit: "shrink candidates",
	scope: "one failing case of the flight bound's search, in one test process",
	evidence:
		"~/.cache/grizzle-release/TESTSPEED/plant-runs/ on cassowary: flight-bound-one-byte-over.txt, flight-parse-counted-every-statement.txt and flight-parse-counted-once-per-process.txt, the output of `pnpm test test/unit/adapter/flight-bound.test.ts` under each plant of ~/.cache/grizzle-release/TESTSPEED/plants with the search's shrink complete",
	observed: "2026-11-14 00:40 to 00:52 UTC",
	environment:
		"cassowary, Ubuntu 26.04 arm64 on 64 cores, Node 26.13.1 without V8's sandbox, Vitest 5.1.0, grizzle at d4949bd4 with each plant applied, the search's cases one at a time; other sessions' load not recorded",
	workload:
		"three plants of the bound, each a run of the whole file: a flight one byte past its bound written; a Parse counted at every statement under a name; a name's Parse counted once per process. Each failing floor case shrunk until no pass made progress",
	result:
		"every plant red, each shrink ended minimal: 2,161 candidates (one byte over, the search 247.6 s in all), 1,096 (every statement, 68.6 s) and 980 (once per process, 181.4 s), about 0.1 s a candidate. The stale oracle d4949bd4 fixed was reported to have shrunk 12,536 candidates over about 30 minutes, not measured here",
	decision:
		"the most candidates a planted failure needed to reach its smallest case, 2,161, so every planted failure still reports its smallest case, and a failure that needs more stops after about four minutes of shrinking (2,161 at about 0.1 s) with the smallest case it reached",
	revalidate:
		"a new plant of the bound, a change to the search's generator or property, a Node, Vitest or TLS change, and a failure of the search cut short by this budget"
})

/**
 * How long one case or shrink candidate of a search may run before it is stopped and reported as hung
 * (Exploration.caseHang): as long as its test may.
 */
const caseHangMillis: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one case or shrink candidate of a search, under a test of pnpm test or pnpm test:network or under a fuzz run of its suite",
	from: [testTimeout],
	derivation:
		"a case runs inside its test, after the test began, so it can never usefully run past the test's own timeout: under a test the search's deadline (Run.deadline) arrives first and reports the case in flight, and a fuzz run, which lifts every test timeout, stops a case that never ends at this same bound",
	compute: ([test]) => test.value
})

/** Every search's hang guard, caseHangMillis as the Duration an exploration's caseHang takes. */
export const caseHang: Duration.Duration = Duration.millis(caseHangMillis.value)

/**
 * The connect timeout of a test's connection (DbConnection.connectTimeoutMs), to the local cluster or to a server the
 * test runs itself: no deadline of the connection's own. A connect that never ends is its test's to stop, at the
 * test's deadline.
 */
export const testConnectTimeout: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one connection attempt of a test, to the local cluster or a server the test runs itself, and the CancelRequest an interrupted call of it sends",
	from: [testTimeout],
	derivation:
		"an attempt begins inside its test, so a timeout as long as the test's own never fires before the test's deadline: a slow connect on a loaded machine completes, and one that never ends is the deadline's to report",
	compute: ([test]) => test.value
})

/**
 * The idle timeout of a test's session pool (PoolBounds.idleTimeoutMs): no session closes for idleness while its test
 * runs. A test process's connections to the local cluster are its lease's (substrate/shared.ts connectionsPerLease), so
 * an idle session holds nothing another test file could take, and closing the pool's scope closes every session.
 */
export const testIdleTimeout: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope: "one idle session of a test's pool, on the local cluster or a server the test runs itself",
	from: [testTimeout],
	derivation:
		"a session opens inside its test, so an idle timeout as long as the test's own never fires before the test's deadline",
	compute: ([test]) => test.value
})

/**
 * How long a test's pg_terminate_backend waits for a terminated backend to exit: as long as its test may. A backend
 * that never exits is its test's to report, at the test's deadline.
 */
export const testExitWait: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one pg_terminate_backend a test's support code calls on the local cluster to wait for a terminated backend to exit",
	from: [testTimeout],
	derivation:
		"a termination begins inside its test, so a wait as long as the test's own never ends before the test's deadline, and the value fits the C int pg_terminate_backend reads its timeout into (REL_19_RC2 src/backend/storage/ipc/signalfuncs.c: \"int timeout; /* milliseconds */\")",
	compute: ([test]) => test.value
})

/**
 * The most sessions a test's pool holds at once (PoolBounds.max): one per core of the machine, the owner's all-cores
 * default, read from the machine itself. The local cluster runs on the same cores, so more statements at once than the
 * machine has cores only queue for them, and a call past the pool's sessions waits for one.
 */
export const testPoolMax: number = availableParallelism()

/** The source and the quote that state a Node timer's delay range. */
const nodeTimers = {
	source: "https://nodejs.org/api/timers.html#settimeoutcallback-delay-args",
	quote:
		"When `delay` is larger than `2147483647` or less than `1` or `NaN`, the `delay` will be set to `1`."
} as const

/**
 * The least delay a Node timer waits: pg's connect timeout and pg-pool's idle timeout are Node timers, and grizzle
 * admits a connectTimeoutMs or an idleTimeoutMs from it.
 */
export const nodeTimerMin: Limit = published({
	value: 1,
	owner: "Node.js timers",
	unit: "milliseconds",
	scope: "the delay of one Node timer",
	constraint: "protocol constant",
	...nodeTimers,
	verified: "2026-11-05"
})

/**
 * The longest delay a Node timer keeps: pg's connect timeout and pg-pool's idle timeout are Node timers, and grizzle
 * admits a connectTimeoutMs or an idleTimeoutMs up to it.
 */
export const nodeTimerMax: Limit = published({
	value: 2_147_483_647,
	owner: "Node.js timers",
	unit: "milliseconds",
	scope: "the delay of one Node timer",
	constraint: "protocol constant",
	...nodeTimers,
	verified: "2026-11-05"
})
