import {
	Array as Arr,
	Data,
	Effect,
	Equivalence,
	FileSystem,
	Formatter,
	Option,
	type PlatformError,
	String as Str
} from "effect"

import { regex } from "arkregex"

/**
 * A build of a pinned PostgreSQL release: the release's commit (pin.env's PG_PIN_COMMIT) and the source patches applied
 * to it, in order, each `<file>=<its SHA-256>` as PG_PIN_PATCHES lists it, so a patch is its file and its content, and
 * one rewritten under its old name is another patch. A checkout's pin.env names the build it makes; the stamp build.sh
 * writes last into a build's tree (scripts/pg/lib.sh core_stamp) records the build that tree holds.
 */
export interface Build {
	readonly commit: string
	readonly patches: ReadonlyArray<string>
}

/** A patch list as the shell splits PG_PIN_PATCHES and a stamp's text: its words, each a patch. */
export const patchesOf = (text: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(text, regex("\\s+")), Str.isNonEmpty)

/**
 * What build.sh does with a checkout's pin, given the build the installation holds: `build` the pin when the
 * installation holds no build of the pin's release, or one whose every patch the pin applies too (another release is a
 * repin, which drops the patches its release includes); leave it, `built`, when the installation holds the pin itself,
 * the same patches in the same order; and refuse a pin `older` than the installation, one of the same release that
 * lacks patches its build carries, `lacking`, in the installation's order, which building would drop.
 */
export type Verdict =
	| { readonly kind: "build" }
	| { readonly kind: "built" }
	| { readonly kind: "older"; readonly lacking: Arr.NonEmptyReadonlyArray<string> }

const samePatches = Arr.makeEquivalence(Equivalence.String)

/**
 * The verdict on building `pin` over the installation's build, `installed`, none when the installation holds no build:
 * keyed on the release's commit, never on how many patches either holds, so a repin that drops patches builds and a
 * checkout of the same release that lacks one of the installation's patches is refused.
 */
export const verdict = (installed: Option.Option<Build>, pin: Build): Verdict =>
	Option.match(
		Option.filter(installed, (build) => build.commit === pin.commit),
		{
			onNone: (): Verdict => ({ kind: "build" }),
			onSome: (build): Verdict => {
				const lacking = Arr.difference(build.patches, pin.patches)
				return Arr.isReadonlyArrayNonEmpty(lacking)
					? { kind: "older", lacking }
					: samePatches(build.patches, pin.patches)
						? { kind: "built" }
						: { kind: "build" }
			}
		}
	)

/** An installation holds the stamps of several builds, which no tree build.sh puts in place does. */
class StampsSeveral extends Data.TaggedError("StampsSeveral")<{
	readonly installation: string
	readonly stamps: ReadonlyArray<string>
}> {
	override get message(): string {
		return `${this.installation} holds the stamps of several builds, ${Arr.join(this.stamps, ", ")}, where build.sh writes one`
	}
}

/** A file the decision reads cannot be read, for a reason other than its absence. */
class Unreadable extends Data.TaggedError("Unreadable")<{
	readonly path: string
	readonly cause: PlatformError.PlatformError
}> {
	override get message(): string {
		return `${this.path} cannot be read: ${this.cause.message}`
	}
}

/** What `read` reads from `path`, or none when nothing is there: every other failure is Unreadable. */
const unlessAbsent = <A>(
	path: string,
	read: Effect.Effect<A, PlatformError.PlatformError>
): Effect.Effect<Option.Option<A>, Unreadable> =>
	read.pipe(
		Effect.asSome,
		Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
		Effect.mapError((cause) => new Unreadable({ path, cause }))
	)

/**
 * The build the installation at `installation` holds, read from its stamp, the one file of its top directory whose name
 * starts with `stem` (scripts/pg/lib.sh core_stamp), the release's commit after it and the patches its text: none when
 * there is no installation or no stamp in it, a build that never finished. Several stamps are refused.
 */
export const installedBuild = (
	installation: string,
	stem: string
): Effect.Effect<Option.Option<Build>, StampsSeveral | Unreadable, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const names = yield* unlessAbsent(installation, fs.readDirectory(installation))
		const stamps = Arr.filter(
			Option.getOrElse(names, (): ReadonlyArray<string> => []),
			Str.startsWith(stem)
		)
		if (stamps.length > 1) {
			return yield* new StampsSeveral({ installation, stamps })
		}
		return yield* Effect.transposeOption(
			Option.map(Arr.head(stamps), (name) => {
				const path = `${installation}/${name}`
				return Effect.mapBoth(fs.readFileString(path), {
					onFailure: (cause) => new Unreadable({ path, cause }),
					onSuccess: (text): Build => ({
						commit: Str.slice(stem.length)(name),
						patches: patchesOf(text)
					})
				})
			})
		)
	})

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

/** Whether two files are one: the same device and the same inode. */
const sameFile = (a: FileSystem.File.Info, b: FileSystem.File.Info): boolean =>
	a.dev === b.dev && Option.isSome(a.ino) && Option.isSome(b.ino) && a.ino.value === b.ino.value

/**
 * Every postmaster running the bin/postgres of one of `trees`, other than the one whose data directory is `selected`:
 * each process whose executable, as /proc/<pid>/exe names it, is or was one of those files, and whose data directory's
 * lock file names the process itself. A postmaster works in its data directory, so /proc/<pid>/cwd is that directory,
 * and its backends, which share it, are not the process the lock file names. A process that ends while it is read, or
 * whose executable this user may not read, is none; any other failure to read is Unreadable, so the list is never
 * short of a postmaster this user can see.
 */
export const postmastersOf = (
	trees: ReadonlyArray<string>,
	selected: string
): Effect.Effect<ReadonlyArray<Postmaster>, Unreadable | LockFileUnparsed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const binaries = Arr.map(trees, (tree) => `${tree}/bin/postgres`)
		const selectedData = yield* unlessAbsent(selected, fs.stat(selected))
		const postmaster = (
			pid: string
		): Effect.Effect<Option.Option<Postmaster>, Unreadable | LockFileUnparsed> =>
			Effect.gen(function* () {
				const exe = `/proc/${pid}/exe`
				const executable = yield* fs.readLink(exe).pipe(
					Effect.asSome,
					Effect.catchReasons("PlatformError", {
						NotFound: () => Effect.succeedNone,
						PermissionDenied: () => Effect.succeedNone
					}),
					Effect.mapError((cause) => new Unreadable({ path: exe, cause }))
				)
				if (Option.isNone(executable) || !Arr.contains(binaries, startedFrom(executable.value))) {
					return Option.none()
				}
				const cwd = `/proc/${pid}/cwd`
				const lock = `${cwd}/postmaster.pid`
				const text = yield* unlessAbsent(lock, fs.readFileString(lock))
				if (Option.isNone(text)) {
					return Option.none()
				}
				const lines = lockFile.exec(text.value)
				if (lines === null) {
					return yield* new LockFileUnparsed({ path: lock, text: text.value })
				}
				const [, holder, data, port] = lines
				const directory = yield* unlessAbsent(cwd, fs.stat(cwd))
				if (
					holder !== pid ||
					Option.isNone(directory) ||
					Option.exists(selectedData, (info) => sameFile(info, directory.value))
				) {
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
