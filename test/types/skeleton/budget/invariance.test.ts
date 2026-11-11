/**
 * Write inference at scale (skeleton/budget/generate.ts): the growing-schema ChangeSet program at its largest size,
 * beside its twin, the same declarations over the first and the last relation's neighbourhoods alone, checked by the
 * type batch disarmed.
 *
 * Properties: the program typechecks at scale, every ChangeSet applied through its workload's handle; the head a
 * contract host reaches, a relation's fact and candidate keys, and the relations a ChangeSet writes, at the first and
 * the last relation, are identical to the twin's; and a ChangeSet in a workload over a role that does not write its
 * relation, and a query's rows inserted into another relation, raise exactly the diagnostics, codes and refusals, they
 * raise over the twin. Oracle: the twin, a program at the smallest scale the probes read.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): scale-key-recursion.patch builds the schema's index of candidate
 * keys by a recursion over the statement tuple, one level per statement, which the twin's few statements survive and
 * the program at scale does not.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { largestSkeletonSize } from "#test/types/skeleton/budget/generate.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	`the ${largestSkeletonSize}-relation ChangeSet program`,
	(it) => {
		it.effect(
			"infers at its first and last relation what its twin infers, and refuses there what its twin refuses, as its twin refuses it",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("skeleton/budget")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
