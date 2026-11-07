import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import { accessCount, accessRequired, accessWitnesses } from "#test/support/agreement/access.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the access agreement", (it) => {
	it.effect(
		`over ${accessCount} drawn logins and the floor's, Db.open needs a token, DbLayer.make a verify, a program on a role's Db its contexts and db.refresh its refresh list exactly as the engine reads the role`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("api/access")
				assert.deepEqual(actual, expected)
			})
	)

	it("the floor's witnesses reach every place a role reads a context and every probe under both verdicts", () => {
		assert.deepEqual(
			unreachedOf(accessRequired, [accessWitnesses().tally]),
			[],
			"situations no floor witness reached"
		)
	})
})
