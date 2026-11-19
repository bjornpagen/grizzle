/** What the properties of mirrors.test.ts read: the cases it plants for its direct suite. */
import { Array as Arr, Option } from "effect"
import { mirrorShapes, tickets } from "#test/pg/laws/projections/families.ts"
import { variantsOf } from "#test/support/laws/boxes.ts"
import { plantedUpdate } from "#test/support/laws/direct.ts"
import type { Planted } from "#test/support/laws/suites/direct.ts"
import { plantedInsert } from "#test/support/laws/support.ts"

const [p, variant] = Object.freeze(
	Option.getOrThrowWith(
		Arr.findFirstWithIndex(
			variantsOf(mirrorShapes, "mutable"),
			(shape) => shape.kind === "signals"
		),
		() => new Error("no mutable schema of the ticket's mirrors")
	)
)
const host = mirrorShapes.host(p)
const domains = mirrorShapes.domains
const [first, second] = tickets
const ticket = (level: number) =>
	plantedInsert(host, domains, "Ticket", { id: first, level, lang: "de", priority: "low" })
const escalation = plantedInsert(host, domains, "Escalation", { ticket: first })

export const planted: Planted = {
	immutable: [],
	mutable: [
		{
			note: "a ticket raised to level 3, its escalation inserted after it",
			sketch: {
				variant,
				initial: [[ticket(1)]],
				transactions: [
					{ members: [escalation], updates: [plantedUpdate(host, domains, "Ticket", { level: 3 })] }
				]
			},
			reaches: ["statement selection of a referring fact", "committed"]
		},
		{
			note: "a ticket raised to level 3 with no escalation",
			sketch: {
				variant,
				initial: [[ticket(1)]],
				transactions: [
					{ members: [], updates: [plantedUpdate(host, domains, "Ticket", { level: 3 })] }
				]
			},
			reaches: ["statement selection of a referring fact", "refused at COMMIT"]
		},
		{
			note: "a ticket at level 3 moved to another id, its escalation moved after it",
			sketch: {
				variant,
				initial: [[ticket(3), escalation]],
				transactions: [
					{
						members: [],
						updates: [
							plantedUpdate(host, domains, "Ticket", { id: second }),
							plantedUpdate(host, domains, "Escalation", { ticket: second })
						]
					}
				]
			},
			reaches: [
				"statement rekey of a referred fact",
				"statement move of a referring fact",
				"committed"
			]
		}
	]
}
