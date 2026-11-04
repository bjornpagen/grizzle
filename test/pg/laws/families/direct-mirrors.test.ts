/**
 * A direct SQL writer over generated schemas: conditional mirrors over a composite projection
 * and non-boolean selectors.
 *
 * An UPDATE that moves a ticket into its selection, or moves a selected ticket or its escalation, commits only when the
 * rest of its transaction leaves every escalation with its selected ticket and every selected ticket with its
 * escalation, which drawn transactions rarely do; a move into the selection refused at COMMIT is rare too. All three are
 * planted for a mutable schema whose ticket is selected by its level: a ticket raised to level 3 with its escalation
 * inserted after it, a selected ticket moved to another id with its escalation moved after it, and a ticket raised to
 * level 3 with no escalation.
 */

import { Array as Arr, Option } from "effect"
import { plantedUpdate } from "#test/pg/laws/families/direct.ts"
import { mirrorShapes, variantsOf } from "#test/pg/laws/families/families.ts"
import { directSuite, type Planted } from "#test/pg/laws/families/suites/direct.ts"
import { casesPerTest } from "#test/pg/laws/families/suites/family.ts"
import { plantedInsert } from "#test/pg/laws/families/support.ts"

const variants = variantsOf(mirrorShapes, "mutable")
const [p, levelLeft] = Option.getOrThrowWith(
	Arr.findFirstWithIndex(
		variants,
		(mirror) =>
			mirror.shape.kind === "selector" &&
			mirror.shape.field === "level" &&
			mirror.shape.side === "left"
	),
	() => new Error("no mutable schema whose ticket is selected by its level, on the left")
)
const host = mirrorShapes.host(p)
const domains = mirrorShapes.domains
const ticket = (level: number) =>
	plantedInsert(host, domains, "Ticket", { id: 1, level, lang: "en", priority: "low" })
const escalation = plantedInsert(host, domains, "Escalation", { ticket: 1, note: "a" })

const planted: Planted = {
	immutable: [],
	mutable: [
		{
			note: "a ticket raised to level 3, its escalation inserted after it",
			sketch: {
				variant: levelLeft,
				initial: [[ticket(1)]],
				transactions: [
					{ members: [escalation], updates: [plantedUpdate(host, domains, "Ticket", { level: 3 })] }
				]
			},
			draws: "",
			reaches: ["statement selection of a referring fact", "committed"]
		},
		{
			note: "a ticket raised to level 3 with no escalation",
			sketch: {
				variant: levelLeft,
				initial: [[ticket(1)]],
				transactions: [
					{ members: [], updates: [plantedUpdate(host, domains, "Ticket", { level: 3 })] }
				]
			},
			draws: "",
			reaches: ["statement selection of a referring fact", "refused at COMMIT"]
		},
		{
			note: "a ticket at level 3 moved to another id, its escalation moved after it",
			sketch: {
				variant: levelLeft,
				initial: [[ticket(3), escalation]],
				transactions: [
					{
						members: [],
						updates: [
							plantedUpdate(host, domains, "Ticket", { id: 2 }),
							plantedUpdate(host, domains, "Escalation", { ticket: 2 })
						]
					}
				]
			},
			draws: "",
			reaches: [
				"statement rekey of a referred fact",
				"statement move of a referring fact",
				"committed"
			]
		}
	]
}

directSuite(mirrorShapes, casesPerTest, planted)
