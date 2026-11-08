import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Stdio, Stream } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { type BuildRequest, builtText } from "#test/types/batch/batch.ts"
import { groupsFor } from "#test/types/batch/groups.ts"

/**
 * The type-test batch's builder (batch.ts), a process of its own: the type tier's global setup starts it for a run with
 * type tests, so the programs its groups generate, each one long synchronous computation, never hold the event loop of
 * Vitest's process, whose timers start every test process. It reads the run's BuildRequest on stdin, builds the batch
 * of the groups its files own, and prints the result as JSON on stdout; a build that fails prints its failure, so the
 * result reaches every reader.
 */
const build = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const input = yield* Stream.mkString(Stream.decodeText(stdio.stdin))
	const request = trustedJson<BuildRequest>(input)
	const text = yield* builtText(groupsFor(request.files), request.seed)
	yield* Stream.run(Stream.make(text), stdio.stdout())
})

NodeRuntime.runMain(build.pipe(Effect.provide(NodeServices.layer)))
