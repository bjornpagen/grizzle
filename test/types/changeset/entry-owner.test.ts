/**
 * A family's owner written through a query entry (test/types/changeset/entry-owner.ts), one program the type batch
 * checks disarmed: over every declared case of the entry-owner box (test/support/families/entry-owner.ts), a write
 * through the entry is admitted exactly when its fact states no family field, and refused otherwise with the refusal
 * the engine names. Oracle: the box's rule, which the engine meets (test/unit/write/entry-owner.test.ts).
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): changeset-member-unfit.patch admits a member fact that is no fact of its
 * relation.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"a family's owner written through a query entry",
	(it) => {
		it.effect(
			"admits every write of a declared role whose fact states no family field, and refuses every other with the refusal its directive names, as the engine does",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("changeset/entry-owner")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
