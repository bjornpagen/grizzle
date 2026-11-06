import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Situations, unreachedOf } from "@grizzle/testing/features"
import { Array as Arr, Effect } from "effect"
import { admissionSize } from "#test/support/agreement/admission.ts"
import {
	type AgreementNote,
	agreementCount,
	agreementFaults,
	agreementFeatures,
	agreementPairs,
	agreementWitnesses,
	type FaultNote,
	faultCount,
	faultWitnesses,
	reorderedVerdicts
} from "#test/support/agreement/queries.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { typeRun } from "#test/types/batch/provided.ts"

/**
 * The type/engine agreements, one program the type batch checks:
 *
 * 1. Evidence: the drawn queries (test/support/agreement/queries.ts), the engine's verdict on each stated as types:
 *    each get is written as db.get, under a refusal directive where the engine refuses it, and each query's claimed
 *    keys are asserted to lie over the engine's, its cardinality the engine's, and its records, parameters and reads
 *    the engine's decoded heading and parameters. The batch checks the program disarmed, so it raises exactly its
 *    directives' refusals: a get the types refuse and the engine proves is a diagnostic no directive names, a get the
 *    types accept and the engine refuses is a directive whose refusal never comes, and a claimed key the engine does
 *    not prove, or a record or parameter the engine does not deliver, fails its assertion.
 * 2. Order invariance: the same queries in a second drawn order, as a second module, and every query's head and keys
 *    asserted equal across the two, so TypeScript's evidence never depends on unrelated statements' order.
 * 3. Admission (test/support/agreement/admission.ts): every position a constant stands in against every constant
 *    kind, a self-join's second scope among them, the program admitting exactly what the engine admits.
 * 4. Faults: queries of the same generator, each planting one fault at a site whose drawn value the engine decides; a
 *    query it refuses is stated under the refusal its reason is, at the fault's site, and one it admits as a clean
 *    query is.
 * 5. Filter order: every drawn query's verdict, the engine's, is the same with each rule's filters in the other order,
 *    so a variable two filters fix is fixed to both values, whichever is written first, as the types read it.
 *
 * The floor's witnesses (agreementWitnesses, faultWitnesses), the same in every run, reach every construct the
 * evidence types reason about, a constant in each position, both verdicts, a variable two filters fix, a contract in a
 * head and a self-join whose get the engine proves, which pinnedSelfJoin draws by construction, and every fault
 * refused, each whose site may hold a valid value admitted too, so the program is never vacuous on any seed; the
 * admission matrix holds every position and kind by construction.
 */
const required: Situations<AgreementNote> = [
	...agreementFeatures,
	"get proved",
	"get refused",
	"a key below the heading",
	"a variable two filters fix",
	"a contract in the head",
	...agreementPairs
]

/** The faults whose site may hold a value the engine admits: a valid name, a field of the source, a key, one type. */
const admissible = ["scopeName", "stranger", "unkeyedFold", "unionTypes"] as const

const faultsRequired: Situations<FaultNote> = [
	...Arr.map(agreementFaults, (fault): FaultNote => `${fault} refused`),
	...Arr.map(admissible, (fault): FaultNote => `${fault} admitted`)
]

layer(NodeServices.layer, { excludeTestServices: true })("the type/engine agreement", (it) => {
	it.effect(
		`over ${agreementCount} drawn queries in two orders, ${faultCount} faulted ones and ${admissionSize} admission cells, the types accept a query, its get, its records and its parameters exactly as the engine does, its keys, and every constant exactly where the engine admits it`,
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

	it("the faulted floor's witnesses reach every fault refused, and each whose site may hold a valid value admitted", () => {
		assert.deepEqual(
			unreachedOf(faultsRequired, [faultWitnesses().tally]),
			[],
			"faults no floor witness reached"
		)
	})
})
