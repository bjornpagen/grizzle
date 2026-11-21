/**
 * The test tiers' limits: every time a case of a search, a hook or a test's own connection is bounded by, as a Limit
 * with its evidence. No test is bounded by the clock: a search runs exactly its
 * counted budget (its runs, required cases, exhaustive space and shrink candidates), however busy the machine is. The
 * tiers choose one number, how long one case, hook or wait may run before it is judged hung, measured on their own
 * runs; every other bound a test reads derives from it, is a published constant, or is read from the machine the tests
 * run on. One property is a time itself, how soon a killed client's backend ends under the cluster's client check
 * (orphanExitBound), and its slack is measured on its own.
 */
import { Duration } from "effect"

/**
 * How long one case of a search, one substrate's build, or one wait inside a test may run before it is
 * judged hung and reported, with the case's replay token: the hang guard (caseHang) and the bound of each wait derived
 * below. It bounds no test: every search runs its counted budget, and a case reported hung is a case that never ended.
 * No test states a timeout of its own.
 *
 * @limitKind provisional
 * @owner grizzle's test tiers
 * @unit milliseconds
 * @scope one case of a search, one substrate's build, or one wait inside a test of pnpm test or pnpm
 *   test:network, in each test process alone
 * @guards a case or wait that never ends would hold its test process until the run is killed, with no replay token
 *   reported, and a mutant that loops would never be judged
 * @measure time every case of a full network run on cassowary at the default width (toolchain-test's CPU report of the
 *   run, ~/.cache/toolchain-test/runs/last.json) and keep the slowest case's, with its headroom
 * @origin a measured record of 2026-11-05 on a macOS (Darwin 27.0.0) arm64 VM on 10 cores, Node 26.13.0, PostgreSQL
 *   19rc1: Vitest's results.json of 535 file runs, the slowest passing file test/pg/world-model/inductive.test.ts in
 *   1,740 s, 60 minutes being 2.07 times it. Its revalidation (another machine; a Node and PostgreSQL pin change) has
 *   fired and its record stayed with that machine; on cassowary at a0208243 (GREENTRUNK) twenty network files'
 *   searches ran past it under a load of 340 to 440, which is why no test is bounded by it any more
 * @recorded 2026-11-16
 */
export const hangLimit = 3_600_000

/**
 * How long one case or shrink candidate of a search may run before it is stopped and reported as hung
 * (Exploration.caseHang): the hang limit.
 *
 * @limitKind derived
 * @owner grizzle's test tiers
 * @unit milliseconds
 * @scope one case or shrink candidate of a search, under a test of pnpm test or pnpm test:network or under a fuzz run
 *   of its suite
 * @derivation a case is the unit the hang limit bounds: no test is bounded by the clock, so a case that never ends is
 *   stopped here and reported with its replay token, under a test and under a fuzz run alike
 * @from {@link hangLimit}
 */
const caseHangMillis = hangLimit

/** Every search's hang guard, caseHangMillis as the Duration an exploration's caseHang takes. */
export const caseHang: Duration.Duration = Duration.millis(caseHangMillis)

/**
 * The idle timeout of a test's session pool (PoolBounds.idleTimeoutMs): no session closes for idleness within the hang
 * limit. A test worker's connections to the local cluster draw from its own budget (substrate/connections.ts
 * connectionsPerWorker, substrate/budget.ts), so an idle session holds nothing another worker could take, and closing
 * the pool's scope closes every session.
 *
 * @limitKind derived
 * @owner grizzle's test tiers
 * @unit milliseconds
 * @scope one idle session of a test's pool, on the local cluster or a server the test runs itself
 * @derivation a session idles between the steps of a test, each of which the hang limit bounds, so a session idle for
 *   longer belongs to a step that hung
 * @from {@link hangLimit}
 */
export const testIdleTimeout = hangLimit

/**
 * How long a test's pg_terminate_backend waits for a terminated backend to exit: the hang limit. A backend that never
 * exits is a hang.
 *
 * @limitKind derived
 * @owner grizzle's test tiers
 * @unit milliseconds
 * @scope one pg_terminate_backend a test's support code calls on the local cluster to wait for a terminated backend to
 *   exit
 * @derivation a termination's wait is one wait inside a test, which the hang limit bounds, and the value fits the C
 *   int pg_terminate_backend reads its timeout into (REL_19_0 src/backend/storage/ipc/signalfuncs.c: "int timeout;
 *   /* milliseconds *\/")
 * @from {@link hangLimit}
 */
