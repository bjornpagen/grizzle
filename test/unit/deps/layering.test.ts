/**
 * The test tiers' layering (CONTRIBUTING.md, "Test layering"; oxlint.config.ts TEST_TIERS, SHARED_BENCH,
 * tierLayering): the root lint refuses a tier's import of another tier's module, a value's and a type's alike, a tier's
 * import of a bench module outside the shared harness, and test/support's import of a tier, and admits a tier's import
 * of bench's shared harness and of test/support. Its probes are written into hidden directories of their places in the
 * checkout (Checkout.dir, so a mutant of oxlint.config.ts is what lints them) and linted there in one run. Oracle: the
 * specification, the layering CONTRIBUTING.md states.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { layeringBoxes, refusalsIn } from "#test/unit/deps/layering.fixtures.ts"

export const theRootLintHoldsTheTestTiersLayering = property.exhaust(layeringBoxes, {
	box: "a tier's value and type import of another tier, a tier's import of a bench module outside the shared harness and of the shared harness, a tier's import of test/support, and test/support's import of a tier, linted at once",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(cases) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const verdicts = yield* refusalsIn(root, cases)
				assert.deepEqual(
					Arr.map(verdicts, ({ layering, refused }) => ({ name: layering.name, refused })),
					Arr.map(cases, (layering) => ({ name: layering.name, refused: layering.refused }))
				)
			}),
	oracle: {
		kind: "specification",
		name: "the layering CONTRIBUTING.md states: a tier imports its own tier and the shared layer alone, and test/support imports no tier"
	},
	kept: [],
	kills: [
		{
			file: "oxlint.config.ts",
			original: 'const TEST_TIERS = ["unit", "pg", "types", "schedules"] as const',
			replacement: 'const TEST_TIERS = ["unit", "types", "schedules"] as const',
			why: "test/pg is no tier of the layering: a unit module's value and type imports of test/pg are admitted; the property fails."
		}
	]
})
