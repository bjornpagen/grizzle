import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import {
	type AgreementNote,
	agreementCases,
	agreementCount,
	agreementFeatures,
	repeatedScope
} from "#test/support/agreement/queries.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { typeRun } from "#test/types/batch/provided.ts"

/**
 * The type/engine agreement (TODO 0b keys, follow-up K): the types accept a get exactly when the engine proves the
 * query at most one row per parameter binding, and every key the types claim lies over a key the engine proves.
 *
 * 1. The run's drawn queries (test/support/agreement/queries.ts), one program with the engine's verdict on each stated
 *    as types: each get is written as db.get, under a refusal directive where the engine refuses it, and each query's
 *    claimed keys are asserted to lie over the engine's. The type-test batch checks the program disarmed, so it raises
 *    exactly its directives' refusals: a get the types refuse and the engine proves is a diagnostic no directive
 *    names, a get the types accept and the engine refuses is a directive whose refusal never comes, and a claimed key
 *    the engine does not prove fails its assertion.
 * 2. Out of scope (repeatedScope): a rule that matches a relation twice, whose two variables of one
 *    origin no type tells apart. The program asserts no get the engine proves of a query with such a rule, and still
 *    asserts every get the engine refuses and every key the types claim.
 * 3. The population reaches every construct the evidence types reason about and both verdicts, so the program is never
 *    vacuous.
 */
const required: ReadonlyArray<AgreementNote> = [
	...agreementFeatures,
	"get proved",
	"get refused",
	"a key below the heading"
]

layer(NodeServices.layer, { excludeTestServices: true })("the type/engine agreement", (it) => {
	it.effect(
		`over ${agreementCount} drawn queries, the types accept a get exactly as the engine proves it, and its keys`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("evidence/agreement")
				assert.deepEqual(actual, expected)
			})
	)

	it(`draws every construct and both verdicts; out of scope: ${repeatedScope}`, () => {
		const cases = agreementCases(typeRun().seed)
		const reached = new Set(Arr.flatMap(cases, (c) => [...c.notes]))
		assert.deepEqual(
			Arr.filter(required, (note) => !reached.has(note)),
			[],
			"constructs or verdicts no drawn query reached"
		)
	})
})
