import { subscribe, unsubscribe } from "node:diagnostics_channel"
import { EventEmitter } from "node:events"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Option,
	Predicate,
	Schema,
	type Scope,
	String as Str
} from "effect"
import { type createFileSystem, type FileSystemCallbacks, serverFS } from "typescript/fs"
import { API, type Project } from "typescript/sync"
import { DevtoolFailure } from "#shared/devtool.ts"
import { directoryOf } from "#shared/repository.ts"

/**
 * A native compiler session: the API, and the tsgo process behind it. TypeScript's sync API starts tsgo as a child
 * process and reaches it with synchronous reads and writes on its pipes, so Node's event loop never runs while a call
 * waits. When the process ends during a call, the call sees only the end of its pipe ("Unexpected EOF while reading
 * from child process (unknown reason)"): Node learns how the process ended only once its loop has turned and reaped it.
 */
type Native = Readonly<{
	api: API
	/** The tsgo process, as Node's ChildProcess: an EventEmitter that emits "exit" once Node has reaped the process,
	 * and from then on holds its exit code or the name of the signal that killed it, both null until then. superlint
	 * reads those through readers of its own (endOf, pidOf), so it trusts nothing it does not check. */
	process: EventEmitter
}>

/** How a tsgo process ended: the code it exited with, or the signal that killed it. */
type NativeEnd =
	| Readonly<{ kind: "exited"; code: number }>
	| Readonly<{ kind: "killed"; signal: string }>

/** Node publishes every child process it creates on this diagnostics channel, as `{ process }`, while it creates it. */
const CHILD_PROCESS_CHANNEL = "child_process"

const isDevtoolFailure = Schema.is(DevtoolFailure)

/** Starts a session and finds its tsgo process: the one child process the API's constructor creates. */
const startNative = (
	options: Readonly<{ cwd: string; fs?: FileSystemCallbacks }>
): Effect.Effect<Native, DevtoolFailure> =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const created: Array<EventEmitter> = []
			const listener = (message: unknown): void => {
				if (Predicate.hasProperty(message, "process") && message.process instanceof EventEmitter) {
					created.push(message.process)
				}
			}
			subscribe(CHILD_PROCESS_CHANNEL, listener)
			return { created, listener }
		}),
		({ created }) =>
			Effect.gen(function* () {
				const api = yield* Effect.try({
					try: () => new API(options),
					catch: (cause) =>
						DevtoolFailure.make({ detail: "The native TypeScript compiler did not start", cause })
				})
				const [process, ...others] = created
				if (process === undefined || Arr.isReadonlyArrayNonEmpty(others)) {
					yield* Effect.sync(() => {
						api.close()
					})
					return yield* DevtoolFailure.make({
						detail: `The native TypeScript compiler started ${String(created.length)} processes, where its sync API starts one`
					})
				}
				return { api, process }
			}),
		({ listener }) =>
			Effect.sync(() => {
				unsubscribe(CHILD_PROCESS_CHANNEL, listener)
			})
	)

/** How the process ended, once Node has reaped it; undefined while it runs, or before the loop has reaped it. */
const endOf = (process: EventEmitter): NativeEnd | undefined => {
	if (Predicate.hasProperty(process, "signalCode") && Predicate.isString(process.signalCode)) {
		return { kind: "killed", signal: process.signalCode }
	}
	return Predicate.hasProperty(process, "exitCode") && Predicate.isNumber(process.exitCode)
		? { kind: "exited", code: process.exitCode }
		: undefined
}

/** The process's id, for the report; Node sets it once the process has started. */
const pidOf = (process: EventEmitter): string =>
	Predicate.hasProperty(process, "pid") && Predicate.isNumber(process.pid)
		? String(process.pid)
		: "unknown"

/** Waits for the process to be reaped, and answers how it ended. */
const awaitEnd = (process: EventEmitter): Effect.Effect<NativeEnd, DevtoolFailure> =>
	Effect.callback<NativeEnd, DevtoolFailure>((resume) => {
		const settle = (): void => {
			const end = endOf(process)
			resume(
				end === undefined
					? Effect.fail(
							DevtoolFailure.make({
								detail: `tsgo (pid ${pidOf(process)}) exited with neither an exit code nor a signal`
							})
						)
					: Effect.succeed(end)
			)
		}
		if (endOf(process) === undefined) {
			process.once("exit", settle)
			return Effect.sync(() => {
				process.off("exit", settle)
			})
		}
		settle()
		return Effect.void
	})

