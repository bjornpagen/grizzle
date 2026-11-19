/**
 * Copies along one axis drawn by one drawing, drafted with no database: a migration adds one to three copies to a
 * counted family's owner axis, an ordered family's or a tree's parent axis over stored rows, a tree's copies each a
 * caller field's or a copy's before it. The oracle is the copies' own layers: those that read no copy among them are one
 * layer, a copy of a copy of layer k is of layer k + 1, and the backfill's UPDATE of their table holds one drawing a
 * layer, each one sorted stream of the axis's rows carrying every copy of its layer, where it held one a copy.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DrawingsFeature,
	drawingsCaseGen,
	judge,
	notesOf,
	shapes
} from "#test/unit/deploy/copy-drawings.fixtures.ts"

/** Copies along one axis cost one drawing a layer: K copies that read no copy among them one drawing of the axis's rows, a chain one a link. */
export const copiesAlongOneAxisCostOneDrawingALayer = property.explore(drawingsCaseGen, {
	needs: {},
	budget: { runs: 60, steered: 30 },
	situations: [
		...shapes,
		"one copy",
		"several copies of one layer",
		"a chain"
	] satisfies ReadonlyArray<Reached<DrawingsFeature>>,
	check: (_, c: Case<DrawingsFeature>) => (drawingsCase) =>
		Effect.sync(() => {
			c.noteAll(notesOf(drawingsCase))
			judge(drawingsCase)
		}),
	oracle: {
		kind: "specification",
		name: "the copies' layers: a copy that reads no copy among them is of the first, a copy of a copy of the layer after it"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original: "\t\tfor (const layer of copyLayers(drawn)) {",
			replacement: "\t\tfor (const layer of drawn.map((c): NonEmptyReadonlyArray<Copy> => [c])) {",
			why: "One drawing a copy (the old backfillOf): K copies along one axis read and sort the axis's rows K times; the property fails."
		}
	]
})
