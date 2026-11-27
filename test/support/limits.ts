/**
 * The test tiers' limits: every time a case of a search, a hook or a test's own connection is bounded by, as a Limit
 * with its evidence. No test is bounded by the clock: a search runs exactly its
 * counted budget (its runs, required cases, exhaustive space and shrink candidates), however busy the machine is. The
 * tiers choose one number, how long one case, hook or wait may run before it is judged hung, measured on their own
 * runs; every other bound a test reads derives from it, is a published constant, or is read from the machine the tests
 * run on.
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
 * @origin a measured record of 2026-11-05 on a macOS (Darwin 27.0.0) arm64 VM on 10 cores, Node 26.13.0: Vitest's
 *   results.json of 535 file runs, the slowest passing file test/pg/world-model/inductive.test.ts in
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