const endText = (end: NativeEnd): string =>
	end.kind === "killed" ? `was killed by ${end.signal}` : `exited with code ${String(end.code)}`

/** What an end says about where it came from, since superlint stops tsgo only by closing it. */
const endMeaning = (end: NativeEnd): string => {
	if (end.kind === "killed") {
		return `superlint never signals tsgo, so ${end.signal} came from outside it${end.signal === "SIGKILL" ? ": the system reclaiming memory, or a forced stop" : ""}`
	}
	return end.code === 0
		? "tsgo exits with code 0 when SIGINT or SIGTERM reaches it during a call, and superlint sends it neither: under turbo, that is the run cancelling this task, by a SIGINT to its process group, because another task failed, so read that task's error"
		: "tsgo failed on its own, and what it printed above, on the stderr it shares with superlint, says why"
}

/** TypeScript's sync channel reports the end of tsgo's output pipe only in this message's words; a write to the
 * process's closed input fails with EPIPE, and one after the channel has let go of the pipe with EBADF. */
const PIPE_END = "Unexpected EOF while reading from child process"

const CLOSED_PIPE_CODES: ReadonlyArray<string> = ["EPIPE", "EBADF"]

/** Whether a thrown value is the sync channel finding tsgo's pipe closed. */
const isClosedPipe = (thrown: unknown): boolean =>
	(Predicate.hasProperty(thrown, "message") &&
		Predicate.isString(thrown.message) &&
		Str.startsWith(PIPE_END)(thrown.message)) ||
	(Predicate.hasProperty(thrown, "code") &&
		Predicate.isString(thrown.code) &&
		Arr.contains(CLOSED_PIPE_CODES, thrown.code))

/**
 * Closes a session whose work failed, and names the failure's cause when that was the tsgo process ending under it.
 *
 * Node learns that the process has ended only when its event loop reaps it, after the kernel has torn the process
 * down, which for a process of gigabytes comes well after the process closed its pipes. So the end is read off three
 * pieces of evidence, any one of which suffices: the process has been reaped after one turn of the loop; the work
 * failed on tsgo's closed pipe; or closing, which asks the process to release its snapshots, could not reach it. Then
 * superlint waits for Node to report how it ended. A process that shows none of them was running when superlint
 * closed it, so the failure is the work's own and stands as it was.
 */
const failedSession = <E>(
	native: Native,
	cause: Cause.Cause<E>
): Effect.Effect<never, E | DevtoolFailure> =>
	Effect.uninterruptible(
		Effect.gen(function* () {
			yield* Effect.yieldNow
			const reaped = endOf(native.process)
			const closed = yield* Effect.exit(
				Effect.try({
					try: () => native.api.close(),
					catch: (refusal) =>
						DevtoolFailure.make({ detail: "The native compiler did not close", cause: refusal })
				})
			)
			const failure = Option.filter(Cause.findErrorOption(cause), isDevtoolFailure)
			const pipeClosed = Option.exists(failure, (found) => isClosedPipe(found.cause))
			if (reaped === undefined && !pipeClosed && Exit.isSuccess(closed)) {
				return yield* Effect.failCause(cause)
			}
			const end = reaped ?? (yield* awaitEnd(native.process))
			const work = Option.match(failure, {
				onNone: () => "The native compiler's work failed",
				onSome: (found) => found.detail
			})
			return yield* DevtoolFailure.make({
				detail: `${work}: the native TypeScript compiler (tsgo, pid ${pidOf(native.process)}) stopped answering superlint and ${endText(end)}. ${endMeaning(end)}.`,
				cause: Option.match(failure, {
					onNone: () => Cause.squash(cause),
					onSome: (found) => found.cause
				})
			})
		})
	)

/** Closes a session when its scope ends. After a failure the process may have ended already, and closing then fails
 * to release snapshots a gone process no longer holds: that follows from the failure the scope already carries. */
