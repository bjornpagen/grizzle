import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the query facade's surface", (it) => {
	it.effect(
		"the methods of QueryBuilder, Rule, Finished, Query and Ordered are exactly the methods their runtime values carry",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("api/surface")
				assert.deepEqual(actual, expected)
			})
	)
})
