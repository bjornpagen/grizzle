/**
 * A served login's decoder type (test/types/api/decoder.ts), one program the type batch checks: over a box of logins,
 * one for each kind of member the decision of a login's live reads reads, ServedLogin<typeof L>["decoder"] is exactly
 * the arm L's real served file holds, NoDecoder for a login that serves no read and DecoderLogin for one that does,
 * which roleNameOf takes with no narrowing, and AnyLogin's is every arm. Oracle: the decoder of each login's served
 * file, compiled as generate compiles it and read off the served value.
 *
 * Plant (~/.cache/grizzle-release/DENAPI/plants): decoder-union.patch types every served login's decoder as the union
 * (ServedDecoder), whatever its login.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("a served login's decoder type", (it) => {
	it.effect(
		"is exactly the arm its login's served file holds, NoDecoder or DecoderLogin, which roleNameOf takes with no narrowing, and every arm for AnyLogin",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("api/decoder")
				assert.deepEqual(actual, expected)
			})
	)
})
