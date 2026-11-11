/**
 * The DbConfig agreement (test/support/agreement/dbconfig.ts), one program the type batch checks disarmed: over the
 * reader's every setting left out and given a stranger, and every password, verify and driver channel, the types take
 * exactly what DbLayer.make's reader admits, and every type-only contract holds. Oracle: the reader itself
 * (connection/config.ts, pool/served.ts), over the settings its own rosters name.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): api-config-roster.patch adds a pool setting to the reader's roster that
 * the type does not state.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { configSize } from "#test/support/agreement/dbconfig.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the DbConfig agreement", (it) => {
	it.effect(
		`over the reader's every setting left out and given a stranger, and every password, verify and driver channel (${configSize} configs), the types take exactly what DbLayer.make's reader admits and every type-only contract holds`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("api/config")
				assert.deepEqual(actual, expected)
			})
	)
})
