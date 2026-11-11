/**
 * Tree inserts typed by member types of any depth (test/types/changeset/nesting.ts), one program the type batch checks
 * disarmed: over the exhaustive box of forms, chains of member types, back edges and excess fields, an insert is
 * admitted exactly when no type it declares states a field beyond its nesting's, at whatever depth its types recur, and
 * refused otherwise. Oracle: the box's rule over the types each case declares.
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
	"tree inserts of member types of any depth",
	(it) => {
		it.effect(
			"admits every case whose types state no field beyond their nesting's, at whatever depth they recur, and refuses every other with the refusal its directive names",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("changeset/nesting")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
