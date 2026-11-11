import { Effect, Stream } from "effect"
import { type ChildProcess, ChildProcessSpawner } from "effect/process"

/** What a process left once it exited: its exit code and every byte it wrote to stdout and stderr. */
export type Finished = Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>

/**
 * Runs a command to its exit, reading stdout and stderr whole while it runs so a full pipe never blocks it. A process a
 * signal ended fails as the spawner's PlatformError. Interrupting the run kills the command's process group.
 */
export const finished = Effect.fn("support.finished")(function* (command: ChildProcess.Command) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(command)
	const [stdout, stderr, exitCode] = yield* Effect.all(
		[Stream.mkUint8Array(handle.stdout), Stream.mkUint8Array(handle.stderr), handle.exitCode],
		{ concurrency: "unbounded" }
	)
	return { exitCode, stdout, stderr }
}, Effect.scoped)
