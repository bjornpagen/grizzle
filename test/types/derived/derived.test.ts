import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

layer(NodeServices.layer, { excludeTestServices: true })("derived relation types", (it) => {
	it.effect("typechecks every fixture under tsgo with Effect diagnostics", () =>
		Effect.gen(function* () {
			const diagnostics = yield* checked("derived/fixtures")
			assert.equal(diagnostics.output, "")
		})
	)

	it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("derived/disarmed")
			assert.deepEqual(actual, expected)
		})
	)
})
