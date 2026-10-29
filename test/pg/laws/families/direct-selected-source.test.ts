/**
 * A direct SQL writer over generated schemas: selected-source containment over a composite text and uuid anchor and into its own relation.
 *
 * An UPDATE that moves a node into its selection or moves a selected node's parent is refused at COMMIT only when the
 * parent it then needs is missing, and an UPDATE of a key commits only when nothing selected refers to it, which drawn
 * transactions reach a few times a run. All three are planted for a mutable schema whose node is selected when live: an
 * unselected node whose parent is missing made live, a live node's parent moved to a missing node, and an unselected
 * node moved to another id.
 */

import { Array as Arr, Option } from "effect"
import { plantedUpdate } from "#test/pg/laws/families/direct.ts"
import { sourceShapes } from "#test/pg/laws/families/families.ts"
import { directSuite, type Planted } from "#test/pg/laws/families/suites/direct.ts"
import { casesPerTest } from "#test/pg/laws/families/suites/family.ts"
import { plantedInsert } from "#test/pg/laws/families/support.ts"

const variants = sourceShapes.variants(true)
const [p, variant] = Option.getOrThrowWith(
	Arr.findFirstWithIndex(variants, (source) => source.shape.kind === "self" && source.shape.live),
	() => new Error("no mutable schema whose node is selected when live")
)
const host = sourceShapes.host(p)
const domains = sourceShapes.domains
const node = (parent: number, live: boolean) =>
	plantedInsert(host, domains, "Node", { id: 1, parent, live })

const planted: Planted = {
	immutable: [],
	mutable: [
		{
			note: "an unselected node whose parent is missing made live",
			sketch: {
				variant,
				initial: [[node(2, false)]],
				transactions: [
					{ members: [], updates: [plantedUpdate(host, domains, "Node", { live: true })] }
				]
			},
			draws: "",
			reaches: ["statement selection of a referring fact", "refused at COMMIT"]
		},
		{
			note: "a live node, its own parent, moved to a missing parent",
			sketch: {
				variant,
				initial: [[node(1, true)]],
				transactions: [
					{ members: [], updates: [plantedUpdate(host, domains, "Node", { parent: 3 })] }
				]
			},
			draws: "",
			reaches: ["statement move of a referring fact", "refused at COMMIT"]
		},
		{
			note: "an unselected node, its own parent, moved to another id",
			sketch: {
				variant,
				initial: [[node(1, false)]],
				transactions: [{ members: [], updates: [plantedUpdate(host, domains, "Node", { id: 2 })] }]
			},
			draws: "",
			reaches: ["statement update key", "committed"]
		}
	]
}

directSuite(sourceShapes, casesPerTest, planted)
