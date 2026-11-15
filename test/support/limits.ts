/**
 * The test tiers' limits: every time a case of a search, a hook or a test's own connection is bounded by, as a Limit
 * with its evidence (packages/engine/src/core/limits.ts). No test is bounded by the clock: a search runs exactly its
 * counted budget (its runs, required cases, exhaustive space and shrink candidates), however busy the machine is. The
 * tiers choose one number, how long one case, hook or wait may run before it is judged hung, measured on their own
 * runs; every other bound a test reads derives from it, is a published constant, or is read from the machine the tests
 * run on. One property is a time itself, how soon a killed client's backend ends under the cluster's client check
 * (orphanExitBound), and its slack is measured on its own.
 */
import { Duration } from "effect"
import { derived, type Limit, measured, published } from "#compiler/core/limits.ts"
import { testPoolMax } from "#pg/lease.ts"
import { clientCheckInterval } from "#pg/settings.ts"

/**
 * How long one case of a search, one hook of `pnpm test`, one substrate's build past its lease, or one wait inside a
 * test may run before it is judged hung and reported, with the case's replay token or the hook's name: the hang guard
 * (caseHang), the unit tier's hookTimeout (vitest.config.ts) and the bound of each wait derived below. It bounds no
 * test: both tiers' tests are unbounded, so every search runs its counted budget, and a case reported hung is a case
 * that never ended. No test states a timeout of its own.
 */
export const hangLimit: Limit = measured({
	value: 3_600_000,
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one case of a search, one hook of pnpm test, one substrate's build past its lease, or one wait inside a test of pnpm test or pnpm test:network, in each test process alone",
	evidence:
		"node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json, Vitest's own record of each test file's last run (its duration, whether it failed, when it ran), SHA-256 4e9f397495c81884f158742f129f85e8c05f17b6ab00c1a3c384ddb37f7d0a6b when read on 2026-11-05",
	observed:
		"each file's last run between 2026-10-28 01:04 and 2026-11-05 04:30 UTC; the slowest passing file's at 2026-11-05 02:37 UTC",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0, Vitest 5.1.0, the local PostgreSQL 19rc1 cluster (scripts/pg/pin.env), the testing library's pool of forks under its hardened flags; the load of other sessions on the machine not recorded",
	workload:
		"535 file runs, one fork per file: 303 of the unit tier (the parallel and small-stack projects, a fork per core) and 232 of the network tier (6 at once, the network tier's width then), the guided and exclusive projects among them, each test under the per-test timeout it then stated",
	result:
		"519 passed and 16 failed; the slowest passing files test/pg/world-model/inductive.test.ts in 1,740 s, privileges.test.ts in 1,349 s and isolation.test.ts in 1,306 s, the unit tier's slowest test/unit/lower/rewrite/universe.test.ts in 309 s on the small-stack project; the slowest failure test/pg/write/oracle/oracle-0.test.ts, cut at its own timeout of 1,800 s while it shrank a failure since fixed; no test's own duration, event-loop lag or machine load recorded",
	decision:
		"60 minutes is 2.07 times the slowest passing file, and a case, a hook or a wait runs inside its file, so none that passed took longer. Until 2026-11-15 it bounded each test too; on cassowary (Ubuntu 26.04 arm64, 64 cores, load 340 to 440 from other sessions) the network tier's 64 files at once ran 20 files' searches past it at a0208243 (GREENTRUNK, TEST_SEED=572712174, each DeadlineReached mid-budget: fin/edits at case 4,242 of 14,650, e2e-platform/box at 630 of 1,024), so no test is bounded by it any more, and a busy machine slows a search but never fails it",
	revalidate:
		"a case, hook or wait reported hung that was progressing; a passing file slower than 30 minutes on the machine of its measurement; a Node, Vitest or PostgreSQL pin change; another machine; and Vitest's record overwritten by later runs, after which the next run of both tiers is the measurement"
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
		"~/.cache/grizzle-release/TESTSPEED/plant-runs/ on cassowary: flight-bound-one-byte-over.txt, flight-parse-counted-every-statement.txt and flight-parse-counted-once-per-process.txt, the output of `pnpm test test/unit/adapter/flight-bound.test.ts` under each of its plants test/plants/unit/adapter/flight-bound-one-byte-over.patch, flight-parse-counted-every-statement.patch and flight-parse-counted-once-per-process.patch, with the search's shrink complete",
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
 * (Exploration.caseHang): the hang limit.
 */
const caseHangMillis: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one case or shrink candidate of a search, under a test of pnpm test or pnpm test:network or under a fuzz run of its suite",
	from: [hangLimit],
	derivation:
		"a case is the unit the hang limit bounds: no test is bounded by the clock, so a case that never ends is stopped here and reported with its replay token, under a test and under a fuzz run alike",
	compute: ([hang]) => hang.value
})

