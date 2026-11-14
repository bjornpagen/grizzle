import { liveMillis, liveSleep } from "@bjornpagen/testing/live"
import { regex } from "arkregex"
import {
	Array as Arr,
	Data,
	Duration,
	Effect,
	Fiber,
	Option,
	type PlatformError,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { derived, type Limit, measured } from "#compiler/core/limits.ts"

/**
 * The repository's compiler, the patched TypeScript 7 tsgo, run to completion as a child process under a stall guard. A
 * check that keeps making CPU progress runs for as long as it takes; one whose process tree makes none over a window
 * has stalled, a hang no output will end, so the guard asks it for its goroutines (SIGQUIT, on which Go's runtime
 * prints every goroutine's stack and exits) and fails with CompilerStalled, carrying that dump, instead of waiting on
 * it for as long as a test may run.
 */

/** What a compiler run reported: its exit status and everything it printed. */
export interface Ran {
	readonly status: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * How long a check's process tree may make no CPU progress before it has stalled: CPU time, as ps reads it, unchanged
 * across the whole window.
 */
const stallWindow: Limit = measured({
	value: 30_000,
	owner: "the type tier's compiler runs (test/types/batch)",
	unit: "milliseconds",
	scope:
		"one tsgo check the type-test batch or a scaling test runs, from its spawn to its exit, measured on its whole process tree",
	evidence:
		"test/types/batch/batch.test.ts, the stall guard's property, re-verifies the window: tsgo's watch mode, held at 0% CPU after its first check, fails with CompilerStalled, and a check run once, clean or with an error, never does. The result below is every sample of three runs of the batch's compiler options over the type tests' 18 fixture files, its process tree's CPU time read with ps every 100 ms, and two runs over the engine's sources and the fixtures read every 250 ms",
	observed: "2026-11-06, 19:20 to 19:45 CST",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0, TypeScript 7.1.0-beta (tsgo, Go 1.27.3) as pnpm install patches it, four checkers; load average 41 to 59 from other sessions throughout",
	workload:
		"the batch's own tsconfig over the type tests' fixtures (13.0 to 23.7 s wall, 10.8 to 12.5 s of CPU) and over the engine's src (3.8 s wall): the src type graph every batch loads, then the fixtures' checks",
	result:
		"no run went longer than one sampling interval without CPU progress (101 ms at 100 ms sampling, 251 ms at 250 ms); the sampler itself fell up to 894 ms behind its interval under load, and the compiler had progressed across every such stretch; a tsgo held at 0% CPU (its watch mode, after its first check) never progresses, and SIGQUIT ends it with every goroutine's stack",
	decision:
		"30 s is 120 times the longest stretch without progress seen at the coarser sampling, for page-ins and scheduling under memory pressure and loads beyond those measured; a check that progresses is never judged by it, and a stalled one fails in 30 s instead of a test's hour",
	revalidate:
		"a TypeScript 7 or Go upgrade; a check that starts waiting on something outside its process (a language service plugin's server, a network fetch); a CompilerStalled whose goroutine dump shows the checkers running"
})

/** How often the guard reads the CPU time: thirty times per window, so a stall is caught within a thirtieth of it. */
const stallSampleEvery: Limit = derived({
	owner: "the type tier's compiler runs (test/types/batch)",
	unit: "milliseconds",
	scope: "the interval between two readings of a check's CPU time",
	from: [stallWindow],
	derivation:
		"a stall is declared at the first reading a whole window after the last progress, so a thirtieth of the window delays it by at most a thirtieth; one ps per reading is cheap beside a check",
	compute: ([window]) => Math.ceil(window.value / 30)
})

/**
 * A stall guard: how long a process tree may make no CPU progress, and how often its CPU time is read. The type tier
 * passes stallWindow and stallSampleEvery; a test of the guard passes its own.
 */
export type StallGuard = Readonly<{ window: Duration.Duration; every: Duration.Duration }>

/** The guard the type tier's compiler runs under. */
const compilerStallGuard: StallGuard = {
	window: Duration.millis(stallWindow.value),
	every: Duration.millis(stallSampleEvery.value)
}

/** ps printed a line outside its format: the guard cannot read CPU time, so it fails rather than guess. */
class CpuTimeUnreadable extends Data.TaggedError("CpuTimeUnreadable")<{
	readonly line: string
}> {
	override get message(): string {
		return `the stall guard cannot read ps's line "${this.line}"`
	}
}

/**
 * A checked command made no CPU progress for `idleMillis`, at least its guard's window: `command` and `args` are what
 * ran, `cpuMillis` the CPU time its process tree had spent, none when ps never found it, and `goroutines` what it
 * printed on stderr once asked for its goroutines, the dump an upstream report needs.
 */
export class CompilerStalled extends Data.TaggedError("CompilerStalled")<{
	readonly command: string
	readonly args: ReadonlyArray<string>
	readonly idleMillis: number
	readonly cpuMillis: Option.Option<number>
	readonly goroutines: string
}> {
	override get message(): string {
		const spent = Option.match(this.cpuMillis, {
			onNone: () => "with no reading of its CPU time",
			onSome: (millis) => `after ${millis} ms of CPU`
		})
		return `${this.command} ${Arr.join(this.args, " ")} made no CPU progress for ${this.idleMillis} ms, ${spent}: a stall, which no output ends. What it printed when asked for its goroutines (SIGQUIT):\n${this.goroutines}`
	}
}

/** One row of `ps -A -o pid=,ppid=,time=`. */
const psRow = regex("^\\s*(?<pid>\\d+)\\s+(?<ppid>\\d+)\\s+(?<time>\\S+)\\s*$")

/** A CPU time as ps prints it: [[dd-]hh:]mm:ss with an optional fraction of a second. */
const cpuTime = regex(
	"^(?:(?<days>\\d+)-)?(?:(?<hours>\\d+):)?(?<minutes>\\d+):(?<seconds>\\d+)(?:\\.(?<fraction>\\d+))?$"
)

/** A CPU time in milliseconds, or none when the text is outside ps's format. */
const millisOf = (text: string): Option.Option<number> =>
	Option.map(Option.fromNullishOr(cpuTime.exec(text)?.groups), (time) => {
		const fraction = time.fraction ?? ""
		const hours = Number(time.days ?? "0") * 24 + Number(time.hours ?? "0")
		const seconds = (hours * 60 + Number(time.minutes)) * 60 + Number(time.seconds)
		return seconds * 1000 + Math.round(Number(`0.${fraction}`) * 1000)
	})

/** A process as ps lists it: its parent and its CPU time. */
type Listed = Readonly<{ pid: number; ppid: number; millis: number }>

/** ps's listing of every process, each line read or refused. */
const listed = (text: string): Effect.Effect<ReadonlyArray<Listed>, CpuTimeUnreadable> =>
	Effect.forEach(
		Arr.filter(Str.split(text, "\n"), (line) => Str.trim(line) !== ""),
		(line) =>
			Effect.fromOption(
				Option.flatMap(Option.fromNullishOr(psRow.exec(line)?.groups), (row) =>
					Option.map(millisOf(row.time), (millis): Listed => ({
						pid: Number(row.pid),
						ppid: Number(row.ppid),
						millis
					}))
				),
				() => new CpuTimeUnreadable({ line })
			)
	)

/** The CPU time of `root` and every process under it, or none once `root` is gone. */
const treeMillis = (rows: ReadonlyArray<Listed>, root: number): Option.Option<number> => {
	const children = Arr.groupBy(rows, (row) => String(row.ppid))
	const tree = (pid: number): ReadonlyArray<Listed> =>
		Arr.flatMap(children[String(pid)] ?? [], (child) => [child, ...tree(child.pid)])
	return Option.map(
		Arr.findFirst(rows, (row) => row.pid === root),
		(own) => Arr.reduce(tree(root), own.millis, (sum, row) => sum + row.millis)
	)
}

/** Everything a command printed on one of its streams. */
const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

/** The CPU time of `pid`'s process tree, read once with ps; none once the process is gone. */
const cpuOf = (pid: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const ps = yield* ChildProcess.make("ps", ["-A", "-o", "pid=,ppid=,time="], {
				stdin: "ignore"
			})
			const [out] = yield* Effect.all([text(ps.stdout), ps.exitCode], {
				concurrency: "unbounded"
			})
			const rows = yield* listed(out)
			return treeMillis(rows, pid)
		})
	)

