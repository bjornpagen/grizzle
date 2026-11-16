import { liveMillis, liveSleep } from "@bjornpagen/testing/live"
import { regex } from "arkregex"
import {
	Array as Arr,
	Data,
	Duration,
	Effect,
	Fiber,
	FileSystem,
	Option,
	type PlatformError,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"

/**
 * The repository's compiler, the patched TypeScript 7 tsgo, run to completion as a child process under a stall guard. A
 * check that keeps making progress runs for as long as it takes; one whose process tree is idle over a window has
 * stalled, a hang no output will end, so the guard asks it for its goroutines (SIGQUIT, on which Go's runtime prints
 * every goroutine's stack and exits) and fails with CompilerStalled, carrying that dump, instead of waiting on it for as
 * long as a test may run.
 *
 * A tree is idle when none of its threads is running, waiting for a CPU or waiting on the disk, and it spends no CPU
 * time, as the kernel counts both (/proc, proc(5)): a check the machine is too busy to run is waiting for a CPU, so a
 * busy machine slows a check but never makes it a stall, and a check spends its time in the kernel's own unit, the
 * clock tick, which no reading rounds away.
 */

/** What a compiler run reported: its exit status and everything it printed. */
export interface Ran {
	readonly status: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * How long a check's process tree may be idle before it has stalled: no reading of it across the whole window finds a
 * thread running, waiting for a CPU or waiting on the disk, or more CPU time than the last reading that did.
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

/**
 * How often the guard reads the process tree: thirty times per window, so a stall is caught within a thirtieth of it.
 *
 * @limitKind derived
 * @owner the type tier's compiler runs (test/types/batch)
 * @unit milliseconds
 * @scope the interval between two readings of a check's process tree
 * @derivation a stall is declared at the first reading a whole window after the last progress, so a thirtieth of the
 *   window delays it by at most a thirtieth; one reading of the tree's /proc files is cheap beside a check
 * @from {@link stallWindow}
 */
const stallSampleEvery = Math.ceil(stallWindow / 30)

/**
 * A stall guard: how long a process tree may be idle, and how often it is read. The type tier passes stallWindow and
 * stallSampleEvery; a test of the guard passes its own.
 */
export type StallGuard = Readonly<{ window: Duration.Duration; every: Duration.Duration }>

/** The guard the type tier's compiler runs under. */
const compilerStallGuard: StallGuard = {
	window: Duration.millis(stallWindow),
	every: Duration.millis(stallSampleEvery)
}

/** A /proc stat file held a line outside proc(5)'s format: the guard cannot read the tree, so it fails rather than guess. */
class CpuTimeUnreadable extends Data.TaggedError("CpuTimeUnreadable")<{
	readonly file: string
	readonly line: string
}> {
	override get message(): string {
		return `the stall guard cannot read ${this.file}: "${this.line}"`
	}
}

/**
 * A checked command's process tree was idle for `idleMillis`, at least its guard's window: `command` and `args` are what
 * ran, `cpuTicks` the CPU time its tree had spent by its last progress, in clock ticks, none when its process was never
 * read, and `goroutines` what it printed on stderr once asked for its goroutines, the dump an upstream report needs.
 */
class CompilerStalled extends Data.TaggedError("CompilerStalled")<{
	readonly command: string
	readonly args: ReadonlyArray<string>
	readonly idleMillis: number
	readonly cpuTicks: Option.Option<number>
	readonly goroutines: string
}> {
	override get message(): string {
		const spent = Option.match(this.cpuTicks, {
			onNone: () => "with no reading of its process",
			onSome: (ticks) => `after ${ticks} clock ticks of CPU`
		})
		return `${this.command} ${Arr.join(this.args, " ")} was idle for ${this.idleMillis} ms, no thread running, waiting for a CPU or on the disk and no CPU time spent, ${spent}: a stall, which no output ends. What it printed when asked for its goroutines (SIGQUIT):\n${this.goroutines}`
	}
}

/**
 * A process's or a thread's stat line past its command's name, which ends at the line's last ")" (proc(5),
 * /proc/pid/stat): its state, ten fields, then its user and system time and its waited-for children's, in clock ticks.
 */
const statFields = regex(
	"^\\) (?<state>\\S) (?:-?\\d+ ){10}(?<utime>\\d+) (?<stime>\\d+) (?<cutime>-?\\d+) (?<cstime>-?\\d+) "
)

/**
 * One reading of a process, a thread or a process tree: whether it is running, waiting for a CPU or on the disk (a
 * tree when any of its threads is), and the CPU time it has spent, in clock ticks: its own and its waited-for
 * children's, so a child's time stays counted after it exits.
 */
export type Reading = Readonly<{ busy: boolean; ticks: number }>

/**
 * The states in which a thread is making progress or waits only on the machine: running or runnable (R) and in an
 * uninterruptible wait, as on the disk (D). Every other state waits on an event (S), is stopped or traced (t, T), or
 * has ended (Z, X).
 */
const BUSY_STATES: ReadonlySet<string> = new Set(["R", "D"])

/**
 * The errors a /proc read fails with once the process or thread it describes has ended: ENOENT once it is reaped and its
 * entry is gone, and ESRCH while its entry stands but its task has exited (proc(5)), which a thread meets between the
 * listing of its process's tasks and the read of its own files.
 */
const ENDED_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ESRCH"])

/** The errno code a failed read's cause carries, none where its cause is no errno exception. */
const errnoOf = (cause: unknown): Option.Option<string> =>
	typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
		? Option.some(cause.code)
		: Option.none()

/**
 * Whether a failed read found its process or thread ended (ENDED_ERRNOS): nothing to read, so no progress and no error;
 * any other failure of a read is the reader's, which the guard reports.
 */
const gone = (error: PlatformError.PlatformError): boolean =>
	Option.exists(errnoOf(error.reason.cause), (code) => ENDED_ERRNOS.has(code))

/** A /proc file's text, none once the process or thread it describes is gone. */
const procText = (fs: FileSystem.FileSystem, file: string) =>
	Effect.catchIf(Effect.asSome(fs.readFileString(file)), gone, () =>
		Effect.succeed(Option.none<string>())
	)

/** The entries of a /proc directory, none once the process it describes is gone. */
const procEntries = (fs: FileSystem.FileSystem, dir: string) =>
	Effect.catchIf(fs.readDirectory(dir), gone, () => Effect.succeed<ReadonlyArray<string>>([]))

/** A stat file read, none once its process or thread is gone, or CpuTimeUnreadable for a line outside its format. */
const statOf = (fs: FileSystem.FileSystem, file: string) =>
	Effect.flatMap(
		procText(fs, file),
		Option.match({
			onNone: () => Effect.succeed(Option.none<Reading>()),
			onSome: (line) =>
				Effect.map(
					Effect.fromOption(
						Option.flatMap(Str.lastIndexOf(")")(line), (end) =>
							Option.fromNullishOr(statFields.exec(Str.slice(end)(line))?.groups)
						),
						() => new CpuTimeUnreadable({ file, line })
					),
					(f) =>
						Option.some<Reading>({
							busy: BUSY_STATES.has(f.state),
							ticks: Number(f.utime) + Number(f.stime) + Number(f.cutime) + Number(f.cstime)
						})
				)
		})
	)

/**
 * The reading of `pid`'s tree, none once `pid` is gone: its process's stat, each of its threads' states, and the
 * reading of each child its threads started (/proc/pid/task/tid/children); a thread or a child gone mid-reading adds
 * nothing, and its time moves to its parent's waited-for children's once reaped.
 */
export const readingOf = (
	fs: FileSystem.FileSystem,
	pid: number
): Effect.Effect<Option.Option<Reading>, CpuTimeUnreadable | PlatformError.PlatformError> =>
	Effect.flatMap(
		statOf(fs, `/proc/${pid}/stat`),
		Option.match({
			onNone: () => Effect.succeed(Option.none<Reading>()),
			onSome: (own) =>
				Effect.gen(function* () {
					const tasks = yield* procEntries(fs, `/proc/${pid}/task`)
					const threads = yield* Effect.forEach(tasks, (tid) =>
						Effect.all({
							stat: statOf(fs, `/proc/${pid}/task/${tid}/stat`),
							children: procText(fs, `/proc/${pid}/task/${tid}/children`)
						})
					)
					const childPids = Arr.flatMap(threads, ({ children }) =>
						Option.match(children, {
							onNone: () => [],
							onSome: (text) =>
								Arr.map(
									Arr.filter(Arr.map(Str.split(text, " "), Str.trim), (p) => p !== ""),
									Number
								)
						})
					)
					const read = yield* Effect.forEach(childPids, (child) => readingOf(fs, child))
					const children = Arr.getSomes(read)
					return Option.some<Reading>({
						busy:
							Arr.some(threads, ({ stat }) => Option.exists(stat, (t) => t.busy)) ||
							Arr.some(children, (c) => c.busy),
						ticks: Arr.reduce(children, own.ticks, (sum, c) => sum + c.ticks)
					})
				})
		})
	)

/** Everything a command printed on one of its streams. */
const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

/**
 * How long `pid`'s tree was idle once it stalled, and the CPU time it had spent by its last progress, none when its
 * process was never read.
 */
type Stall = Readonly<{ idleMillis: number; cpuTicks: Option.Option<number> }>

/**
 * Whether a reading is progress: a thread of the tree running, waiting for a CPU or on the disk, the first reading of
 * the tree, or more CPU time than the last progress.
 */
const progressed = (last: Option.Option<number>, read: Option.Option<Reading>): boolean =>
	Option.isSome(read) && (read.value.busy || Option.isNone(last) || read.value.ticks > last.value)

/** The last progress a stall guard saw: the CPU time it read, none before the first reading, and when. */
type Progress = Readonly<{ cpu: Option.Option<number>; at: number }>

/**
 * Reads `pid`'s tree every `guard.every`, from the progress `last`, and ends once it has been idle for `guard.window`,
 * on the live clock, whatever clock the caller runs under; it never ends while the tree progresses, and a reading that
 * finds the process gone changes nothing, since its exit ends the run first.
 */
const stalledSince = (
	fs: FileSystem.FileSystem,
	pid: number,
	guard: StallGuard,
	last: Progress
): Effect.Effect<Stall, CpuTimeUnreadable | PlatformError.PlatformError> =>
	Effect.flatMap(Effect.all([liveMillis, readingOf(fs, pid)]), ([now, read]) => {
		if (progressed(last.cpu, read)) {
			return Effect.andThen(
				liveSleep(guard.every),
				stalledSince(fs, pid, guard, {
					cpu: Option.map(read, (r) => r.ticks),
					at: now
				})
			)
		}
		if (now - last.at >= Duration.toMillis(guard.window)) {
			const stall: Stall = { idleMillis: now - last.at, cpuTicks: last.cpu }
			return Effect.succeed(stall)
		}
		return Effect.andThen(liveSleep(guard.every), stalledSince(fs, pid, guard, last))
	})

/** Ends once `pid`'s tree has been idle for `guard.window` since the guard began. */
const stalled = (pid: number, guard: StallGuard) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const at = yield* liveMillis
		return yield* stalledSince(fs, pid, guard, { cpu: Option.none(), at })
	})

/**
 * Runs `command` with `args` in `cwd` to completion under `guard`: its exit status and what it printed, or
 * CompilerStalled once its process tree has been idle for the guard's window. A stalled command is sent
 * SIGQUIT, and SIGKILL a window later if it has not exited by then, and what it printed on stderr to its end is the
 * failure's dump. The child belongs to the run's scope, so an interrupted run kills it. PWD is `cwd` too, since tsgo
 * reads its working directory from PWD where PWD names it.
 */
export const guardedRun = (
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	guard: StallGuard
) =>
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
						idleMillis: ended.stall.idleMillis,
						cpuTicks: ended.stall.cpuTicks,
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
