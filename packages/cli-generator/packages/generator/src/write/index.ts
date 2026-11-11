import type { PlatformError, Scope } from "effect"
import {
	Array as Arr,
	ByteSize,
	Effect,
	Exit,
	FileSystem,
	Option,
	Order,
	Path,
	Random,
	Ref,
	Schema,
	String as Str
} from "effect"
import type { Digest } from "effect/crypto"
import { sha256Hex } from "#model/digest.ts"
import { acquireRunLock, runLockFileName } from "#write/lock.ts"
import type { RunLock, RunLockHeld, RunLockUnavailable } from "#write/lock.ts"
import type { ManifestEntry } from "#write/manifest.ts"
import { decodeManifest, manifestFileName, printManifest } from "#write/manifest.ts"

/**
 * One generated file: a relative `/`-separated path inside the output directory and its text
 * (written as UTF-8).
 */
export interface GeneratedFile {
	readonly path: string
	readonly content: string
}

/**
 * The writer refused before or during the write; `subject` names the path involved.
 */
export class WriteRefused extends Schema.TaggedError<
	WriteRefused,
	{ readonly brand: unique symbol }
>()("WriteRefused", {
	reason: Schema.Literals([
		"duplicate-path",
		"io",
		"output-not-directory",
		"output-parent-missing",
		"path-conflict",
		"reserved-path",
		"symlink",
		"unsafe-path"
	]),
	subject: Schema.String
}) {}

/**
 * A previous-manifest path the writer left in place, or a previous manifest it could not use.
 */
export interface WriteNotice {
	readonly reason:
		| "edited"
		| "manifest-unreadable"
		| "not-regular-file"
		| "remove-failed"
		| "symlink"
		| "unreadable"
		| "unsafe-path"
	readonly path: string
}

/**
 * The largest previous manifest the writer reads (4 MiB); a larger file is reported, not read.
 */
const maxPreviousManifestBytes = 4 * 1024 * 1024

type Services = FileSystem.FileSystem | Path.Path | Digest.Digest

const fold = (path: string): string => Str.toLowerCase(Str.normalize("NFC")(path))

const reserved: ReadonlySet<string> = new Set([fold(manifestFileName), fold(runLockFileName)])

const segmentsOf = (path: string): readonly string[] => Str.split("/")(path)

const wellFormed = (path: string): boolean =>
	path !== "" &&
	!Str.includes("\\")(path) &&
	!Str.includes("\u0000")(path) &&
	Arr.every(segmentsOf(path), (segment) => segment !== "" && segment !== "." && segment !== "..")

const confined = (path: Path.Path, outputDir: string, relative: string): boolean =>
	wellFormed(relative) && Option.isSome(path.resolveWithin(outputDir, relative))

const ancestorsOf = (path: string): readonly string[] => {
	const parents = Arr.dropRight(segmentsOf(path), 1)

	return Arr.map(parents, (_, index) => Arr.join(Arr.take(parents, index + 1), "/"))
}

const refused = (reason: WriteRefused["reason"], subject: string) =>
	Effect.fail(WriteRefused.make({ reason, subject }))

/** The first path of the plan the writer refuses before any mutation, as its refusal. */
const planFault = (
	path: Path.Path,
	outputDir: string,
	files: readonly GeneratedFile[]
): Option.Option<WriteRefused> => {
	const folded = new Set<string>()

	for (const { path: relative } of files) {
		const key = fold(relative)

		if (!confined(path, outputDir, relative)) {
			return Option.some(WriteRefused.make({ reason: "unsafe-path", subject: relative }))
		}

		if (reserved.has(key)) {
			return Option.some(WriteRefused.make({ reason: "reserved-path", subject: relative }))
		}

		if (folded.has(key)) {
			return Option.some(WriteRefused.make({ reason: "duplicate-path", subject: relative }))
		}

		folded.add(key)
	}

	return Option.map(
		Arr.findFirst(files, ({ path: relative }) =>
			Arr.some(ancestorsOf(fold(relative)), (ancestor) => folded.has(ancestor))
		),
		(conflicting) => WriteRefused.make({ reason: "path-conflict", subject: conflicting.path })
	)
}

