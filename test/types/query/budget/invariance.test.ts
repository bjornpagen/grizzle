/**
 * The query facade's inference at scale (query/budget/generate.ts): the growing-schema program at its largest size,
 * beside its twin, the same declarations over the first and the last relation's neighbourhoods alone, checked by the
 * type batch disarmed.
 *
 * Properties: the program typechecks at scale; every parameter, head, evidence and key inferred at the first and the
 * last relation is identical to the twin's; and every refusal probe there, a get of a query not proved at most one row,
 * a parameter of another type and an order by a field one arm lacks, raises exactly the diagnostics, codes and
 * refusals, that it raises over the twin. Oracle: the twin, a program at the smallest scale the probes read.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): scale-keys-past-hundred.patch drops a schema's declared candidate keys
 * once it holds a hundred statements, which the twin never does and the program at scale does.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { largestQuerySize } from "#test/types/query/budget/generate.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	`the ${largestQuerySize}-relation program`,
	(it) => {
		it.effect(
			"infers at its first and last relation what its twin infers, and refuses there what its twin refuses, as its twin refuses it",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("query/budget")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
