/**
 * The recursion agreement (test/support/agreement/recursion.ts), one program the type batch checks disarmed: over drawn
 * recursions and the floor's, the types admit exactly what the engine compiles, name its refusal, and infer its records
 * and parameters. Oracle: the engine's compile of each drawn recursion. The floor's witnesses reach every fault, both
 * declared classes and every admitted shape, so the program is never vacuous on any seed.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): api-recursion-arms.patch admits a recursion with no base arm.
 */
import { unreachedOf } from "@bjornpagen/testing/features"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { recursionRequired, recursionWitnesses } from "#test/support/agreement/recursion.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the recursion agreement", (it) => {
	it.effect(
		`over drawn recursions and the floor's, the types admit exactly what the engine compiles, name its refusal, and infer its records and parameters`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("api/recursion")
				assert.deepEqual(actual, expected)
			})
	)

	it("the floor's witnesses reach every fault, both declared classes and every admitted shape", () => {
		assert.deepEqual(
			unreachedOf(recursionRequired, [recursionWitnesses().tally]),
			[],
			"situations no floor witness reached"
		)
	})
})
