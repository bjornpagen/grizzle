/**
 * Families, trees, folds and nested additions at scale (schema/budget/families.ts).
 *
 * Properties:
 * - Cost: the family-scale program, checked alone at three family counts an equal step apart, each step a whole number
 *   of its period, typechecks with no diagnostic, every relation a ChangeSet inserts at its top level inserted at once
 *   from the rows grizzle types (a round trip), and its types and instantiations grow no faster than linearly, exactly
 *   (test/support/growth.ts incrementsDoNotGrow): the second step adds no more than the first. Oracle: the compiler's
 *   own counts, compared step against step.
 * - Invariance: at the largest size, beside its twin, the same declarations over the first and the last unit of each
 *   kind alone, checked by the type batch disarmed, every unit's additions, the relations a ChangeSet inserts at its
 *   top level and the rows insertAll takes of them are identical to the twin's; and an ordered member written alone and
 *   a counted member nested under its owner raise exactly the diagnostics, codes and refusals, they raise over the
 *   twin. Oracle: the twin.
 *
 * Plants (~/.cache/grizzle-release/BR14/plants): families-scale-walk.patch finds a key's immutable owners by a pass
 * over every family of the schema for each key, a cost per key that grows with the families;
 * scale-owners-past-hundred.patch drops a schema's index of family owners once it holds a hundred statements, which the
 * twin never does and the program at scale does.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { assertClean, assertGrowthLaw, measuredSizes } from "#test/types/batch/measured.ts"
import {
	familySizes,
	generateFamiliesSource,
	largestFamilies
} from "#test/types/schema/budget/families.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the family-scale schema", (it) => {
	it.effect(
		`typechecks ${Arr.join(
			Arr.map(familySizes.sizes, (n) => `${n}`),
			", "
		)} families and as many folds, nested two deep and with trees, with no diagnostic, its types and instantiations growing no faster than linearly`,
		() =>
			Effect.gen(function* () {
				const sizes = yield* measuredSizes("test/types/schema", familySizes, generateFamiliesSource)
				for (const s of sizes) {
					assertClean(s, "the family-scale schema")
				}
				assertGrowthLaw("the families", familySizes, sizes)
			})
	)

	it.effect(
		`infers at ${largestFamilies} families what its twin infers, and refuses what its twin refuses, as its twin refuses it`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("schema/families")
				assert.deepEqual(actual, expected)
			})
	)
})
