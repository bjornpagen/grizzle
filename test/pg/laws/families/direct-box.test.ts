/**
 * A direct SQL writer over the law-family box (generated.ts directLawBox): SERIALIZABLE transactions commit iff their
 * final state is lawful, each refusal raised where its law is checked, under the constraint the host's law names, a
 * native law's identity naming its constraint's table and name, and a residual law's DETAIL naming a violator by the
 * host's witness rule.
 *
 * An UPDATE that moves a fact into a referring side's selection meets a box point with a selected referring side in a
 * few of its draws, so such an UPDATE refused at COMMIT, and one in a transaction that commits, are reached a few times
 * a run, once at times. Both are planted for the mutable point whose child a boolean selects: an unselected child whose
 * parent is missing selected, and the same child selected with its parent inserted after it.
 */

import { Array as Arr, Option } from "effect"
import { plantedUpdate } from "#test/pg/laws/families/direct.ts"
import { variantsOf } from "#test/pg/laws/families/families.ts"
import { directLawBox } from "#test/pg/laws/families/generated.ts"
import { directSuite, type Planted } from "#test/pg/laws/families/suites/direct.ts"
import { casesPerTest } from "#test/pg/laws/families/suites/family.ts"
import { plantedInsert } from "#test/pg/laws/families/support.ts"

const variants = variantsOf(directLawBox, "mutable")
const [p, variant] = Option.getOrThrowWith(
	Arr.findFirstWithIndex(variants, (box) =>
		Arr.every(["family containment", "key int2", "selector boolean"], (t) =>
			box.point.traits.includes(t)
		)
	),
	() => new Error("no mutable box point whose child a boolean selects")
)
const host = directLawBox.host(p)
const domains = directLawBox.domains
const fields = { level: 1, lang: "en", stage: "draft" }
const child = plantedInsert(host, domains, "Child", { id: 1, flag: false, parent: 1, ...fields })
const parent = plantedInsert(host, domains, "Parent", { id: 1, flag: false, note: 1, ...fields })
const selected = plantedUpdate(host, domains, "Child", { flag: true })

const planted: Planted = {
	immutable: [],
	mutable: [
		{
			note: "an unselected child whose parent is missing selected",
			sketch: {
				variant,
				initial: [[child]],
				transactions: [{ members: [], updates: [selected] }]
			},
			draws: "",
			reaches: ["statement selection of a referring fact", "refused at COMMIT"]
		},
		{
			note: "an unselected child selected, its parent inserted after it",
			sketch: {
				variant,
				initial: [[child]],
				transactions: [{ members: [parent], updates: [selected] }]
			},
			draws: "",
			reaches: ["statement selection of a referring fact", "committed"]
		}
	]
}

directSuite(directLawBox, casesPerTest, planted)
