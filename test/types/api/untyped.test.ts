import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#test/support/assert.ts"
import { refusedAt, untypedCases } from "#test/types/api/untyped.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"a builder's list or record holding a member typed any",
	(it) => {
		it.effect(
			"over every builder by every typing of the lists and records it captures, and the Object.values leak, refuses exactly the calls holding a member typed any, at the first argument that holds one, and admits every other with a schema's nestings kept",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("api/untyped")
					assert.equal(
						expected.length,
						Arr.filter(untypedCases, (c) => Option.isSome(refusedAt(c))).length
					)
					assert.deepEqual(actual, expected)
				})
		)
	}
)
