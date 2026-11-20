/**
 * Compute.floatBits, a float's identity image (scalar/compute/registry.ts floatBitsOf), on PostgreSQL 19 in the
 * ledger's shape (float-bits.fixtures.ts): a multiple's bag keyed by its variable and its value's image, written beside
 * the value and held to `Compute.floatBits(value)` by a check, with a count; and a tally whose image is a generated
 * column under a key, referencing the bag over (variable, image).
 *
 * - One transaction writes a multiple's values, one row per value by identity with its count, each `bits` the exported
 *   host function's `floatBits(value)`: every insert is accepted, the check holding, so the host and PostgreSQL agree on
 *   every drawn double, subnormals and the specials among them, and a value written with another's image is refused
 *   by the check (23514); -0 and 0 two rows and every NaN one, each row's image the host's and its count the model's. A read
 *   by the image finds exactly its row, under an index scan and under a sequential one, and a read by `=` on the value
 *   finds every row `=` holds equal. A tally is accepted exactly where the bag holds its value's identity, so a tally of
 *   -0 is refused where the bag holds 0 alone.
 *
 * Oracle: IEEE 754's encoding of each value, NaN's one form, and the multiset model of the bag.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	bagTemplate,
	type BitsFeature,
	drawnGen,
	runBag
} from "#test/pg/compute/float-bits.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A bag keyed by a float's identity image holds -0 and 0 as two rows and every NaN as one, its counts the model's, read
 * alike by index and by scan, and a reference over the image meets only its own value.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aBagKeyedByAFloatsIdentityImageHoldsBothZerosAsTwoRowsAndEveryNaNAsOneUnderEveryPlan =
	property.explore(drawnGen, {
		needs: { substrate: Substrate.rolledBack(bagTemplate) },
		situations: [
			"both zeros held, two rows",
			"a value written with another's image refused",
			"a subnormal held",
			"a NaN held",
			"an infinity held",
			"a tally of -0 refused where only 0 is held",
			"a tally accepted",
			"read by index",
			"read by a scan"
		] satisfies ReadonlyArray<BitsFeature>,
		check:
			({ substrate }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* substrate
					yield* runBag(value, connection, drawn, c)
				}),
		oracle: {
			kind: "specification",
			name: "IEEE 754's encoding of each value with NaN in one form, and the multiset model of the bag"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original:
					'\tconst encoded = call("encode", [call("float8send", [double]), lit.text("hex", types.text)])',
				replacement:
					'\tconst encoded = call("encode", [call("float8send", [binary("+", double, lit.float(0, types.double))]), lit.text("hex", types.text)])',
				why: "The image is computed over x + 0, which folds -0 into 0, so a bag holding both zeros collides on its key."
			},
			{
				file: "packages/engine/src/scalar/compute/float.ts",
				original: "\tview.setFloat64(0, value)",
				replacement: "\tview.setFloat64(0, value, true)",
				why: "The host writes the double little-endian and reads it big-endian, so its image is the bytes reversed, which the law refuses beside the value."
			}
		]
	})
