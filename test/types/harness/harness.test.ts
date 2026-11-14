/**
 * The testing library's type contracts, each a generated program the type batch checks disarmed:
 *
 * - The vocabulary (harness/vocabulary.ts): a required situation, a note, a pair and a kept case's reaches typecheck
 *   exactly when every name they hold is a member of the suite's closed vocabulary, the situations are one at least, a
 *   kept case reaches one at least, and the vocabulary is a union of literals, never string. Oracle: membership in the
 *   drawn vocabulary.
 * - The assertion door (harness/door.ts): assert.equal and assert.deepEqual typecheck exactly when the expected value
 *   conforms to the actual's type, at any depth. Oracle: conformance of a value drawn of the type, with at most one
 *   fault planted.
 *
 * A refusal is stated as the contract states it, `refused`: the probe does not compile, whichever diagnostic the checker
 * elaborates it to. The floor's witnesses reach every fault of both contracts, each at both depths, and their admitted
 * cases, so neither program is vacuous on any seed.
 *
 * Plants (~/.cache/grizzle-release/BR14/plants): harness-open-situations.patch widens a required situation to any
 * string; harness-door-text-number.patch admits a number as assert.deepEqual's expected value where the actual is text.
 */
import { unreachedOf } from "@bjornpagen/testing/features"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { doorRequired, doorWitnesses } from "#test/types/harness/door.ts"
import { vocabularyRequired, vocabularyWitnesses } from "#test/types/harness/vocabulary.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"the test harness's type contracts",
	(it) => {
		it.effect(
			`over drawn vocabularies and the floor's, a required situation, a note, a pair and a kept case's reaches typecheck exactly when every name is of the closed vocabulary`,
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("harness/vocabulary")
					assert.deepEqual(actual, expected)
				})
		)

		it.effect(
			`over drawn types and values and the floor's, assert.equal and assert.deepEqual typecheck exactly when the expected value conforms to the actual's type`,
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("harness/door")
					assert.deepEqual(actual, expected)
				})
		)

		it("the floor's witnesses reach every fault of both contracts and their admitted cases", () => {
			assert.deepEqual(
				[
					...unreachedOf(vocabularyRequired, [vocabularyWitnesses().tally]),
					...unreachedOf(doorRequired, [doorWitnesses().tally])
				],
				[],
				"situations no floor witness reached"
			)
		})
	}
)