const closeNative = (native: Native, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
	Exit.isSuccess(exit)
		? Effect.sync(() => {
				native.api.close()
			})
		: Effect.ignore(
				Effect.try({
					try: () => native.api.close(),
					catch: (cause) =>
						DevtoolFailure.make({ detail: "The native compiler did not close", cause })
				})
			)

/** Opens one tsconfig project in its own snapshot, read from `fileSystem` when one is given (a full one is
 * total: nothing is read from the host). A config the compiler rejects is a failure. The snapshot is released when
 * the scope succeeds; after a failure, closing the session releases it with its process. */
const openProject = (
	input: Readonly<{ api: API; config: string; fileSystem?: ReturnType<typeof createFileSystem> }>
): Effect.Effect<Project, DevtoolFailure, Scope.Scope> =>
	Effect.gen(function* () {
		const snapshot = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					input.api.createSnapshot({ openProjects: [input.config], fileSystem: input.fileSystem }),
				catch: (cause) =>
					DevtoolFailure.make({ detail: "The native compiler could not build the program", cause })
			}),
			(opened, exit) =>
				Exit.isSuccess(exit)
					? Effect.sync(() => {
							opened[Symbol.dispose]()
						})
					: Effect.void
		)
		const project = snapshot.getConfiguredProject(input.config)
		if (project === undefined) {
			return yield* DevtoolFailure.make({
				detail: `The native compiler did not open ${input.config}`
			})
		}
		const diagnostics = yield* Effect.try({
			try: () => project.program.getConfigFileParsingDiagnostics(),
			catch: (cause) => DevtoolFailure.make({ detail: `${input.config} could not be read`, cause })
		})
		if (Arr.isReadonlyArrayNonEmpty(diagnostics)) {
			return yield* DevtoolFailure.make({
				detail: Arr.join(
					Arr.map(diagnostics, (diagnostic) => diagnostic.text),
					"\n"
				)
			})
		}
		return project
	})

/** The session a tsconfig's program opens in, and the config it opens: the tsconfig itself, or, for files it leaves
 * out, an overlay that extends it and adds them. */
const programSessionOf = (
	input: Readonly<{ config: string; extraFiles: ReadonlyArray<string> }>
): Readonly<{ options: Readonly<{ cwd: string; fs?: FileSystemCallbacks }>; config: string }> => {
	const cwd = directoryOf(input.config)
	if (!Arr.isReadonlyArrayNonEmpty(input.extraFiles)) {
		return { options: { cwd }, config: input.config }
	}
	const overlayConfig = `${cwd}/.overlay.tsconfig.json`
	const overlay = jsonTextOf({ extends: input.config, files: input.extraFiles })
	const fs: FileSystemCallbacks = {
		directoryExists: serverFS.useOS,
		fileExists: (file) => (file === overlayConfig ? true : serverFS.useOS),
		getAccessibleEntries: serverFS.useOS,
		readFile: (file) => (file === overlayConfig ? overlay : serverFS.useOS),
		realpath: serverFS.useOS,
		stat: serverFS.useOS,
		writeFile: serverFS.useOS,
		removeFile: serverFS.useOS
	}
	return { options: { cwd, fs }, config: overlayConfig }
}

/**
 * Runs `use` on a tsconfig's program, in a session of its own that closes when `use` ends. Files the tsconfig leaves
 * out (a scratch file a tool was pointed at) are added through an overlay: a virtual config beside the real one, so its
 * relative paths resolve the same, that extends it and adds the files, so they are checked with the project's real
 * options. A failure while the tsgo process had already ended names how it ended (failedSession), never only the end
 * of its pipe.
 */
export const withProgram = <A, E, R>(
	input: Readonly<{ config: string; extraFiles: ReadonlyArray<string> }>,
	use: (project: Project) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | DevtoolFailure, Exclude<R, Scope.Scope>> =>
	Effect.scoped(
		Effect.gen(function* () {
			const session = programSessionOf(input)
			const native = yield* Effect.acquireRelease(startNative(session.options), closeNative)
			return yield* Effect.flatMap(
				openProject({ api: native.api, config: session.config }),
				use
			).pipe(Effect.catchCause((cause) => failedSession(native, cause)))
		})
	)
