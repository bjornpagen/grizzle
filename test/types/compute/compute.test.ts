import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Situations, unreachedOf } from "@grizzle/testing/features"
import { Array as Arr, Effect } from "effect"
import {
	type ComputeNote,
	computeCount,
	computeInferences,
	computeRefusals,
	computeRequired,
	computeWitnesses
} from "#test/support/agreement/compute.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

/**
 * The Compute type/engine agreement (test/support/agreement/compute.ts), one program the type batch checks disarmed:
 * every drawn term, predicate, aggregate, host value and member read typechecks exactly when the engine builds and
 * compiles it; a refusal the types name by a Refusal names the engine's reason, every other refusal is structural; and an
 * admitted case's term type, SQL type, head and parameters equal the engine's, each asserted exactly.
 *
 * The floor's witnesses, the same in every run, reach every construct admitted and, where the catalogue can refuse it,
 * refused, every Refusal the Compute catalogue names, and every inference the program asserts, so the program is never
 * vacuous on any seed.
 */
const required: Situations<ComputeNote> = [
	"admitted",
	"refused",
	"refused: structurally",
	...computeRefusals,
	...computeInferences,
	...computeRequired
]

layer(NodeServices.layer, { excludeTestServices: true })(
	"the Compute type/engine agreement",
	(it) => {
		it.effect(
			`over ${computeCount} drawn cases and the floor's, the types admit exactly what the engine compiles, name its refusal, and infer its types`,
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("compute/agreement")
					assert.deepEqual(actual, expected)
				})
		)

		it("the floor's witnesses reach every construct under both verdicts, every Refusal and every inference", () => {
			assert.deepEqual(
				unreachedOf(
					required,
					Arr.map(computeWitnesses(), (stratum) => stratum.tally)
				),
				[],
				"situations no floor witness reached"
			)
		})
	}
)
