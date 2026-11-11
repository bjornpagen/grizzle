/**
 * schema(...), role(...) and the lookups by name at scale (schema/budget/generate.ts): the statement-scale program at
 * its largest size, beside its twin, the same declarations over the first and the last relation's neighbourhoods and
 * the first generated relation alone, checked by the type batch disarmed.
 *
 * Properties: the program typechecks at scale, a role over every relation and one over a Pick of half of them read as
 * schemas among it; the head of a query over the last relation, the first's and the last's candidate keys, and a
 * generated relation's fact and addition are identical to the twin's; and a statement naming a relation no level
 * declares, a relation under another name and a role's entry of a stranger raise exactly the diagnostics, codes and
 * refusals, they raise over the twin. Oracle: the twin, a program at the smallest scale the probes read.
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
import { largestStatementSize } from "#test/types/schema/budget/generate.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	`the ${largestStatementSize}-relation schema`,
	(it) => {
		it.effect(
			"infers what its twin infers, and refuses what its twin refuses, as its twin refuses it",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("schema/budget")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
