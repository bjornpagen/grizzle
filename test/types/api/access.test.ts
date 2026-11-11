/**
 * The access agreement (test/support/agreement/access.ts), one program the type batch checks disarmed: over drawn
 * logins and the floor's, Db.open needs a token, DbLayer.make a verify, a workload over a role its contexts, and a
 * refresh member its refresh list, exactly where the engine's reading of the role needs them. Oracle: the engine's
 * reading of each drawn role. The floor's witnesses reach every place a role reads a context and every probe under
 * both verdicts, so the program is never vacuous on any seed.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): api-open-token-optional.patch lets Db.open take no token for a role
 * that reads a context.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import { accessRequired, accessWitnesses } from "#test/support/agreement/access.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the access agreement", (it) => {
	it.effect(
		`over drawn logins and the floor's, Db.open needs a token, DbLayer.make a verify, a workload over a role its contexts and its refresh member its refresh list exactly as the engine reads the role`,
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
