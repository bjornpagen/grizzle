import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { runtimeSources } from "#emit/runtime.ts"

/** The generated runtime's sources by path, as the scaffold emits them, read once for the suites that compare them. */
export const runtimeFiles = await Effect.runPromise(
	runtimeSources.pipe(Effect.provide(NodeServices.layer))
)
