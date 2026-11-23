/** What the property of bound-once.test.ts reads: its schema and template, its space, a case's ChangeSet and its model. */

import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/** The items, the marks the call adds to them, and the log it keeps of them, each keyed by its id. */
export const Item = relation("Item", { id: pg.integer }, ["id"])
export const Mark = relation("Mark", { id: pg.integer }, ["id"])
export const Log = relation("Log", { id: pg.integer }, ["id"])

export const Once = schema("BoundOnce", [Item, Mark, Log], [])

/** What every case installs: the schema, its login's workload empty, each case loading the ChangeSet it draws. */
export const onceInstall = { label: "boundonce", programs: {} } as const

/** The schema installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const onceTemplate = fixtureTemplate(import.meta, Once, onceInstall)

/** The ids a case's items and marks are drawn from. */
const ids: ReadonlyArray<number> = [1, 2, 3, 4]

/** What the call's first stratum marks: the target's items, so it reads the bound parameter, or every item. */
export type Marked = "the target" | "every item"

/** Where the call logs the target: in its first stratum, in a second one sequenced after it, or nowhere. */
export type Logged = "in the first stratum" | "in a second stratum" | "nowhere"

/** The read-back of the target, `picked`: none, the target alone, or the target's items the change marked, which rides
 * the statement that makes delta.added(Mark). */
export type Read = "no read-back" | "the target alone" | "the target's marked items"

/** Where `target` is bound: once on the whole ChangeSet, or by each sequenced part that reads it, on its own. */
export type Bound = "on the whole" | "on each part"

export interface OnceCase {
	readonly items: ReadonlyArray<number>
	readonly marks: ReadonlyArray<number>
	readonly marked: Marked
	readonly logged: Logged
	readonly read: Read
	readonly bound: Bound
}

/**
 * A case: the stored items and marks, each a subset of 1..4, the target the items no mark holds; how its first stratum
 * marks, where it logs the target, its read-back and where it binds `target`. A ChangeSet that reads `target` nowhere
 * binds nothing it can name, so such a draw marks the target.
 */
export const onceGen: Gen<OnceCase> = (source) => {
	const items = source.draw(subset(ids, { min: 1, max: 4 }))
	const marks = source.draw(subset(ids, { min: 0, max: 3 }))
	const drawn = source.draw(element(["the target", "every item"] as const))
	const logged = source.draw(
		element(["in the first stratum", "in a second stratum", "nowhere"] as const)
	)
	const read = source.draw(
		element(["no read-back", "the target alone", "the target's marked items"] as const)
	)
	const bound = source.draw(element(["on the whole", "on each part"] as const))
	const unread = logged === "nowhere" && read === "no read-back"
	return { items, marks, marked: unread ? "the target" : drawn, logged, read, bound }
}

/**
 * Whether a case's binding is carried, evaluated once before the first stratum into the carrier its readers read: a
 * later stratum or a read-back reads it. Otherwise only the first stratum's members read it, and its query is a part
 * of theirs (ir/write.ts BoundInput).
 */
const carried = (c: OnceCase): boolean =>
	c.logged === "in a second stratum" || c.read !== "no read-back"

export const situations = [
	"the target",
	"every item",
	"in the first stratum",
	"in a second stratum",
	"nowhere",
	"no read-back",
	"the target alone",
	"the target's marked items",
	"on the whole",
	"on each part",
	"carried, its re-evaluation another target"
] as const

export type Situation = (typeof situations)[number]

/** The query `target` is bound to: the items no mark holds, which the call's marks take out of it. */
const targetOf = (): QueryValue =>
	queryOver(Once).rule((r: RuleValue) => {
		const { id } = varsOver(Item, "item")
		return r.match(Item, { id }).where(r.not(Mark, { id })).find({ id })
	})

