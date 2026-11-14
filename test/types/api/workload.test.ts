/**
 * The workload agreement (test/support/agreement/workloads.ts), one program the type batch checks disarmed: over drawn
 * workloads and the floor's, the types admit exactly what the engine builds, plans and compiles, and keep each
 * program's type. Oracle: the engine's build, plan and compile of each drawn workload. The floor's witnesses reach every
 * kind of program under both verdicts and every shape of workload, so the program is never vacuous on any seed.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): api-workload-paged.patch lets paged take a query no orderBy made.
 */
import { unreachedOf } from "@bjornpagen/testing/features"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { workloadRequired, workloadWitnesses } from "#test/support/agreement/workloads.ts"
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
