import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { nestingCases, nestingRefused } from "#test/types/changeset/nesting.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"tree inserts of member types of any depth",
	(it) => {
		it.effect(
			"admits every case whose types state no field beyond their nesting's, at whatever depth they recur, and refuses every other with the refusal its directive names",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("changeset/nesting")
					assert.equal(expected.length, Arr.filter(nestingCases, nestingRefused).length)
					assert.deepEqual(actual, expected)
				})
		)
	}
)
