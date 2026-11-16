import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	checkShape,
	type Feature,
	features,
	shapeGen
} from "#test/unit/laws/model/tree.fixtures.ts"

/** A tree's natives are §2.2's: the family on three axes, T0 to T6, and one CHECK every tree with 0 to 2 parent copies, mutable or not. */
export const aTreesNativesAre22sTheFamilyOnThreeAxesT0ToT6AndOneCHECKEveryTreeWith0To2ParentCopiesMutableOrNot =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				c.note(s.mutable ? "a mutable tree" : "an immutable tree")
				if (s.copies.length > 0) {
					c.note("a parent copy")
				}
				if (Arr.contains(s.copies, "accumulated")) {
					c.note("an accumulated parent copy")
				}
				if (s.copies.length > 1) {
					c.note("two copies")
				}
				if (s.fold) {
					c.note("a fold over the tree")
				}
				checkShape(s)
			}),
		oracle: {
			kind: "specification",
			name: "trees.md's T0 to T6 and w4-w7 §2.2's table as a checker"
		},
		box: "every tree with 0 to 2 parent copies, mutable or not, with a count fold or none; its CHECK on 4,096 rows",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\t\town.add(or([cmp("gt", start, zero), cmp("eq", at, zero)]))\n',
				replacement: "",
				why: "The root pin, start > 0 or at = 0, is left out of the tree's CHECK (laws/model/plan.ts treeConditions), so a root off slot 0 is accepted; the CHECK's verdicts fail."
			}
		]
	})
