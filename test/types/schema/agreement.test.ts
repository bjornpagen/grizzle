import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import { schemaRequired, schemaWitnesses } from "#test/support/agreement/schemas.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the schema agreement", (it) => {
	it.effect(
		"over drawn schemas and probes, the types infer what the engine describes and refuse exactly what it refuses",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("schema/agreement")
				assert.deepEqual(actual, expected)
			})
	)

	it("the floor's witnesses reach every construct, every fault and every refusal it names", () => {
		assert.deepEqual(
			unreachedOf(schemaRequired, [schemaWitnesses().tally]),
			[],
			"constructs, faults or refusals no floor witness reached"
		)
	})
})