/** Every search's hang guard, caseHangMillis as the Duration an exploration's caseHang takes. */
export const caseHang: Duration.Duration = Duration.millis(caseHangMillis.value)

/**
 * The connect timeout of a test's connection (DbConnection.connectTimeoutMs), to the local cluster or to a server the
 * test runs itself: the hang limit. A connect that never ends is a hang.
 */
export const testConnectTimeout: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one connection attempt of a test, to the local cluster or a server the test runs itself, and the CancelRequest an interrupted call of it sends",
	from: [hangLimit],
	derivation:
		"an attempt is one wait inside a test, which the hang limit bounds: a slow connect on a loaded machine completes, and one that never ends is reported as hung",
	compute: ([hang]) => hang.value
})

/**
 * The idle timeout of a test's session pool (PoolBounds.idleTimeoutMs): no session closes for idleness within the hang
 * limit. A test process's connections to the local cluster draw from the budget its lease grants (substrate/shared.ts
 * leaseGrant, substrate/budget.ts), so an idle session holds nothing another test file could take, and closing the
 * pool's scope closes every session.
 */
export const testIdleTimeout: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope: "one idle session of a test's pool, on the local cluster or a server the test runs itself",
	from: [hangLimit],
	derivation:
		"a session idles between the steps of a test, each of which the hang limit bounds, so a session idle for longer belongs to a step that hung",
	compute: ([hang]) => hang.value
})

/**
 * How long a test's pg_terminate_backend waits for a terminated backend to exit: the hang limit. A backend that never
 * exits is a hang.
 */
export const testExitWait: Limit = derived({
	owner: "grizzle's test tiers",
	unit: "milliseconds",
	scope:
		"one pg_terminate_backend a test's support code calls on the local cluster to wait for a terminated backend to exit",
	from: [hangLimit],
	derivation:
		'a termination\'s wait is one wait inside a test, which the hang limit bounds, and the value fits the C int pg_terminate_backend reads its timeout into (REL_19_RC2 src/backend/storage/ipc/signalfuncs.c: "int timeout; /* milliseconds */")',
	compute: ([hang]) => hang.value
})

/**
 * The step a test's wait on another backend's state checks it at: PostgreSQL's own step when it waits on another
 * backend, pg_terminate_backend's wait for the backend's exit, so a test checks the server's state no more often than
 * the server checks its own.
 */
export const backendWaitStep: Limit = published({
	value: 100,
	owner: "PostgreSQL",
	unit: "milliseconds",
	scope: "one step of a test's wait on another backend's state, on the local cluster",
	constraint: "compile-time constant",
	source:
		"https://github.com/postgres/postgres/blob/REL_19_RC2/src/backend/storage/ipc/signalfuncs.c",
	quote:
		"Wait in steps of waittime milliseconds until this function exits or timeout. [...] int64 waittime = 100;",
	verified: "2026-11-15"
})

