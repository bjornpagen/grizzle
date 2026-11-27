/** What the properties of postmasters.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Data, Effect, FileSystem, Option, PlatformError, Stream, String as Str } from "effect"
import { ChildProcess } from "effect/process"
import { postmastersOf } from "#pg/postmasters.ts"

/** The binary a case's process runs: its tree's, its tree's replaced after the process started, or another tree's. */
const binaries = ["the tree's", "the tree's, replaced", "another tree's"] as const
type Binary = (typeof binaries)[number]

/** What the data directory's postmaster.pid holds: the process, another process, nothing, or text of no lock file. */
const locks = ["naming it", "naming another process", "absent", "malformed"] as const
type Lock = (typeof locks)[number]

/**
 * What else the scan meets: nothing, or a process /proc lists that the kernel reaps before the scan reads it, as any
 * process of the machine can end between /proc's listing and the read of its entry.
 */
const scans = ["alone", "beside a process reaped as it is read"] as const
type Scan = (typeof scans)[number]

/** A case: one process, by the binary it runs and its lock file, and what else its scan meets. */
interface Sketch {
	readonly binary: Binary
	readonly lock: Lock
	readonly scan: Scan
}

export const sketchGen: Gen<Sketch> = (source) => ({
	binary: source.draw(element(binaries)),
	lock: source.draw(element(locks)),
	scan: source.draw(element(scans))
})

/** What postmastersOf finds of a case's process: it, nothing, or a lock file it refuses. */
type Verdict = "listed" | "unlisted" | "unparsed"

/** The reason for a case's verdict, as the search must reach each. */
export type PostmasterFeature =
	| "a postmaster of the tree listed"
	| "a postmaster of a replaced binary listed"
	| "another tree's process unlisted"
	| "a backend's directory unlisted"
	| "a process without a lock file unlisted"
	| "a malformed lock file refused"
	| "a process reaped as it is read skipped"

/** The model: what postmastersOf finds of a case's process, and why. */
export const predicted = (s: Sketch): readonly [Verdict, PostmasterFeature] => {
	if (s.binary === "another tree's") {
		return ["unlisted", "another tree's process unlisted"]
	}
	switch (s.lock) {
		case "malformed":
			return ["unparsed", "a malformed lock file refused"]
		case "absent":
			return ["unlisted", "a process without a lock file unlisted"]
		case "naming another process":
			return ["unlisted", "a backend's directory unlisted"]
		case "naming it":
			return [
				"listed",
				s.binary === "the tree's"
					? "a postmaster of the tree listed"
					: "a postmaster of a replaced binary listed"
			]
	}
}

/** What the kernel answered kill(2) of a pid no process holds: Node's ESRCH error, as it threw it. */
class KernelAnswer extends Data.TaggedError("KernelAnswer")<{ readonly cause: unknown }> {}

/**
 * The scan's file system beside a process reaped as it is read: /proc's listing also holds a pid the kernel never
 * assigns, one above /proc/sys/kernel/pid_max, and a read of its /proc/<pid>/exe fails as Node's file system fails a
 * read of a process reaped after /proc listed it: an Unknown system error (@effect/platform-node's mapping names no
 * reason for ESRCH), its cause the kernel's own ESRCH for that pid, which kill(2) answers.
 */
const reapedAsRead = (fs: FileSystem.FileSystem) =>
	Effect.gen(function* () {
		const pidMax = yield* fs.readFileString("/proc/sys/kernel/pid_max")
		const pid = Number(Str.trim(pidMax)) + 1
		const answer = yield* Effect.orDie(
			Effect.flip(
				Effect.try({
					try: () => process.kill(pid, 0),
					catch: (cause) => new KernelAnswer({ cause })
				})
			)
		)
		const exe = `/proc/${pid}/exe`
		return FileSystem.FileSystem.of({
			...fs,
			readDirectory: (path, options) =>
				path === "/proc"
					? Effect.map(fs.readDirectory(path, options), (names) => [...names, String(pid)])
					: fs.readDirectory(path, options),
			readLink: (path) =>
				path === exe
					? Effect.fail(
							PlatformError.systemError({
								_tag: "Unknown",
								module: "FileSystem",
								method: "readLink",
								pathOrDescriptor: path,
								syscall: "readlink",
								cause: answer.cause
							})
						)
					: fs.readLink(path)
		})
	})

/** The port a case's lock file records. */
const port = 5999

/** The kernel's suffix to the name of an executable replaced or removed after its process started. */
const deleted = " (deleted)"

/**
 * A case's process and its verdict: under `root`, the case's own directory, a copy of this Node binary, a program that
 * names its pid on its first line and runs until it is killed, and a tree and another tree whose bin/postgres are hard
 * links of it; the process running the chosen one in its data directory until the case ends, the lock file written
 * once its pid is known, and the binary replaced when the case asks.
 *
 * The pid is the one the process names, never the pid of the child the case starts: the testing library runs a child
 * it cannot record under strace(1) (runner/observe.ts), so the child it starts is strace, and the process running the
 * binary is strace's. A lock file naming the child's pid names strace, a process of no tree, and the scan rightly lists
 * nothing (toolchain 54e53afb, df3af15, where every case of a postmaster listed failed so). The pid on its first line is
 * also read after the binary is executed, so a binary replaced is replaced under a process that runs it.
 */
export const caseOf = (root: string, s: Sketch) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const binary = `${root}/postgres`
		const tree = `${root}/tree`
		const other = `${root}/other`
		const data = `${root}/data`
		yield* fs.copyFile(process.execPath, binary)
		yield* Effect.forEach(
			[`${tree}/bin`, `${other}/bin`, data],
			(path) => fs.makeDirectory(path, { recursive: true }),
			{ discard: true }
		)
		yield* fs.link(binary, `${tree}/bin/postgres`)
		yield* fs.link(binary, `${other}/bin/postgres`)
		const executable = `${s.binary === "another tree's" ? other : tree}/bin/postgres`
		const child = yield* ChildProcess.make(
			executable,
			["-e", "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 2 ** 30)"],
			{
				cwd: data,
				stdin: "ignore",
				stderr: "ignore",
				killSignal: "SIGKILL"
			}
		)
		const named = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(child.stdout)))
		const pid = Number(Option.getOrThrow(named))
		const holder = s.lock === "naming another process" ? process.pid : pid
		if (s.lock !== "absent") {
			yield* fs.writeFileString(
				`${data}/postmaster.pid`,
				s.lock === "malformed" ? "no lock file\n" : `${holder}\n${data}\n0\n${port}\n`
			)
		}
		if (s.binary === "the tree's, replaced") {
			yield* fs.remove(`${tree}/bin/postgres`)
			yield* fs.link(binary, `${tree}/bin/postgres`)
		}
		const scanned =
			s.scan === "alone"
				? postmastersOf([tree])
				: Effect.provideServiceEffect(
						postmastersOf([tree]),
						FileSystem.FileSystem,
						reapedAsRead(fs)
					)
		const found = yield* Effect.result(scanned)
		return {
			found,
			listed: {
				pid,
				data,
				port,
				executable: s.binary === "the tree's, replaced" ? `${executable}${deleted}` : executable
			}
		}
	})
