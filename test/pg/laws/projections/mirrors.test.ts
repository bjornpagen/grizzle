/**
 * Mirrors over selected sides as partial projections: its two containments, each a native foreign key, the pair a
 * cycle and so deferred, so a selected parent without its child, or a child whose parent leaves the selection, is
 * refused by PostgreSQL at COMMIT with 23503, a child that is all key included; generated schemas through grizzle and
 * through a direct SQL writer.
 *
 * For the direct writer, an UPDATE that moves a ticket into a selection, or moves a selected ticket or its follow-up,
 * commits only when the rest of its transaction leaves every follow-up with its selected ticket and every selected
 * ticket with its follow-up, which drawn transactions rarely do; a move into a selection refused at COMMIT is rare too.
 * All three are planted for the mutable ticket's schema, on a German ticket of low priority, which no selection but
 * the one by level reaches: raised to level 3 with its escalation inserted after it, raised to level 3 with no
 * escalation, and, at level 3, moved to another id with its escalation moved after it.
 */

import { Array as Arr, Option } from "effect"
import { plantedUpdate } from "#test/pg/laws/families/direct.ts"
import { variantsOf } from "#test/pg/laws/families/families.ts"
import { directSuite, type Planted } from "#test/pg/laws/families/suites/direct.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"
import { plantedInsert } from "#test/pg/laws/families/support.ts"
import { mirrorShapes, projectedMirrors, tickets } from "#test/pg/laws/projections/families.ts"

familySuite(projectedMirrors, casesPerTest, "the family")
familySuite(mirrorShapes, casesPerTest, "every schema's refusals by every law but a key")

const [p, variant] = Option.getOrThrowWith(
	Arr.findFirstWithIndex(variantsOf(mirrorShapes, "mutable"), (shape) => shape.kind === "signals"),
	() => new Error("no mutable schema of the ticket's mirrors")
)
const host = mirrorShapes.host(p)
const domains = mirrorShapes.domains
const [first, second] = tickets
const ticket = (level: number) =>
	plantedInsert(host, domains, "Ticket", { id: first, level, lang: "de", priority: "low" })
const escalation = plantedInsert(host, domains, "Escalation", { ticket: first })

const planted: Planted = {
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
			draws: "",
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
			draws: "",
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
