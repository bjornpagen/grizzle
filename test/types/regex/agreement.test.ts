import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { regexRequired, regexWitnesses } from "#test/types/regex/agreement.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the regex agreement", (it) => {
	it.effect(
		"over drawn str.regex calls, the types admit exactly what the engine admits and infer what the oracle states",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("regex/agreement")
				assert.deepEqual(actual, expected)
			})
	)

	it("the floor's witnesses reach every form, verdict, declared class and host claim", () => {
		assert.deepEqual(
			unreachedOf(regexRequired, [regexWitnesses().tally]),
			[],
			"forms, verdicts, classes or claims no floor witness reached"
		)
	})
})
