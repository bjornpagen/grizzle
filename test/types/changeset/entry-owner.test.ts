import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { entryOwnerRefused } from "#test/support/families/entry-owner.ts"
import { checked } from "#test/types/batch/groups.ts"
import { entryOwnerTyped } from "#test/types/changeset/entry-owner.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"a family's owner written through a query entry",
	(it) => {
		it.effect(
			"admits every write of a declared role whose fact states no family field, and refuses every other with the refusal its directive names, as the engine does",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("changeset/entry-owner")
					assert.equal(expected.length, Arr.filter(entryOwnerTyped, entryOwnerRefused).length)
					assert.deepEqual(actual, expected)
				})
		)
	}
)
