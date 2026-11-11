/**
 * The query facade's surface (test/types/api/surface.ts), one program the type batch checks: the function-valued keys
 * of QueryBuilder, Rule, Finished, Query and Ordered are exactly the methods their runtime values carry, so a method the
 * types promise and the value lacks, and one the value carries and the types hide, fail. Oracle: the runtime values the
 * builders make, their methods read off them.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): api-surface-phantom.patch gives the Ordered type a method no runtime
 * value carries.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

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
