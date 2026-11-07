import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

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
