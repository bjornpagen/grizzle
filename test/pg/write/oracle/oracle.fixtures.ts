import { type Limit, measured } from "@bjornpagen/limit"

/**
 * How long one case of the write oracle may run: a whole write run, its schema installed in the case's own database,
 * its installation's privileges checked, and up to twelve write cases applied in order on one Db, each compared three
 * ways, so a case does what a whole test did under Vitest, and the runner's own case deadline (60 s) cuts runs that are
 * merely slow on a loaded machine.
 */
export const writeRunDeadline: Limit = measured({
	value: 360_000,
	owner: "test/pg/write/oracle/oracle.test.ts",
	unit: "milliseconds",
	scope: "one case of the write oracle on the runner: one write run, at a run's full width",
	evidence:
		"each case's wall time from its check's start to its scope's close, written by a probe finalizer to ~/.cache/grizzle-release/TESTSYS/GZ-FOUNDATION/measure/write-cases-20261116.jsonl, with the run's report in write-run-20261116.log beside it (the probe and its 600 s deadline not committed)",
	observed: "2026-11-16 10:48 to 11:01 UTC, one run",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 300 to 720 from other lanes; a private family of 4 members of the pinned PostgreSQL 19rc2, fsync off; grizzle at d55043f1 with vendor/toolchain at acbe88c; Node 26.13.1; the runner at 64 workers",
	workload:
		"toolchain-test run test/pg/write/oracle/oracle.test.ts: 150 sampled cases and the witness cases of its five kills, 257 cases in all, each a generated write run in its own clone of the base template",
	result:
		"every case passed and every kill was killed; case wall time p50 35.9 s, p90 82.4 s, p99 167.8 s, the slowest 179.9 s; the run took 813 s. At the runner's 60 s an earlier run at load 290 to 550 cut case 116 as hung, which replayed alone in 37.6 s with the process's start",
	decision:
		"360 s, twice the slowest case observed, which a run under the same load meets with room for a slower draw; a case past it hangs rather than runs slowly",
	revalidate:
		"a write run of more cases or larger schemas (index.ts maxCasesPerRun, schema.ts), a machine of other cores or load, a PostgreSQL repin, or the runner's case deadline measured again"
})
