/**
 * Predicate atoms for access-path extraction (physical/access): every Allen mask's formula but the full mask's yields
 * the span atom on its span field that a GiST index serves; the full mask holds of every pair and lowers to no
 * predicate, so it yields none.
 *
 * Oracle: that specification, exhausted over every mask from 1 to the full one.
 *
 * Features: a partial mask, the full mask.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { allenMaskMax } from "#compiler/core/allen.ts"
import { assert } from "#test/support/assert.ts"
import { allenQuery, filterAtoms } from "#test/unit/workload/atoms.fixtures.ts"

/** What an Allen mask came to: a partial mask, or the full one. */
type Mask = "a partial mask" | "the full mask"

/** Allen masks yield the span atom on their span field, every mask but the full one, exhaustively. */
export const allenMasksYieldTheSpanAtomOnTheirSpanFieldEveryMaskButTheFullOneExhaustively =
	property.exhaust(finite(int(1, allenMaskMax)), {
		box: "every Allen mask from 1 to the full mask",
		needs: {},
		situations: ["a partial mask", "the full mask"] satisfies ReadonlyArray<Reached<Mask>>,
		check: (_, c: Case<Mask>) => (mask) =>
			Effect.sync(() => {
				const full = mask === allenMaskMax
				const spanned = Arr.some(
					filterAtoms(allenQuery(mask)),
					(a) => a.kind === "span" && a.column === "during"
				)
				assert.equal(spanned, !full, `mask ${mask}`)
				c.note(full ? "the full mask" : "a partial mask")
			}),
		oracle: {
			kind: "specification",
			name: "every mask but the full one yields its span atom; the full mask lowers to no predicate"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/access/atoms.ts",
				original: '\t"range_overlaps",\n',
				replacement: "",
				why: "An Allen comparison yields no span atom: range_overlaps is no span operator."
			}
		]
	})