const ioFailure = (subject: string) => (_error: PlatformError.PlatformError) =>
	WriteRefused.make({ reason: "io", subject })

/**
 * A temp sibling's name part. The run lock keeps every other run out of the output directory and
 * `wx` refuses a name already taken, so the part needs no cryptographic randomness.
 */
const tempToken = Effect.map(
	Effect.all([Random.nextInt, Random.nextInt]),
	([high, low]) => `${high.toString(36)}${low.toString(36)}`
)

const probe = (fs: FileSystem.FileSystem, target: string, subject: string) =>
	fs.lstat(target).pipe(
		Effect.asSome,
		Effect.catchIf(
			(error) => error.reason._tag === "NotFound",
			() => Effect.succeedNone
		),
		Effect.mapError(ioFailure(subject))
	)

/**
 * Walk the existing ancestors of `relative` under `outputDir` (creating the missing ones when
 * `create`), then check the target itself: a symlink anywhere is refused, a non-directory ancestor
 * or a directory at the target is a conflict. Returns the target's type, none when absent.
 */
const walk = (
	outputDir: string,
	relative: string,
	create: boolean
): Effect.Effect<Option.Option<FileSystem.File.Type>, WriteRefused, Services> =>
	Effect.gen(function* step1() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path

		for (const ancestor of ancestorsOf(relative)) {
			const info = yield* probe(fs, path.join(outputDir, ancestor), ancestor)

			if (Option.isNone(info)) {
				if (!create) {
					return Option.none()
				}

				yield* fs
					.makeDirectory(path.join(outputDir, ancestor))
					.pipe(Effect.mapError(ioFailure(ancestor)))
			} else if (info.value.type === "SymbolicLink") {
				return yield* refused("symlink", ancestor)
			} else if (info.value.type !== "Directory") {
				return yield* refused("path-conflict", ancestor)
			}
		}

		const target = yield* probe(fs, path.join(outputDir, relative), relative)

		return Option.isSome(target) ? Option.some(target.value.type) : Option.none()
	})

const checkTarget = (outputDir: string, relative: string, create: boolean) =>
	walk(outputDir, relative, create).pipe(
		Effect.flatMap((type) => {
			if (Option.isNone(type) || type.value === "File") {
				return Effect.void
			}

			return refused(type.value === "SymbolicLink" ? "symlink" : "path-conflict", relative)
		})
	)

/**
 * Check the output directory and create it (one level) when it is absent; true when created here.
 */
const ensureOutput = (outputDir: string): Effect.Effect<boolean, WriteRefused, Services> =>
	Effect.gen(function* step2() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const existing = yield* probe(fs, outputDir, outputDir)

		if (Option.isSome(existing)) {
			if (existing.value.type === "SymbolicLink") {
				return yield* refused("symlink", outputDir)
			}

			return existing.value.type === "Directory"
				? false
				: yield* refused("output-not-directory", outputDir)
		}

		const parent = yield* fs.stat(path.dirname(outputDir)).pipe(Effect.option)

		if (Option.isNone(parent) || parent.value.type !== "Directory") {
			return yield* refused("output-parent-missing", outputDir)
		}

		return yield* fs.makeDirectory(outputDir).pipe(
			Effect.as(true),
			Effect.catchIf(
				(error) => error.reason._tag === "AlreadyExists",
				() => Effect.succeed(false)
			),
			Effect.mapError(ioFailure(outputDir))
		)
	})

const writeAtomic = (
	outputDir: string,
	lock: RunLock,
	written: Ref.Ref<readonly string[]>,
	relative: string,
	content: string
): Effect.Effect<void, WriteRefused, Services> =>
	Effect.gen(function* step3() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path

		yield* checkTarget(outputDir, relative, true)
		yield* Ref.update(written, (all) => [...all, relative])

		const target = path.join(outputDir, relative)
		const token = yield* tempToken
		const temp = path.join(path.dirname(target), `.${path.basename(target)}.${token}.tmp`)
		yield* lock.registerTemp(temp)
		yield* fs
			.writeFileString(temp, content, { flag: "wx" })
			.pipe(Effect.mapError(ioFailure(relative)))
		yield* fs.rename(temp, target).pipe(Effect.mapError(ioFailure(relative)))
	})

