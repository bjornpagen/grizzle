import {
	boundOver,
	type Overrun,
	overrun,
	overrunText,
	processWorkNow
} from "@bjornpagen/testing/live"
import { Array as Arr, Data, Duration, Effect, Fiber, Option, Stream } from "effect"
import { ChildProcess } from "effect/process"

/**
 * The repository's compiler, the patched TypeScript 7 tsgo, run to completion as a child process under a stall guard. A
 * check that keeps making progress runs for as long as it takes; one whose process tree is idle over a window has
 * stalled, a hang no output will end, so the guard asks it for its goroutines (SIGQUIT, on which Go's runtime prints
 * every goroutine's stack and exits) and fails with CompilerStalled, carrying that dump, instead of waiting on it for as
 * long as a test may run.
 *
 * A tree is idle when its work stands still as the testing library judges any work (@bjornpagen/testing/live
 * processWorkNow and overrun): its CPU not moving over a window of the time it could have run, the time it waited for a
 * CPU taken out and its storage work counted as progress, so a busy machine slows a check but never makes it a stall.
 */

/** What a compiler run reported: its exit status and everything it printed. */
export interface Ran {
	readonly status: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * How long a check's process tree may stand still before it has stalled: its CPU, the time it could have run, not
 * moving over the whole window (the testing library's judge, @bjornpagen/testing/live overrun).
 *
 * @limitKind measured
 * @owner the type tier's compiler runs (test/types/batch)
 * @unit milliseconds
 * @scope one tsgo check the type-test batch or a scaling test runs, from its spawn to its exit, measured on its whole
 *   process tree
 * @evidence ~/.cache/grizzle-release/GREENTRUNK/out/stall/ on cassowary: evidence-1.txt, the output of
 *   ~/.cache/grizzle-release/GREENTRUNK/tools/stall-evidence.sh, whose stall-measure.mjs runs a check and reads its
 *   process tree from /proc every 10 ms as the guard reads it (each process's utime, stime, cutime and cstime in clock
 *   ticks, each thread's state, each thread's children) and records the longest stretch between two readings that
 *   found progress; and watch-1.txt, the output of tools/stall-watch.mjs, tsgo's watch mode read the same way every
 *   250 ms for 20 s. test/types/batch/batch.test.ts, the stall guard's property, re-verifies the window's sense:
 *   tsgo's watch mode, idle after its first check, fails with CompilerStalled, and neither a check run once nor a busy
 *   child under a waiting parent does
 * @observed 2026-11-14, 23:36:59 to 23:39:05 UTC
 * @environment cassowary, Ubuntu 26.04 arm64 on 64 cores, Linux 7.0.0-1016-aws (clock ticks of 10 ms, getconf CLK_TCK
 *   100), Node 26.13.1, TypeScript 7.1.0-beta+effect-tsgo.0.67.1 (tsgo) as pnpm install patches it, grizzle at
 *   18297bc7; load average 339 to 395 from other sessions throughout
 * @workload the stall guard property's own program, one clean declaration, checked once (three runs, 0.5 to 0.7 s
 *   wall); packages/engine's tsconfig with noEmit (two runs, 1.1 and 1.4 s); the repository's whole tsconfig with
 *   noEmit (one run, 81.0 s wall, 101.3 s of CPU); and tsgo's watch mode over the guard property's program for 20 s
 * @result the longest stretch without progress as the guard judges it (a thread running, waiting for a CPU or on the
 *   disk, or CPU time spent) was 114 ms over the whole repository's check, 3,945 of its 4,019 readings finding a
 *   thread busy; 65 ms over packages/engine's; 29 ms over the one-declaration check. Counting CPU time alone it was
 *   573 ms, 238 ms and 71 ms. The reader fell at most 104 ms behind its interval. The watch mode was last busy 1,005
 *   ms in and made no progress at any reading of the 18.7 s after. Linux's ps prints CPU time in whole seconds
 *   (procps-ng 4.0.4, time= as 02:07:58), so the ps reading this replaces saw no progress from a check that spent less
 *   than a second of CPU, and judged the one-declaration check stalled under a 1 s window whenever load stretched it
 *   past the window (TEST_SEED=3440897367 and 1167524907)
 * @decision 30 s is 263 times the longest stretch without progress seen: a check the machine is too busy to run waits
 *   for a CPU, which is progress, so load adds no stretch the window must cover, and a check that progresses is never
 *   judged by it; a stalled one fails in 30 s instead of a test's hour
 * @revalidate a TypeScript 7 or Go upgrade; a check that starts waiting on something outside its process (a language
 *   service plugin's server, a network fetch); another kernel or machine; a CompilerStalled whose goroutine dump shows
 *   the checkers running
 */
const stallWindow = 30_000

/** A stall guard: how long a process tree's work may stand still. The type tier passes stallWindow; a test its own. */
type StallGuard = Readonly<{ window: Duration.Duration }>

/** The guard the type tier's compiler runs under. */
const compilerStallGuard: StallGuard = { window: Duration.millis(stallWindow) }

/**
 * A checked command's process tree stood still for a whole window of its guard, as the testing library's judge read it
 * (`overrun`, the leg and what it measured): `command` and `args` are what ran, and `goroutines` what it printed on
 * stderr once asked for its goroutines, the dump an upstream report needs.
 */
class CompilerStalled extends Data.TaggedError("CompilerStalled")<{
	readonly command: string
	readonly args: ReadonlyArray<string>
	readonly overrun: Overrun
	readonly goroutines: string
}> {
	override get message(): string {
		return `${this.command} ${Arr.join(this.args, " ")} stalled: ${overrunText(this.overrun)}: a stall, which no output ends. What it printed when asked for its goroutines (SIGQUIT):\n${this.goroutines}`
	}
}

/** Everything a command printed on one of its streams. */
const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

/**
 * Ends once `pid`'s tree has stood still for a whole `guard.window`, as the testing library judges any work (live.ts
 * processWorkNow and overrun): its CPU not moving over a window of the time it could have run, its waits to run taken
 * out and its storage work counted as progress, so a busy machine slows a check but never makes it a stall. No CPU
 * budget: a check that progresses runs for as long as it takes. The one judge of the toolchain, where this module read
 * the tree's /proc files on the live clock with a judge of its own.
 */
const stalled = (pid: number, guard: StallGuard): Effect.Effect<Overrun> =>
	Effect.flatMap(
		processWorkNow(Option.some(pid), () => 0),
		(work) => overrun(work, boundOver(Number.POSITIVE_INFINITY, Duration.toMillis(guard.window)))
	)

/**
 * Runs `command` with `args` in `cwd` to completion under `guard`: its exit status and what it printed, or
 * CompilerStalled once its process tree has been idle for the guard's window. A stalled command is sent
 * SIGQUIT, and SIGKILL a window later if it has not exited by then, and what it printed on stderr to its end is the
 * failure's dump. The child belongs to the run's scope, so an interrupted run kills it. PWD is `cwd` too, since tsgo
 * reads its working directory from PWD where PWD names it.
 */
const guardedRun = (command: string, args: ReadonlyArray<string>, cwd: string, guard: StallGuard) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(command, args, {
				cwd,
				env: { PWD: cwd },
				extendEnv: true,
				stdin: "ignore"
			})
			const stdout = yield* Effect.forkScoped(text(handle.stdout))
			const stderr = yield* Effect.forkScoped(text(handle.stderr))
			const ended = yield* Effect.raceFirst(
				Effect.map(handle.exitCode, (status) => ({ kind: "exited", status }) as const),
				Effect.map(stalled(handle.pid, guard), (stall) => ({ kind: "stalled", stall }) as const)
			)
			switch (ended.kind) {
				case "exited": {
					const ran: Ran = {
						status: ended.status,
						stdout: yield* Fiber.join(stdout),
						stderr: yield* Fiber.join(stderr)
					}
					return ran
				}
				case "stalled": {
					yield* handle.kill({ killSignal: "SIGQUIT", forceKillAfter: guard.window })
					return yield* new CompilerStalled({
						command,
						args,
						overrun: ended.stall,
						goroutines: yield* Fiber.join(stderr)
					})
				}
			}
		})
	)

/** The repository's compiler at `root`, run in `cwd` with `args` under the type tier's stall guard. */
export const compiled = (root: string, cwd: string, args: ReadonlyArray<string>) =>
	guardedRun(
		process.execPath,
		[`${root}/node_modules/typescript/bin/tsc`, ...args],
		cwd,
		compilerStallGuard
	)
