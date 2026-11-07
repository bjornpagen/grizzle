import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Situations, unreachedOf } from "@grizzle/testing/features"
import { Array as Arr, Effect } from "effect"
import {
	type AttachNote,
	attachCount,
	attachRefusals,
	attachWitnesses,
	transactionFaults
} from "#test/support/agreement/attachments.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { typeRun } from "#test/types/batch/provided.ts"

/**
 * The attachment agreement (test/support/agreement/attachments.ts), one program the type batch checks: every drawn
 * attachment's stated delivery admitted exactly where the engine proves it, and an arm exactly where the alternatives
 * law makes it, each refusal under its directive at its argument, and each admitted attachment's records, of a snapshot
 * read and of a read-back, the engine's decoded heading under the delivery stated, a nested attachment's within its
 * child's records. A read-back's delivery is one the engine proves in the transaction context, and the floor's
 * witnesses reach every delivery, refusal, proof and shape, a derived parent's and a nested attachment's among them,
 * and a child over no level of its parent's schema, which both refuse.
 */
const required: Situations<AttachNote> = [
	...Arr.map(attachRefusals, (refusal): AttachNote => `refused: ${refusal}`),
	"array admitted",
	"option admitted",
	"one admitted",
	"arm admitted",
	"one into an ordinary relation",
	"one into a closed relation",
	"one through a composite containment",
	"one by a reflexive count",
	"a self-join parent",
	"a child filter",
	"an ordered child",
	"a child taken once",
	"a child of two rules",
	"a derived parent",
	"a nested attachment admitted",
	"a nested attachment refused",
	"a foreign child refused"
]

layer(NodeServices.layer, { excludeTestServices: true })("the attachment agreement", (it) => {
	it.effect(
		`over ${attachCount} drawn attachments and their witnesses, the types admit a stated delivery exactly as the engine proves it, and infer the engine's records under it`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("evidence/attachments")
				assert.deepEqual(actual, expected)
			})
	)

	it("a read-back's delivery of every admitted attachment is one the engine proves in the transaction context", () => {
		assert.deepEqual(
			transactionFaults(typeRun().seed),
			[],
			"read-backs the transaction context does not prove"
		)
	})

	it("the floor's witnesses reach every delivery, refusal, proof of the one child and shape of child", () => {
		assert.deepEqual(
			unreachedOf(required, [attachWitnesses().tally]),
			[],
			"situations no witness reached"
		)
	})
})