/** The facts of the relation parameter `target`, of Item's heading. */
const fromTarget = (): QueryValue =>
	queryOver(Once).rule((r: RuleValue) => {
		const target = r.relation("target", { id: Item.fields.id })
		const { id } = varsOver(target, "target")
		return r.match(target, { id }).find({ id })
	})

/** Every item. */
const everyItem = (): QueryValue =>
	queryOver(Once).rule((r: RuleValue) => {
		const { id } = varsOver(Item, "item")
		return r.match(Item, { id }).find({ id })
	})

/** The target's items the change marked: delta.added(Mark) joined to `target`, which rides the statement making it. */
const markedTarget =
	() =>
	(d: DeltaValue): QueryValue =>
		queryOver(Once).rule((r: RuleValue) => {
			const target = r.relation("target", { id: Item.fields.id })
			const { id } = varsOver(target, "target")
			return r.match(d.added(Mark), { id }).match(target, { id }).find({ id })
		})

/**
 * The case's ChangeSet: the first stratum's mark, its log there or none, and its read-back; then, sequenced after it,
 * the second stratum's log, where the case logs there. `target` is bound once on the whole, or by each part that reads
 * it, the first and the second, each binding it to the one query (write/changeset/value.ts makes them one input).
 */
export const changeOf = (c: OnceCase): ChangeSetValue => {
	const marked = ChangeSet.empty(Once).insert(
		Mark,
		c.marked === "the target" ? fromTarget() : everyItem()
	)
	const logged = c.logged === "in the first stratum" ? marked.insert(Log, fromTarget()) : marked
	const first =
		c.read === "no read-back"
			? logged
			: logged.read("picked", c.read === "the target alone" ? () => fromTarget() : markedTarget())
	const readsTarget =
		c.marked === "the target" || c.logged === "in the first stratum" || c.read !== "no read-back"
	const part = (change: ChangeSetValue, reads: boolean): ChangeSetValue =>
		c.bound === "on each part" && reads ? change.bind({ target: targetOf() }) : change
	const whole =
		c.logged === "in a second stratum"
			? ChangeSet.sequence(
					part(first, readsTarget),
					part(ChangeSet.empty(Once).insert(Log, fromTarget()), true)
				)
			: part(first, readsTarget)
	return c.bound === "on the whole" ? whole.bind({ target: targetOf() }) : whole
}

/** A case's state and read-back as the property compares them: each relation's ids in order. */
export interface Model {
	readonly mark: ReadonlyArray<number>
	readonly log: ReadonlyArray<number>
	/** The read-back's ids, none for a case that reads none. */
	readonly picked: ReadonlyArray<number> | undefined
}

const sorted = (values: Iterable<number>): ReadonlyArray<number> =>
	Arr.sort([...new Set(values)], Order.Number)

/**
 * The model: `target` evaluated once, over the stored state, T = items \ marks, whatever stratum or read-back reads it
 * (README "Writes": a relation parameter bound to a query is an input of the call). The first stratum marks T or every
 * item and logs T where it logs there; the second logs T; `picked` is T alone, or the marks the change added, Mark's
 * after it less its stored ones, within T.
 */
export const modelOf = (c: OnceCase): Model => {
	const target = Arr.filter(c.items, (id) => !c.marks.includes(id))
	const mark = sorted([...c.marks, ...(c.marked === "the target" ? target : c.items)])
	const added = Arr.filter(mark, (id) => !c.marks.includes(id))
	return {
		mark,
		log: c.logged === "nowhere" ? [] : sorted(target),
		picked:
			c.read === "no read-back"
				? undefined
				: c.read === "the target alone"
					? sorted(target)
					: sorted(Arr.filter(added, (id) => target.includes(id)))
	}
}

/** Whether a re-evaluation of `target` over the state after the first stratum would read another target than the
 * model's: the first stratum marks every item of T, so a reader after it that read T again would read none. */
export const reevaluationDiffers = (c: OnceCase): boolean =>
	carried(c) && Arr.some(c.items, (id) => !c.marks.includes(id))
