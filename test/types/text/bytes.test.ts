/**
 * str.bytes's types (test/support/text/bytes.ts), one program the type batch checks armed: a text a byte bound refines
 * has its pattern's own type, both ways, and meets every text its pattern meets, as a containment's source and as a
 * key; the program has no diagnostic. Oracle: the pattern-refined text's own type. The floor's cases, which the label
 * fixes, reach every required situation on every seed.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): text-bytes-field.patch types str.bytes as a text field that is no
 * pattern's.
 */
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