/**
 * How long `pid`'s tree went without progress once it stalled, and the CPU time it had spent by its last progress, none
 * when ps never found it.
 */
type Stall = Readonly<{ idleMillis: number; cpuMillis: Option.Option<number> }>

/** Whether a reading is progress: the first reading of the tree, or more CPU time than the last progress. */
const progressed = (last: Option.Option<number>, read: Option.Option<number>): boolean =>
	Option.isSome(read) && (Option.isNone(last) || read.value > last.value)

/** The last progress a stall guard saw: the CPU time it read, none before the first reading, and when. */
type Progress = Readonly<{ cpu: Option.Option<number>; at: number }>

/**
 * Reads `pid`'s CPU time every `guard.every`, from the progress `last`, and ends once it has not moved for
 * `guard.window`, on the live clock, whatever clock the caller runs under; it never ends while the tree progresses, and
 * a reading that finds the process gone changes nothing, since its exit ends the run first.
 */
const stalledSince = (
	pid: number,
	guard: StallGuard,
	last: Progress
): Effect.Effect<
	Stall,
	CpuTimeUnreadable | PlatformError.PlatformError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.flatMap(Effect.all([liveMillis, cpuOf(pid)]), ([now, read]) => {
		if (progressed(last.cpu, read)) {
			return Effect.andThen(
				liveSleep(guard.every),
				stalledSince(pid, guard, { cpu: read, at: now })
			)
		}
		if (now - last.at >= Duration.toMillis(guard.window)) {
			const stall: Stall = { idleMillis: now - last.at, cpuMillis: last.cpu }
			return Effect.succeed(stall)
		}
		return Effect.andThen(liveSleep(guard.every), stalledSince(pid, guard, last))
	})

/** Ends once `pid`'s tree has made no CPU progress for `guard.window` since the guard began. */
const stalled = (pid: number, guard: StallGuard) =>
	Effect.flatMap(liveMillis, (at) => stalledSince(pid, guard, { cpu: Option.none(), at }))

/**
 * Runs `command` with `args` in `cwd` to completion under `guard`: its exit status and what it printed, or
 * CompilerStalled once its process tree has made no CPU progress for the guard's window. A stalled command is sent
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
						cpuMillis: ended.stall.cpuMillis,
						goroutines: yield* Fiber.join(stderr)
					})
				}
			}
		})
	)

/** The repository's compiler at `root`, run with `args` under the type tier's stall guard. */
export const compiled = (root: string, args: ReadonlyArray<string>) =>
	guardedRun(
		process.execPath,
		[`${root}/node_modules/typescript/bin/tsc`, ...args],
		root,
		compilerStallGuard
	)
