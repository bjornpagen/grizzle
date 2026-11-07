import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { largestQuerySize, refusalCount } from "#test/types/query/budget/generate.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the 200-relation program", (it) => {
	it.effect("keeps every refusal of the 200-relation program, with the diagnostic it names", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("query/budget")
			assert.equal(expected.length, refusalCount(largestQuerySize))
			assert.deepEqual(actual, expected)
		})
	)
})