const unreadable: WriteNotice = { path: manifestFileName, reason: "manifest-unreadable" }

/**
 * The previous manifest's entries; a missing manifest is empty, and one that is a symlink, not a
 * file, over the size bound, unreadable or not the manifest shape yields a notice and no entries.
 */
const readPrevious = (
	outputDir: string
): Effect.Effect<
	{ readonly entries: readonly ManifestEntry[]; readonly notices: readonly WriteNotice[] },
	WriteRefused,
	Services
> =>
	Effect.gen(function* step4() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const location = path.join(outputDir, manifestFileName)
		const info = yield* probe(fs, location, manifestFileName)
		const none = { entries: [], notices: [] }
		const skipped = { entries: [], notices: [unreadable] }

		if (Option.isNone(info)) {
			return none
		}

		if (info.value.type !== "File" || Number(info.value.size) > maxPreviousManifestBytes) {
			return skipped
		}

		const entries = yield* fs
			.readFileString(location)
			.pipe(Effect.flatMap(decodeManifest), Effect.option)

		return Option.match(entries, {
			onNone: () => skipped,
			onSome: (all) => ({ entries: all, notices: [] })
		})
	})

const encoder = new TextEncoder()

/**
 * Whether the regular file at `target` holds exactly the bytes the manifest entry records: its
 * size is checked first, so only a file of the recorded size is read and hashed, and memory stays
 * bounded by what the generator itself wrote.
 */
const isAsWritten = (
	fs: FileSystem.FileSystem,
	target: string,
	entry: ManifestEntry
): Effect.Effect<boolean, PlatformError.PlatformError, Digest.Digest> =>
	Effect.gen(function* asWritten() {
		const info = yield* fs.lstat(target)
		if (info.size !== ByteSize.bytes(entry.size)) {
			return false
		}

		const bytes = yield* fs.readFile(target)
		const current = yield* sha256Hex(bytes)

		return current === entry.sha256
	})

const checkStale = (
	outputDir: string,
	entry: ManifestEntry
): Effect.Effect<Option.Option<WriteNotice>, WriteRefused, Services> =>
	Effect.gen(function* step5() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const notice = (reason: WriteNotice["reason"]) =>
			Option.some<WriteNotice>({ path: entry.path, reason })

		if (!confined(path, outputDir, entry.path) || reserved.has(fold(entry.path))) {
			return notice("unsafe-path")
		}

		const found = yield* walk(outputDir, entry.path, false).pipe(
			Effect.catchIf(
				(error) => error.reason === "symlink",
				() => Effect.succeedSome<FileSystem.File.Type>("SymbolicLink")
			),
			Effect.catchIf(
				(error) => error.reason === "path-conflict",
				() => Effect.succeedSome<FileSystem.File.Type>("Directory")
			)
		)

		if (Option.isNone(found)) {
			return Option.none()
		}

		if (found.value === "SymbolicLink") {
			return notice("symlink")
		}

		if (found.value !== "File") {
			return notice("not-regular-file")
		}

		const target = path.join(outputDir, entry.path)
		const unchanged = yield* isAsWritten(fs, target, entry).pipe(
			Effect.mapError(ioFailure(entry.path))
		)

		if (!unchanged) {
			return notice("edited")
		}

		return yield* fs.remove(target).pipe(
			Effect.as(Option.none<WriteNotice>()),
			Effect.orElseSucceed(() => notice("remove-failed"))
		)
	})

/**
 * A stale path that cannot be checked or read is left in place with a notice, never a failed run.
 */
const staleNotice = (
	outputDir: string,
	entry: ManifestEntry
): Effect.Effect<Option.Option<WriteNotice>, never, Services> =>
	checkStale(outputDir, entry).pipe(
		Effect.orElseSucceed(() => Option.some<WriteNotice>({ path: entry.path, reason: "unreadable" }))
	)

