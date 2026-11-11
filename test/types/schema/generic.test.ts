/**
 * The generic-source agreement (test/support/agreement/generic-sources.ts), one program the type batch checks
 * disarmed: over every statement builder written generic over each shape of its sources, the types admit exactly what
 * the engine compiles over every relation a shared heading may be, name its refusal, and refuse a source whose
 * relations share no heading. Oracle: the engine's compile of the statement over each relation of the shape.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): schema-generic-sides.patch admits two sides whose field types differ.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the generic-source agreement", (it) => {
	it.effect(
		"over every statement builder written generic over each shape of its sources, the types admit exactly what the engine compiles over every relation a shared heading may be, name its refusal, and refuse a source whose relations share no heading",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("schema/generic")
				assert.deepEqual(actual, expected)
			})
	)
})