export const testExitWait = hangLimit

/**
 * The step a test's wait on another backend's state checks it at: PostgreSQL's own step when it waits on another
 * backend, pg_terminate_backend's wait for the backend's exit, so a test checks the server's state no more often than
 * the server checks its own.
 *
 * @limitKind published
 * @owner PostgreSQL
 * @unit milliseconds
 * @scope one step of a test's wait on another backend's state, on the local cluster
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/storage/ipc/signalfuncs.c
 * @quote Wait in steps of waittime milliseconds until this function exits or timeout. [...] int64 waittime = 100;
 * @verified 2026-11-20
 */
export const backendWaitStep = 100

/**
 * How long past the cluster's client check interval (its client_connection_check_interval) a test gives the
 * backend of a client it killed mid-statement to be seen gone from pg_stat_activity: the backend's exit once its poll
 * finds the socket closed, and the test's own step to see it (backendWaitStep). A backend that polls no client never
 * leaves, so no slack passes it.
 *
 * @limitKind measured
 * @owner grizzle's network tier (test/pg/substrate/orphan.test.ts)
 * @unit milliseconds
 * @scope one backend of a client a test killed mid-statement, from the kill plus the client check interval until the
 *   test sees it gone from pg_stat_activity
 * @evidence ~/.cache/grizzle-release/ORPHAN/run/lag.sh <socket directory> 10 against a throwaway postmaster at
 *   client_connection_check_interval = 1000: for each of three statements holding a transaction id (a recursive CTE
 *   that never ends, pg_sleep('infinity'), a wait on an advisory lock another session holds), a psql client SIGKILLed
 *   once pg_stat_activity shows the statement running, and the milliseconds from the kill until pg_stat_activity, read
 *   by psql back to back, lists its backend no more; its output kept at ~/.cache/grizzle-release/ORPHAN/out/lag.txt on
 *   cassowary
 * @observed 2026-11-15 14:19:40 to 14:20:11 UTC, one run
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 23 to 30 from other sessions; a
 *   throwaway postmaster of the pinned PostgreSQL 19rc2 build (scripts/pg/pin.env) at initdb's defaults, no other
 *   session on it; grizzle 17b28413
 * @workload thirty kills, ten of each statement, one at a time
 * @result 999 to 1,017 ms from kill to gone, at most 17 ms past the interval: the recursive CTE 1,011 to 1,017,
 *   pg_sleep 999 to 1,005, the lock wait 1,000 to 1,005; every backend logged FATAL connection to client lost. No run
 *   on a loaded machine
 * @decision 1,000 ms, about 58 times the most observed past the interval, which takes in the test's own step of 100 ms
 *   (backendWaitStep) and the exit's lag on a machine far busier than the measured one, unmeasured: the network tier's
 *   full runs load cassowary to 340 to 440 (hangLimit). A backend that polls no client never leaves, so a red case
 *   waits this once and no slack could pass it
 * @revalidate a case red on a loaded machine whose backend did leave; a change to the client check interval; a
 *   PostgreSQL repin; another machine
 */
const orphanExitSlack = 1000

/**
 * How long a test waits, from killing a client mid-statement, for its backend to be seen gone from pg_stat_activity:
 * `interval`, the client check interval its server runs (client_connection_check_interval, in milliseconds, as the
 * server reports it: the testing library's every member holds one), then the slack for the exit and the test's step
 * (orphanExitSlack).
 *
 * @limitKind derived
 * @owner grizzle's network tier (test/pg/substrate/orphan.test.ts)
 * @unit milliseconds
 * @scope one backend of a client a test killed mid-statement, from the kill until the test sees it gone from
 *   pg_stat_activity
 * @derivation a backend polls its client once each interval while its statement runs (the timer start_xact_command
 *   arms and each poll re-arms, REL_19_0 src/backend/tcop/postgres.c#L2818 and #L3453), so its first poll after the
 *   kill comes at most one interval later; the slack takes in its exit and the test's step to see it
 * @from the server's client_connection_check_interval, {@link orphanExitSlack}
 */
export const orphanExitBound = (interval: number): number => interval + orphanExitSlack
