/** What the property of carrier-bound.test.ts reads: its schema, its box and a case's ChangeSet. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema, unit } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"

/** A child's items, the marks a call adds to them and the log it keeps of them, each under the child's unit. */
const Item = relation("Item", { child: pg.integer, n: pg.integer }, ["child", "n"])
const Mark = relation("Mark", { child: pg.integer, n: pg.integer }, ["child", "n"])
const Log = relation("Log", { child: pg.integer, n: pg.integer }, ["child", "n"])

export const Bounded = schema(
	"CarrierBound",
	[Item, Mark, Log],
	[unit("Learner", { child: pg.integer })]
)

/** How far the bound parameter `target` reads: one item, by its key; one child's items, its unit; or every item. */
export type Reach = "one item" | "one child's items" | "every item"

/** What the call reads back after its last stratum: nothing, or the marks it added that it logged, carried there. */
export type ReadBack = "no read-back" | "the marks it added"

export interface BoundCase {
	readonly reach: Reach
	readonly read: ReadBack
}

export const boundGen: Gen<BoundCase> = (source) => ({
	reach: source.draw(element(["one item", "one child's items", "every item"] as const)),
	read: source.draw(element(["no read-back", "the marks it added"] as const))
})

/** The rank the carrier of `target` states (write/carriers CarrierBound): a key's, a unit's, or an unbounded one. */
export const expectedBound = (reach: Reach): "key" | "unit" | "unbounded" =>
	reach === "one item" ? "key" : reach === "one child's items" ? "unit" : "unbounded"

/**
 * The query `target` is bound to: the items at its reach that no mark holds, so it reads Mark, which the first stratum
 * writes, and the second stratum's reader reads another state (write/frontend/compile.ts `agrees`): it is carried.
 */
const targetOf = (reach: Reach): QueryValue =>
	queryOver(Bounded).rule((r: RuleValue) => {
		const item = varsOver(Item, "item")
		const child = reach === "every item" ? item["child"] : r.param("child", pg.integer)
		const n = reach === "one item" ? r.param("n", pg.integer) : item["n"]
		return r.match(Item, { child, n }).where(r.not(Mark, { child, n })).find({ child, n })
	})

/** The facts of the relation parameter `target`, of Item's heading. */
const fromTarget = (): QueryValue =>
	queryOver(Bounded).rule((r: RuleValue) => {
		const target = r.relation("target", { child: pg.integer, n: pg.integer })
		const { child, n } = varsOver(target, "target")
		return r.match(target, { child, n }).find({ child, n })
	})

/**
 * The marks the call added that it logged, delta.added(Mark) joined to Log: the read-back reads Log, which the second
 * stratum writes after the marks' statement, so it runs after the last stratum over the marks' delta carried there
 * (write/schedule/plan.ts placeReadBacks).
 */
const addedMarks =
	() =>
	(d: DeltaValue): QueryValue =>
		queryOver(Bounded).rule((r: RuleValue) => {
			const { child, n } = varsOver(Mark, "mark")
			return r.match(d.added(Mark), { child, n }).match(Log, { child, n }).find({ child, n })
		})

/** The case's ChangeSet: the target's marks, then, sequenced after them, its log; its read-back, if any, last. */
export const changeOf = (c: BoundCase): ChangeSetValue => {
	const logged = ChangeSet.empty(Bounded).insert(Log, fromTarget())
	return ChangeSet.sequence(
		ChangeSet.empty(Bounded).insert(Mark, fromTarget()),
		c.read === "no read-back" ? logged : logged.read("marked", addedMarks())
	).bind({ target: targetOf(c.reach) })
}
