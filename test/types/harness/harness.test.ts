import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
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
