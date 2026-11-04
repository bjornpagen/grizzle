import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { typeRun } from "#test/types/batch/provided.ts"
import { containedProgram } from "#test/types/text/contained.ts"

layer(NodeServices.layer, { excludeTestServices: true })("str.regex types", (it) => {
	it.effect("typechecks every fixture under tsgo with Effect diagnostics", () =>
		Effect.gen(function* () {
			const diagnostics = yield* checked("text/fixtures")
			assert.equal(diagnostics.output, "")
		})
	)

	it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("text/disarmed")
			assert.deepEqual(actual, expected)
		})
	)

	it.effect("infers a host type that contains every accepted value", () =>
		Effect.gen(function* () {
			/**
			 * The program the batch checked: the same run draws the same program. It proves nothing of a family that
			 * contributes no member, so every family contributes one from its witnesses, the draws its labels fix.
			 */
			const { families, witnesses } = containedProgram(typeRun().seed)
			const diagnostics = yield* checked("text/contained")
			assert.equal(diagnostics.output, "")
			assert.deepEqual(unreachedOf(families, [witnesses]), [])
		})
	)
})