const removeStale = (
	outputDir: string,
	previous: readonly ManifestEntry[],
	written: ReadonlySet<string>
): Effect.Effect<readonly WriteNotice[], never, Services> =>
	Effect.forEach(
		Arr.filter(previous, (entry) => !written.has(fold(entry.path))),
		(entry) => staleNotice(outputDir, entry)
	).pipe(Effect.map(Arr.getSomes))

/**
 * Remove the files this run wrote, last first; run while the lock is still held. The directories
 * the run made stay, empty: Effect's `FileSystem.remove` has no removal of an empty directory
 * alone, and a recursive one would delete what another party placed, so the writer never deletes
 * anything it did not write.
 */
const undoWrites = (outputDir: string, written: readonly string[]) =>
	Effect.gen(function* step8() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path

		for (const relative of Arr.reverse(written)) {
			yield* Effect.ignore(fs.remove(path.join(outputDir, relative), { force: true }))
		}
	})

const writeUnderLock = (
	outputDir: string,
	sorted: readonly GeneratedFile[],
	manifest: string,
	lock: RunLock,
	written: Ref.Ref<readonly string[]>
): Effect.Effect<readonly WriteNotice[], WriteRefused, Services> =>
	Effect.gen(function* step9() {
		for (const relative of [...Arr.map(sorted, (file) => file.path), manifestFileName]) {
			yield* checkTarget(outputDir, relative, false)
		}

		const previous = yield* readPrevious(outputDir)

		for (const file of sorted) {
			yield* writeAtomic(outputDir, lock, written, file.path, file.content)
		}

		yield* writeAtomic(outputDir, lock, written, manifestFileName, manifest)

		const stale = yield* removeStale(
			outputDir,
			previous.entries,
			new Set(Arr.map(sorted, (file) => fold(file.path)))
		)

		return [...previous.notices, ...stale]
	})

const writeLocked = (
	outputDir: string,
	files: readonly GeneratedFile[],
	created: boolean
): Effect.Effect<
	readonly WriteNotice[],
	RunLockHeld | RunLockUnavailable | WriteRefused,
	Services | Scope.Scope
> =>
	Effect.gen(function* step6() {
		const sorted = Arr.sort(
			files,
			Order.mapInput(Order.String, (file: GeneratedFile) => file.path)
		)
		const entries = yield* Effect.forEach(sorted, (file) => {
			const bytes = encoder.encode(file.content)

			return sha256Hex(bytes).pipe(
				Effect.map((sha256) => ({ path: file.path, sha256, size: bytes.length }))
			)
		})
		const manifest = yield* printManifest(entries).pipe(
			Effect.mapError(() => WriteRefused.make({ reason: "unsafe-path", subject: manifestFileName }))
		)
		const lock = yield* acquireRunLock(outputDir)
		const written = yield* Ref.make<readonly string[]>([])

		return yield* writeUnderLock(outputDir, sorted, manifest, lock, written).pipe(
			Effect.onExit((exit) =>
				created && Exit.isFailure(exit)
					? Ref.get(written).pipe(Effect.flatMap((all) => undoWrites(outputDir, all)))
					: Effect.void
			)
		)
	})

/**
 * Write `files` into `outputDir` (design 3.6, Write and Run lock): validate every path before any
 * mutation, claim the run lock, replace each file by temp sibling plus rename, commit the manifest
 * last, then remove previous-manifest files the run no longer writes whose size and sha256 still
 * match. Files left in place and a previous manifest that could not be used come back as notices.
 * A failed run into an output directory it created removes the files it wrote and leaves the
 * directories, empty.
 */
export const writeFiles = (
	outputDir: string,
	files: readonly GeneratedFile[]
): Effect.Effect<
	readonly WriteNotice[],
	RunLockHeld | RunLockUnavailable | WriteRefused,
	Services
> =>
	Effect.gen(function* step7() {
		const path = yield* Path.Path
		const fault = planFault(path, outputDir, files)

		if (Option.isSome(fault)) {
			return yield* fault.value
		}

		const created = yield* ensureOutput(outputDir)

		return yield* Effect.scoped(writeLocked(outputDir, files, created))
	})
