import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Situations, unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import { admissionSize } from "#test/support/agreement/admission.ts"
import {
	type AgreementNote,
	agreementCount,
	agreementFeatures,
	agreementPairs,
	agreementWitnesses,
	reorderedVerdicts
} from "#test/support/agreement/queries.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { typeRun } from "#test/types/batch/provided.ts"

/**
 * The type/engine agreements (TODO 0b keys, follow-up K; issue #7 admission), one program the type batch checks:
 *
 * 1. Evidence: the drawn queries (test/support/agreement/queries.ts), the engine's verdict on each stated as types:
 *    each get is written as db.get, under a refusal directive where the engine refuses it, and each query's claimed
 *    keys are asserted to lie over the engine's. The batch checks the program disarmed, so it raises exactly its
 *    directives' refusals: a get the types refuse and the engine proves is a diagnostic no directive names, a get the
 *    types accept and the engine refuses is a directive whose refusal never comes, and a claimed key the engine does
 *    not prove fails its assertion. A constant stands in every term position of the draw, and a rule may match a
 *    relation twice: a self-join's two scopes are named apart, two types, so its get and keys agree as any join's do.
 * 2. Order invariance: the same queries in a second drawn order, as a second module, and every query's head and keys
 *    asserted equal across the two, so TypeScript's evidence never depends on unrelated statements' order.
 * 3. Admission (test/support/agreement/admission.ts): every position a constant stands in against every constant
 *    kind, a self-join's second scope among them, the program admitting exactly what the engine admits.
 * 4. Filter order: every drawn query's verdict, the engine's, is the same with each rule's filters in the other order,
 *    so a variable two filters fix is fixed to both values, whichever is written first, as the types read it.
 *
 * The floor's witnesses (agreementWitnesses), the same in every run, reach every construct the evidence types reason
 * about, a constant in each position, both verdicts, a variable two filters fix and a self-join whose get the engine
 * proves, which pinnedSelfJoin draws by construction, so the program is never vacuous on any seed; the admission matrix
 * holds every position and kind by construction.
 */
const required: Situations<AgreementNote> = [
	...agreementFeatures,
	"get proved",
	"get refused",
	"a key below the heading",
	"a variable two filters fix",
	...agreementPairs
]

layer(NodeServices.layer, { excludeTestServices: true })("the type/engine agreement", (it) => {
	it.effect(
		`over ${agreementCount} drawn queries in two orders and ${admissionSize} admission cells, the types accept a get exactly as the engine proves it, its keys, and every constant exactly where the engine admits it`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("evidence/agreement")
				assert.deepEqual(actual, expected)
			})
	)

	it(`over ${agreementCount} drawn queries, the engine's verdict is the same with each rule's filters in the other order`, () => {
		assert.deepEqual(reorderedVerdicts(typeRun().seed), [], "verdicts the filters' order moves")
	})

	it("the floor's witnesses reach every construct, both verdicts and a proved self-join", () => {
		assert.deepEqual(
			unreachedOf(required, [agreementWitnesses().tally]),
			[],
			"constructs or verdicts no floor witness reached"
		)
	})
})
