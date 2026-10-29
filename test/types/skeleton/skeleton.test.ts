import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the largest generated schema", (it) => {
	it.effect(
		"keeps every refusal of the largest generated schema, with the diagnostic it names",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("skeleton/budget")
				assert.deepEqual(actual, expected)
			})
	)
})

layer(NodeServices.layer, { excludeTestServices: true })("declare-only type skeleton", (it) => {
	it.effect("typechecks every fixture under tsgo with Effect diagnostics", () =>
		Effect.gen(function* () {
			assert.equal((yield* checked("skeleton/fixtures")).output, "")
		})
	)

	it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("skeleton/disarmed")
			assert.deepEqual(actual, expected)
		})
	)
})
