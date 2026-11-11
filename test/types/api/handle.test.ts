/**
 * A served member's handle under any login (test/types/api/handle.ts), one program the type batch checks: over
 * the box of every kind of served program, two programs of distinct types each, both served to a role of their level
 * and to a role of a level that extends it, a function over MemberHandle<typeof p> admits exactly the handles of p,
 * off either role's Db, and refuses the other program's. Oracle: the box's own pairing of each handle with its program.
 *
 * Plant (~/.cache/grizzle-release/EXPLAIN/plants): member-handle-role-phantom.patch leaves a role on MemberHandle.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"a served member's handle under any login",
	(it) => {
		it.effect(
			"over every kind of served program, a function over MemberHandle<typeof p> admits exactly p's handles off a role of its level and of an extension, and refuses another program's",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("api/handle")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
