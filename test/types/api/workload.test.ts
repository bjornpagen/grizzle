import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { unreachedOf } from "@grizzle/testing/features"
import { Effect } from "effect"
import {
	workloadRequired,
	workloadWitnesses
} from "#test/support/agreement/workloads.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the workload agreement", (it) => {
	it.effect(
		`over drawn workloads and the floor's, the types admit exactly what the engine builds, plans and compiles, and keep each program's type`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("api/workload")
				assert.deepEqual(actual, expected)
			})
	)

	it("the floor's witnesses reach every kind of program under both verdicts and every shape of workload", () => {
		assert.deepEqual(
			unreachedOf(workloadRequired, [workloadWitnesses().tally]),
			[],
			"situations no floor witness reached"
		)
	})
})
