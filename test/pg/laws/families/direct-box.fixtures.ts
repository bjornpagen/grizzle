/** What the properties of direct-box.test.ts read: the cases it plants for its direct suite. */
import { Array as Arr, Option } from "effect"
import { variantsOf } from "#test/support/laws/boxes.ts"
import { plantedUpdate } from "#test/support/laws/direct.ts"
import { directLawBox } from "#test/support/laws/generated.ts"
import type { Planted } from "#test/support/laws/suites/direct.ts"
import { plantedInsert } from "#test/support/laws/support.ts"

const variants = variantsOf(directLawBox, "mutable")
const [p, variant] = Object.freeze(
	Option.getOrThrowWith(
		Arr.findFirstWithIndex(variants, (box) =>
			Arr.every(["family containment", "key int2", "selector boolean"], (t) =>
				box.point.traits.includes(t)
			)
		),
		() => new Error("no mutable box point whose child a boolean selects")
	)
)
const host = directLawBox.host(p)
const domains = directLawBox.domains
const fields = Object.freeze({ level: 1, lang: "en", stage: "draft" })
const child = plantedInsert(host, domains, "Child", { id: 1, flag: false, parent: 1, ...fields })
const parent = plantedInsert(host, domains, "Parent", { id: 1, flag: false, note: 1, ...fields })
const selected = plantedUpdate(host, domains, "Child", { flag: true })

export const planted: Planted = {
	immutable: [],
	mutable: [
		{
			note: "an unselected child whose parent is missing selected",
			sketch: {
				variant,
				initial: [[child]],
				transactions: [{ members: [], updates: [selected] }]
			},
			reaches: ["statement selection of a referring fact", "refused at COMMIT"]
		},
		{
			note: "an unselected child selected, its parent inserted after it",
			sketch: {
				variant,
				initial: [[child]],
				transactions: [{ members: [parent], updates: [selected] }]
			},
			reaches: ["statement selection of a referring fact", "committed"]
		}
	]
}
