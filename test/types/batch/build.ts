import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Stdio, Stream } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { type BuildRequest, buildInto } from "#test/types/batch/batch.ts"
import { groupsFor } from "#test/types/batch/groups.ts"

/**
 * The type-test batch's builder (batch.ts), a process of its own: the type tier's global setup starts it for a run with
 * type tests, so the programs its groups generate, each one long synchronous computation, never hold the event loop of
 * Vitest's process, whose timers start every test process. It reads the run's BuildRequest on stdin, builds the batch
 * of the groups its files own, and writes it into the request's directory, each unit's result to a file of its own
 * (batch.ts batchLayout); a build that fails writes its failure there, so the result reaches every reader.
 */
const build = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const input = yield* Stream.mkString(Stream.decodeText(stdio.stdin))
	const request = trustedJson<BuildRequest>(input)
	yield* buildInto(groupsFor(request.files), request.seed, request.dir)
})

NodeRuntime.runMain(build.pipe(Effect.provide(NodeServices.layer)))
