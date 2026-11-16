/**
 * The executor's boundary (test/types/executor/boundary.ts), one program the type batch checks disarmed: over every
 * source a harness has handed baseArtifacts by every door a compiled program passes on its way to a run (a role's, a
 * slice's, a layer's and a bench gate's compiled query's artifacts, and runWrite over runtimeEntry), a probe compiles
 * exactly when an installation stands
 * behind its source, ParamSource `planned` or `recorded`, and is refused for `unserved` written out, the `unserved`
 * constant and a source of any kind; and runWrite takes an entry exactly when a door minted it. Oracle: the box's own
 * source kind, and whether a door minted the entry.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the executor's boundary", (it) => {
	it.effect(
		"over every source by every door to a run, a compiled program reaches the executor exactly when an installation stands behind its source, and runWrite takes exactly a minted entry",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("executor/boundary")
				assert.deepEqual(actual, expected)
			})
	)
})
