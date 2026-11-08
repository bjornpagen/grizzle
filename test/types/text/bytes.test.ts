import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { bytesProgram } from "#test/support/text/bytes.ts"
import { checked } from "#test/types/batch/batch.ts"
import { typeRun } from "#test/types/batch/provided.ts"

layer(NodeServices.layer, { excludeTestServices: true })("str.bytes types", (it) => {
	it.effect(
		"a text a byte bound refines has its pattern's type, and meets every text its pattern meets",
		() =>
			Effect.gen(function* () {
				/**
				 * The program the batch checked: the same run draws the same program, whose floor cases, which its label
				 * fixes, reach every required situation.
				 */
				const { situations, witnesses } = bytesProgram(typeRun().seed)
				const diagnostics = yield* checked("text/bytes")
				assert.equal(diagnostics.output, "")
				assert.deepEqual(unreachedOf(situations, [witnesses]), [])
			})
	)
})
