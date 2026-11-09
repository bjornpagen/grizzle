import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { untypedCases, untypedRefused } from "#test/types/api/untyped.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"a builder's list or record holding a member typed any",
	(it) => {
		it.effect(
			"refuses every call of schema, schema.extend, role, login and workload a list or record of which holds a member typed any, at that argument, with the refusal its directive names, and admits every typed call with its types kept",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("api/untyped")
					assert.equal(expected.length, Arr.filter(untypedCases, untypedRefused).length)
					assert.deepEqual(actual, expected)
				})
		)
	}
)
