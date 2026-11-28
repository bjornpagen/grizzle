/**
 * The module a CLI child process loads through the grizzle.config.ts that support.ts writes: that configuration awaits
 * configModule at its top level.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import type { GrizzleConfig } from "#adapter/types/config.ts"
import { specConfig } from "#test/support/pg/cli/support.ts"

/** The configuration of the spec in `dir`, as a grizzle.config.ts awaits it at its top level. */
export const configModule = (dir: string): Promise<GrizzleConfig> =>
	Effect.runPromise(specConfig(dir).pipe(Effect.provide(NodeServices.layer)))
