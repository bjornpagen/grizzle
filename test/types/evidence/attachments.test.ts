import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	attachAimed,
	attachCases,
	attachProgram,
	attachRequired,
	transactionFaults
} from "#test/support/agreement/attachments.ts"
/**
 * The attachment agreement (test/support/agreement/attachments.ts): every drawn attachment's stated delivery admitted
 * exactly where the engine proves it from the keys the types read, a closed relation's declared keys and never its facts
 * (declaredDelivery), and an arm exactly where the alternatives law makes it, each refusal under its directive at its
 * argument; where a closed relation's facts make a key its declaration does not, and the engine's one child per parent
 * rests on it, the types state an array and the engine proves more, the types stricter and never looser; and each
 * admitted attachment's records, of a snapshot read and of a read-back, the engine's decoded heading under the delivery
 * stated, a nested attachment's within its child's records. Each attachment is a block of one program a batch checks
 * disarmed. A read-back's delivery is one the engine proves in the transaction context. The witnesses reach every
 * delivery, refusal, proof and shape, a derived parent's and a nested attachment's among them, and a child over no level
 * of its parent's schema, which both refuse.
 */
import { assert } from "#test/support/assert.ts"
import { agreement } from "#test/types/batch/agreement.ts"

/**
 * Over drawn attachments, the types admit a stated delivery exactly as the engine proves it, and infer the engine's
 * records under it.
 */
export const attachments = agreement(attachAimed, {
	situations: attachRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: attachProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's proof of each drawn attachment's delivery"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: '\treadonly one: ChildEv extends { readonly card: "one" }',
			replacement: '\treadonly one: ChildEv extends { readonly card: "atMostOne" | "one" }',
			why: "The one child is admitted where the evidence proves at most one per parent (types/evidence/evidence.ts Claims' one); the agreement's program fails."
		}
	]
})

/** A read-back's delivery of every admitted attachment is one the engine proves in the transaction context. */
export const readBackDelivery = property.explore(attachCases, {
	situations: [],
	needs: {},
	check: () => (c) =>
		Effect.sync(() => {
			assert.deepEqual(
				transactionFaults(c),
				[],
				"read-backs the transaction context does not prove"
			)
		}),
	oracle: {
		kind: "specification",
		name: "a read-back reads only what the engine proves in the transaction context"
	},
	kept: [],
	kills: []
})
