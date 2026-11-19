/** What the properties of plans.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { pipe, Record as Rec, String as Str } from "effect"
import type { Uuid } from "#compiler/public/fields.ts"
import { paged as pagedWorkload } from "#compiler/public/workload.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { pickGen } from "#test/support/pick.ts"
import {
	ascendingTasks,
	descendingTasks,
	priorityDescendingTasks
} from "#test/unit/page/fixtures.ts"
import { Paging } from "#test/unit/page/fixtures.ts"

export const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The paged account, and another whose tasks share the table and its indexes. */
export const pagedAccount = id(0xa)

export const other = id(0xb)

/**
 * The orders: every key descending, every key ascending (one native row comparison each), and priority descending
 * with the id ascending (mixed: the OR expansion).
 */
export const orders = {
	descending: descendingTasks,
	ascending: ascendingTasks,
	mixed: priorityDescendingTasks
} as const

export type Order = keyof typeof orders

type Variant = "start" | "after" | "before"

interface PlanCase {
	readonly order: Order
	readonly variant: Variant
	readonly size: number
	/** The priorities of the paged account's tasks, at least one, and of the other account's. */
	readonly tasks: {
		readonly paged: ReadonlyArray<number>
		readonly other: ReadonlyArray<number>
	}
	/** Which of the paged account's rows, in the order, is the anchor: the last of the window from the start up to it. */
	readonly anchor: number
}

/** A task's priority: few, so tasks tie on it and the id completes the order. */
const priorityGen = int(0, 4)

export const planCaseGen: Gen<PlanCase> = (source) => ({
	order: source.draw(element<Order>(["descending", "ascending", "mixed"])),
	variant: source.draw(element<Variant>(["start", "after", "before"])),
	size: source.draw(int(1, 7)),
	tasks: {
		paged: source.draw(array(priorityGen, { min: 1, max: 16 })),
		other: source.draw(array(priorityGen, { min: 0, max: 16 }))
	},
	anchor: source.draw(pickGen)
})

export type PlanFeature =
	| `${Order} ${Variant}`
	| "a one-direction seek past more rows than its window reads"
	| "a mixed seek past more rows than its window reads"

/**
 * The paged account's rows past the anchor on the seek's side, of `total`, the anchor the `at`th: after it for an after
 * window, before it for a before window, every row of the account for a start window.
 */
export const remainder = (c: PlanCase, total: number, at: number): number =>
	c.variant === "after" ? total - at : c.variant === "before" ? at - 1 : total

/** The paged account, the one every window reads. */
export const params = Object.freeze({ account: pagedAccount })

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const pagingInstall = Object.freeze({
	label: "real",
	programs: Rec.map(orders, (q) => pagedWorkload(q))
})

/** Paging installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const pagingTemplate = fixtureTemplate(import.meta, Paging, pagingInstall)
