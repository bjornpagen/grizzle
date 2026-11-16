/**
 * How many cases one type-test program holds: an agreement's batch (agreement.ts), checked by one tsgo run. A run pays a
 * fixed load, the sources' type graph its prelude reaches, then a little per case, and a search runs its windows one
 * after another, a window of up to this many cases in one program, so the fewest programs a search can run is the
 * cheapest in compute and in time: each of its streams in one program.
 *
 * @limitKind measured
 * @owner the type tier's agreements (test/types/batch/agreement.ts)
 * @unit cases per program
 * @scope one batch of a type agreement's cases, written as one program and checked by one tsgo run with its default
 *   checkers; the runner's search runs a window of max(steering window, size) cases at a time (runner/search.ts
 *   exploreSearch), an exhaustion's box this many cases to a batch
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
 * @decision 150, the runner's rotating stream (its default runs), so each stream of a search is one program: the
 *   floor's cases one, the rotating stream's one. Below it every window pays another fixed load (7.5 s of CPU, more
 *   than 20 logins' checking) and the windows run one after another, so a search is slower and costs more; above it no
 *   stream changes. A program of 150 cases stays under 6 GB
 * @revalidate the runner's default runs or steering window changes; a TypeScript 7 or tsgo upgrade; a program whose
 *   per-case cost passes its fixed load (a case costing more than 7 s of CPU)
 */
export const typeBatchSize = 150
