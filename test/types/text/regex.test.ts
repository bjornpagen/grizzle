/**
 * str.regex's host types are sound (test/types/text/contained.ts), one program the type batch checks armed: every value
 * ECMAScript accepts of an admitted pattern, drawn from each family's strings and walks of the pattern's own NFA,
 * inhabits `Infer` of its str.regex, and of its str.and with the next pattern, the kept patterns among them; the
 * program has no diagnostic. Oracle: ECMAScript's own matcher. Every family contributes a member from the draws its
 * label fixes, so the program proves something of each on every seed.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): text-host-drops-empty.patch drops the empty string from every inferred
 * host type.
 */
import { unreachedOf } from "@bjornpagen/testing/features"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { typeRun } from "#test/types/batch/provided.ts"
import { containedProgram } from "#test/types/text/contained.ts"

layer(NodeServices.layer, { excludeTestServices: true })("str.regex types", (it) => {
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