/**
 * How long past the cluster's client check interval (packages/pg/src/settings.ts clientCheckInterval) a test gives the
 * backend of a client it killed mid-statement to be seen gone from pg_stat_activity: the backend's exit once its poll
 * finds the socket closed, and the test's own step to see it (backendWaitStep). A backend that polls no client never
 * leaves, so no slack passes it.
 */
const orphanExitSlack: Limit = measured({
	value: 1000,
	owner: "grizzle's network tier (test/pg/substrate/orphan.test.ts)",
	unit: "milliseconds",
	scope:
		"one backend of a client a test killed mid-statement, from the kill plus the client check interval until the test sees it gone from pg_stat_activity",
	evidence:
		"~/.cache/grizzle-release/ORPHAN/run/lag.sh <socket directory> 10 against a throwaway postmaster at client_connection_check_interval = 1000: for each of three statements holding a transaction id (a recursive CTE that never ends, pg_sleep('infinity'), a wait on an advisory lock another session holds), a psql client SIGKILLed once pg_stat_activity shows the statement running, and the milliseconds from the kill until pg_stat_activity, read by psql back to back, lists its backend no more; its output kept at ~/.cache/grizzle-release/ORPHAN/out/lag.txt on cassowary",
	observed: "2026-11-15 14:19:40 to 14:20:11 UTC, one run",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 23 to 30 from other sessions; a throwaway postmaster of the pinned PostgreSQL 19rc2 build (scripts/pg/pin.env) at initdb's defaults, no other session on it; grizzle 17b28413",
	workload: "thirty kills, ten of each statement, one at a time",
	result:
		"999 to 1,017 ms from kill to gone, at most 17 ms past the interval: the recursive CTE 1,011 to 1,017, pg_sleep 999 to 1,005, the lock wait 1,000 to 1,005; every backend logged FATAL connection to client lost. No run on a loaded machine",
	decision:
		"1,000 ms, about 58 times the most observed past the interval, which takes in the test's own step of 100 ms (backendWaitStep) and the exit's lag on a machine far busier than the measured one, unmeasured: the network tier's full runs load cassowary to 340 to 440 (hangLimit). A backend that polls no client never leaves, so a red case waits this once and no slack could pass it",
	revalidate:
		"a case red on a loaded machine whose backend did leave; a change to the client check interval; a PostgreSQL repin; another machine"
})

/**
 * How long a test waits, from killing a client mid-statement, for its backend to be seen gone from pg_stat_activity:
 * the cluster's client check interval, then the slack for the exit and the test's step (orphanExitSlack).
 */
export const orphanExitBound: Limit = derived({
	owner: "grizzle's network tier (test/pg/substrate/orphan.test.ts)",
	unit: "milliseconds",
	scope:
		"one backend of a client a test killed mid-statement, from the kill until the test sees it gone from pg_stat_activity",
	from: [clientCheckInterval, orphanExitSlack],
	derivation:
		"a backend polls its client once each interval while its statement runs (the timer start_xact_command arms and each poll re-arms, REL_19_RC2 src/backend/tcop/postgres.c#L2818 and #L3453), so its first poll after the kill comes at most one interval later; the slack takes in its exit and the test's step to see it",
	compute: ([interval, slack]) => interval.value + slack.value
})

/**
 * How many cases of a search run at once, each on state of its own that holds `sessions` sessions of the test's pool:
 * as many as fit in the pool (testPoolMax, one session per core), and one at least, the one a search of a single set
 * of sessions runs.
 */
export const casesAtOnce = (sessions: number): number =>
	Math.max(1, Math.floor(testPoolMax / sessions))

/**
 * How many cases of an exploration run at once, each on state of its own that holds `sessions` sessions: casesAtOnce,
 * and no more than its window of `steerEvery` cases, the most an exploration runs at once (explore.ts windowOf).
 */
export const windowCasesAtOnce = (sessions: number, steerEvery: number): number =>
	Math.min(steerEvery, casesAtOnce(sessions))

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
