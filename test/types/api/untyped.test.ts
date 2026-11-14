/**
 * A builder's list or record holding a member typed any (test/types/api/untyped.ts), one program the type batch checks
 * disarmed: over the box of every builder that captures a list or a record, by every typing of what it captures, and
 * the kept Object.values leak, a call is refused exactly when a list or record it captures holds a member typed any, at
 * the first argument that holds one, and every other call is admitted with a schema's nestings kept. Oracle: the box's
 * own typing of each captured list and record.
 *
 * Plant (~/.cache/grizzle-release/TYPEREGRESS/plants): api-untyped-admitted.patch admits a member typed any
 * (types/core/phantom.ts MembersTyped answers unknown for it).
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"a builder's list or record holding a member typed any",
	(it) => {
		it.effect(
			"over every builder by every typing of the lists and records it captures, and the Object.values leak, refuses exactly the calls holding a member typed any, at the first argument that holds one, and admits every other with a schema's nestings kept",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("api/untyped")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
