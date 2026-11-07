import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the statement-scale schema", (it) => {
	it.effect(
		"typechecks one schema, a full role and a role through Pick over 2,000 relations, with every refusal it names",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("schema/budget")
				assert.deepEqual(actual, expected)
			})
	)
})
