import { processors } from "@bjornpagen/testing/workers"

/**
 * How many cases one window of a type agreement holds (agreement.ts): the cases its search draws under one snapshot of
 * what is pending and runs at once, a constant of the agreement and never of the machine, so one seed draws the same
 * cases at any width. A program pays a fixed load, the sources' type graph its prelude reaches, then a little per case,
 * so a window is checked in as many programs as typeBatches below, each on a worker of its own, and a search's streams
 * are each one window: the floor's cases one, the rotating stream's one, the steered phase's one or two.
 *
 * @limitKind measured
 * @owner the type tier's agreements (test/types/batch/agreement.ts)
 * @unit cases per window
 * @scope one window of a type agreement's search, checked in typeBatches programs, each written as one program and
 *   checked by one tsgo run with its default checkers; the runner's search runs a window of max(steering window,
 *   window) cases at a time (runner/search.ts exploreSearch), an exhaustion's box this many cases to typeBatches
 *   batches
 * @evidence ~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/evidence.txt: GNU time over tsgo (node_modules/typescript/
 *   bin/tsc --pretty false -p) on the access agreement's program of 1, 38 and 150 drawn logins (measure/batches), and on
 *   every program of the old type batch (measure/progs) with one checker and with tsgo's default
 * @observed 2026-11-16, 02:12 to 02:31 UTC
 * @environment cassowary, Ubuntu 26.04 arm64, 64 cores, 247 GB, Node 26.13, TypeScript 7.1.0-beta (tsgo, patched by
 *   effect-tsgo), grizzle 4ca3036a with toolchain 487b28e; load average 47 to 355 from other sessions
 * @workload the access agreement's program (test/support/agreement/access.ts accessProgram) over 1, 38 and 150 logins
 *   sampled at one seed; the 29 programs of the old batch at their whole populations (120 to 400 cases)
 * @result access: 1 login 8.2 s of CPU and 0.90 GB RSS, 38 logins 17.8 s and 2.1 GB, 150 logins 56.1 s and 5.2 GB: a
 *   fixed load of about 7.5 s of CPU and 0.32 s a login. The smallest program of the old batch (api/surface, 16 lines)
 *   took 5.6 s of CPU and 0.68 GB with default checkers; the largest whole populations took 30 to 56 s of CPU and at
 *   most 4.2 GB. Default checkers took the same CPU as one checker and finished 1.5 to 3 times sooner
 * @decision 150, the runner's rotating stream (its default runs), so each stream of a search is one window: the
 *   floor's cases one, the rotating stream's one. A window of fewer cases runs the steered phase's windows one after
 *   another for nothing; above it no stream changes. A program of a whole window stays under 6 GB
 * @revalidate the runner's default runs or steering window changes; a TypeScript 7 or tsgo upgrade; a program whose
 *   per-case cost passes its fixed load (a case costing more than 7 s of CPU)
 */
export const typeWindow = 150

/**
 * The CPU one type-test program spends before its first case: tsgo's check of the sources its prelude reaches.
 *
 * @limitKind measured
 * @owner the type tier's agreements (test/types/batch/agreement.ts)
 * @unit seconds of CPU
 * @scope one program of a type agreement's batch, checked by one tsgo run
 * @evidence typeWindow's record (measure/evidence.txt), the access agreement's programs of 1, 38 and 150 logins
 * @observed 2026-11-16, 02:12 to 02:31 UTC
 * @environment typeWindow's
 * @workload typeWindow's
 * @result 8.2, 17.8 and 56.1 s of CPU for 1, 38 and 150 logins: their line's intercept, about 7.5 s
 * @decision the intercept, rounded to the half second
 * @revalidate typeWindow's
 */
const programCpu = 7.5

/**
 * The CPU one case adds to its program's check.
 *
 * @limitKind measured
 * @owner the type tier's agreements (test/types/batch/agreement.ts)
 * @unit seconds of CPU
 * @scope one case of a type agreement's batch, in a program of the batch's cases
 * @evidence typeWindow's record (measure/evidence.txt), the access agreement's programs of 1, 38 and 150 logins
 * @observed 2026-11-16, 02:12 to 02:31 UTC
 * @environment typeWindow's
 * @workload typeWindow's
 * @result 8.2, 17.8 and 56.1 s of CPU for 1, 38 and 150 logins: their line's slope, about 0.32 s a login
 * @decision the slope; the evidence agreement's own cases cost less in tsgo and more in the engine (its compile of
 *   each query), which the program's worker spends beside it
 * @revalidate typeWindow's
 */
const caseCpu = 0.32

/**
 * How many programs a window of typeWindow cases is checked in at once, each of at most ⌈typeWindow / typeBatches⌉
 * cases, each on a worker of its own: as many as the machine runs at once, and no more than leave each program's
 * checking of its own cases at least its fixed load, so a window's CPU at most doubles while its wall time is divided by
 * its programs. A program's cases are where they run, never what they are: each case's verdict is its own lines', so a
 * window found in six programs finds what one program finds.
 *
 * @limitKind derived
 * @owner the type tier's agreements (test/types/batch/agreement.ts)
 * @unit programs per window
 * @scope one window of a type agreement's search, its kept cases' window among them (runner/search.ts keptFinding)
 * @derivation ⌊typeWindow × caseCpu / programCpu⌋ = ⌊150 × 0.32 / 7.5⌋ = 6 programs of 25 cases each check 8 s of cases
 *   beside their 7.5 s of fixed load, where one program of 150 checks 48 s of them, so the window's 7.5 + 48 = 55.5 s
 *   of CPU in one program's wall time becomes 6 × 7.5 + 48 = 93 s in one twenty-five-case program's 15.5 s; one more
 *   program would check less of its own than its fixed load costs. The run's CPU allowance caps it
 *   (@bjornpagen/testing/workers processors) where it holds fewer CPUs, and at least one program checks every window
 * @from {@link typeWindow}, {@link caseCpu}, {@link programCpu}
 */
export const typeBatches = Math.max(
	1,
	Math.min(processors, Math.floor((typeWindow * caseCpu) / programCpu))
)
