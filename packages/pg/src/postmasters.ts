import {
	Array as Arr,
	Data,
	Effect,
	FileSystem,
	Formatter,
	Option,
	type PlatformError,
	Predicate,
	String as Str
} from "effect"

import { regex } from "arkregex"

/** A file the search reads cannot be read, for a reason other than its absence. */
class Unreadable extends Data.TaggedError("Unreadable")<{
	readonly path: string
	readonly cause: PlatformError.PlatformError
}> {
	override get message(): string {
		return `${this.path} cannot be read: ${this.cause.message}`
	}
}

/**
 * Whether a failure's cause is Node's error for a process that ended between /proc's listing and the read of its entry:
 * errno ESRCH, what Linux 7.0 answered a readlink of /proc/<pid>/exe for such a process (test/unit/substrate/
 * postmasters.test.ts, red under load in the unit tier of grizzle 864cc4cc6 with toolchain b1e430ad2). Effect's mapping of Node's errors (@effect/platform-node's
 * handleErrnoException) names no reason for it, so it arrives as an Unknown system error whose cause carries the code.
 */
const reaped = (cause: unknown): boolean =>
	Predicate.hasProperty(cause, "code") && cause.code === "ESRCH"

/**
 * What `read` reads of a process's /proc entry, or none once the process has ended: the entry gone (NotFound), or the
 * process reaped as it is read (an Unknown error whose cause is `reaped`). Every other failure is the read's.
 */
const whileRunning = <A>(
	read: Effect.Effect<A, PlatformError.PlatformError>
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError> =>
	read.pipe(
		Effect.asSome,
		Effect.catchReasons("PlatformError", {
			NotFound: () => Effect.succeedNone,
			Unknown: (reason, error) => (reaped(reason.cause) ? Effect.succeedNone : Effect.fail(error))
		})
	)

/**
 * A postmaster running a build some tree holds: its process; its data directory and port as its lock file,
 * postmaster.pid, records them (lines 2 and 4); and its executable as the kernel names it, which ends in ` (deleted)`
 * once the file it runs has been replaced or removed since it started.
 */
export interface Postmaster {
	readonly pid: number
	readonly data: string
	readonly port: number
	readonly executable: string
}

/** A postmaster's lock file holds no process, data directory and port in its first four lines. */
class LockFileUnparsed extends Data.TaggedError("LockFileUnparsed")<{
	readonly path: string
	readonly text: string
}> {
	override get message(): string {
		return `${this.path} is not a postmaster's lock file: ${Formatter.format(this.text)}`
	}
}

/**
 * A lock file's first four lines: the process that holds it (negative for a single-user backend), the data directory,
 * the start time and the port.
 */
const lockFile = regex("^(-?[0-9]+)\n([^\n]+)\n[^\n]*\n([0-9]+)\n")

/** A process's directory under /proc: its id. */
const processId = regex("^[0-9]+$")

/** The kernel's suffix to the name of an executable that was replaced or removed after its process started. */
const deleted = " (deleted)"

/** The path an executable was started from, as the kernel names it, without the suffix of one since replaced. */
const startedFrom = (executable: string): string =>
	Str.endsWith(deleted)(executable) ? Str.slice(0, -deleted.length)(executable) : executable

/**
 * Every postmaster running the bin/postgres of one of `trees`: each process whose executable, as /proc/<pid>/exe names
 * it, is or was one of those files, and whose data directory's lock file names the process itself. A postmaster works
 * in its data directory, so /proc/<pid>/cwd is that directory, and its backends, which share it, are not the process
 * the lock file names. A process that ends while it is read (whileRunning: its /proc entry gone, or the process reaped
 * as it is read), or whose executable this user may not read, is none; any other failure to read is Unreadable, so the
 * list is never short of a postmaster this user can see.
 */
export const postmastersOf = (
	trees: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<Postmaster>, Unreadable | LockFileUnparsed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const binaries = Arr.map(trees, (tree) => `${tree}/bin/postgres`)
		const postmaster = (
			pid: string
		): Effect.Effect<Option.Option<Postmaster>, Unreadable | LockFileUnparsed> =>
			Effect.gen(function* () {
				const exe = `/proc/${pid}/exe`
				const executable = yield* whileRunning(fs.readLink(exe)).pipe(
					Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeedNone),
					Effect.mapError((cause) => new Unreadable({ path: exe, cause }))
				)
				if (Option.isNone(executable) || !Arr.contains(binaries, startedFrom(executable.value))) {
					return Option.none()
				}
				const cwd = `/proc/${pid}/cwd`
				const lock = `${cwd}/postmaster.pid`
				const text = yield* Effect.mapError(
					whileRunning(fs.readFileString(lock)),
					(cause) => new Unreadable({ path: lock, cause })
				)
				if (Option.isNone(text)) {
					return Option.none()
				}
				const lines = lockFile.exec(text.value)
				if (lines === null) {
					return yield* new LockFileUnparsed({ path: lock, text: text.value })
				}
				const [, holder, data, port] = lines
				if (holder !== pid) {
					return Option.none()
				}
				return Option.some({
					pid: Number(pid),
					data,
					port: Number(port),
					executable: executable.value
				})
			})
		const pids = yield* Effect.mapError(
			fs.readDirectory("/proc"),
			(cause) => new Unreadable({ path: "/proc", cause })
		)
		const postmasters = yield* Effect.forEach(
			Arr.filter(pids, (name) => processId.test(name)),
			postmaster
		)
		return Arr.getSomes(postmasters)
	})
