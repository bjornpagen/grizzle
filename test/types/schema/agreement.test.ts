/**
 * The schema agreement (test/support/agreement/schemas.ts), one program the type batch checks disarmed: over drawn
 * schemas and probes, the types infer what the engine describes, each field's host, fact and keys, and refuse exactly
 * what it refuses, naming its refusal. Oracle: the engine's description of each drawn schema. The floor's witnesses
 * reach every construct, every fault and every refusal it names.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): schema-own-names.patch admits a relation held under another name.
 */
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
