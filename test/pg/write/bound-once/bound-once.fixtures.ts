/** What the property of bound-once.test.ts reads: its schema and template, its space, a case's ChangeSet and its model. */

import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** The items, the marks the call adds to them, and the log it keeps of them, each keyed by its id. */
export const Item = relation("Item", { id: int4 }, ["id"])
export const Mark = relation("Mark", { id: int4 }, ["id"])
export const Log = relation("Log", { id: int4 }, ["id"])

export const Once = schema("BoundOnce", [Item, Mark, Log], [])

/** What every case installs: the schema, its login's workload empty, each case loading the ChangeSet it draws. */
export const onceInstall = { label: "boundonce", programs: {} } as const

/** The schema installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const onceTemplate = fixtureTemplate(import.meta, Once, onceInstall)

/** The ids a case's items, marks and drawn marks are drawn from. */
const ids: ReadonlyArray<number> = [1, 2, 3, 4]

/** What the call's first stratum marks: the target's items, so it reads the bound parameter, or the drawn ids. */
export type Marked = "the target" | "the drawn ids"

/** Where the call logs the target: in its first stratum, in a second one sequenced after it, or nowhere. */
export type Logged = "in the first stratum" | "in a second stratum" | "nowhere"

/** The read-back of the target, `picked`, which the last part declares: none, the target alone, or the target's items
 * the change marked, delta.added(Mark), which the first stratum's statement makes, joined to `target`. */
export type Read = "no read-back" | "the target alone" | "the target's marked items"

/** Where `target` is bound: once on the whole ChangeSet, or by each sequenced part that reads it, on its own. */
export type Bound = "on the whole" | "on each part"

/**
 * What `target`'s query reads: the items no mark holds, Item and Mark, which the call's marks change; or the items
 * alone, which no stratum of the call writes, so every state of the call reads one target (write/frontend/compile.ts
 * `agrees`).
 */
export type Over = "the unmarked items" | "the items"

export interface OnceCase {
	readonly items: ReadonlyArray<number>
	readonly marks: ReadonlyArray<number>
	readonly marked: Marked
	/** The ids the first stratum marks where it marks the drawn ids. */
	readonly drawn: ReadonlyArray<number>
	readonly logged: Logged
	readonly read: Read
	readonly bound: Bound
	readonly over: Over
}

/**
 * A case: the stored items and marks, each a subset of 1..4, the target the items no mark holds; how its first stratum
 * marks, where it logs the target, its read-back and where it binds `target`. A ChangeSet that reads `target` nowhere
 * binds nothing it can name, so such a draw marks the target.
 */
export const onceGen: Gen<OnceCase> = (source) => {
	const items = source.draw(subset(ids, { min: 1, max: 4 }))
	const marks = source.draw(subset(ids, { min: 0, max: 3 }))
	const marked = source.draw(element(["the target", "the drawn ids"] as const))
	const drawn = source.draw(subset(ids, { min: 1, max: 4 }))
	const logged = source.draw(
		element(["in the first stratum", "in a second stratum", "nowhere"] as const)
	)
	const read = source.draw(
		element(["no read-back", "the target alone", "the target's marked items"] as const)
	)
	const bound = source.draw(element(["on the whole", "on each part"] as const))
	const over = source.draw(element(["the unmarked items", "the items"] as const))
	const unread = logged === "nowhere" && read === "no read-back"
	return { items, marks, marked: unread ? "the target" : marked, drawn, logged, read, bound, over }
}

export const situations = [
	"the target",
	"the drawn ids",
	"in the first stratum",
	"in a second stratum",
	"nowhere",
	"no read-back",
	"the target alone",
	"the target's marked items",
	"on the whole",
	"on each part",
	"the unmarked items",
	"the items",
	"a binding read where the call writes none of what it reads",
	"a later part's binding, after the earlier part's writes",
	"a binding read after the first stratum, its re-evaluation another target",
	"a read-back carried past its part's later binding"
] as const

export type Situation = (typeof situations)[number]

/** The query `target` is bound to: the items no mark holds, which the call's marks take out of it, or the items. */
const targetOf = (over: Over): QueryValue =>
	queryOver(Once).rule((r: RuleValue) => {
		const { id } = varsOver(Item, "item")
		const items = r.match(Item, { id })
		return (over === "the items" ? items : items.where(r.not(Mark, { id }))).find({ id })
	})

/** The facts of the relation parameter `target`, of Item's heading. */
const fromTarget = (): QueryValue =>
	queryOver(Once).rule((r: RuleValue) => {
		const target = r.relation("target", { id: Item.fields.id })
		const { id } = varsOver(target, "target")
		return r.match(target, { id }).find({ id })
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

/** Whether the case has a second part, sequenced after the first: its log of the target. */
export const twoParts = (c: OnceCase): boolean => c.logged === "in a second stratum"

/** Whether the first part reads `target`: its mark of the target, its log, or the read-back it declares as the last. */
const firstReads = (c: OnceCase): boolean =>
	c.marked === "the target" ||
	c.logged === "in the first stratum" ||
	(c.read !== "no read-back" && !twoParts(c))

/**
 * The case's ChangeSet: the first stratum's mark and its log there or none; then, sequenced after it, the second
 * stratum's log, where the case logs there; the read-back declared by the last part. `target` is bound once on the
 * whole, or by each part that reads it to the one query, each such binding scoped to its part (docs/reads-and-writes.md "Writes").
 */
export const changeOf = (c: OnceCase): ChangeSetValue => {
	const marks = ChangeSet.empty(Once).insert(
		Mark,
		c.marked === "the target" ? fromTarget() : Arr.map(c.drawn, (id) => ({ id }))
	)
	const logged = c.logged === "in the first stratum" ? marks.insert(Log, fromTarget()) : marks
	const reading = (change: ChangeSetValue): ChangeSetValue =>
		c.read === "no read-back"
			? change
			: change.read("picked", c.read === "the target alone" ? () => fromTarget() : markedTarget())
	const part = (change: ChangeSetValue, reads: boolean): ChangeSetValue =>
		c.bound === "on each part" && reads ? change.bind({ target: targetOf(c.over) }) : change
	const whole = twoParts(c)
		? ChangeSet.sequence(
				part(logged, firstReads(c)),
				part(reading(ChangeSet.empty(Once).insert(Log, fromTarget())), true)
			)
		: part(reading(logged), firstReads(c))
	return c.bound === "on the whole" ? whole.bind({ target: targetOf(c.over) }) : whole
}

/** The facts a call of the case's served ChangeSet gives its array member, the drawn ids' marks: a served change's
 * array members are its call's (runtime/write/members.ts memberFactsOf). */
export const callFactsOf = (c: OnceCase): Readonly<Record<string, unknown>> =>
	c.marked === "the drawn ids" ? { insert: { Mark: Arr.map(c.drawn, (id) => ({ id })) } } : {}

/** The strata a case's bindings of `target` are evaluated before, in order: one on the whole, at 0; on each part, the
 * first part's at 0 where it reads it, and the second part's at 1, after the first's one stratum. */
export const boundStrata = (c: OnceCase): ReadonlyArray<number> =>
	c.bound === "on the whole" ? [0] : [...(firstReads(c) ? [0] : []), ...(twoParts(c) ? [1] : [])]

/** A case's outcome as the property compares it: each relation's ids in order and the read-back's. */
export interface Model {
	readonly mark: ReadonlyArray<number>
	readonly log: ReadonlyArray<number>
	/** The read-back's ids, none for a case that reads none. */
	readonly picked: ReadonlyArray<number> | undefined
}

/** Whether the last part's read-back of the first stratum's delta reads the second part's binding, evaluated only after
 * that stratum: the read-back runs after the writes, its delta carried out of the first stratum's statement. */
export const carriedPastBinding = (c: OnceCase): boolean =>
	c.read === "the target's marked items" && c.bound === "on each part" && twoParts(c)

const sorted = (values: Iterable<number>): ReadonlyArray<number> =>
	Arr.sort([...new Set(values)], Order.Number)

/** The target before the change, T0, the items no stored mark holds, or every item. */
const targetBefore = (c: OnceCase): ReadonlyArray<number> =>
	c.over === "the items" ? c.items : Arr.filter(c.items, (id) => !c.marks.includes(id))

/** Mark after the first stratum: the stored marks and the target's items or the drawn ids. */
const marksAfter = (c: OnceCase): ReadonlyArray<number> =>
	sorted([...c.marks, ...(c.marked === "the target" ? targetBefore(c) : c.drawn)])

/** The second part's target: on each part, its own binding, evaluated after the first stratum, T1, the items no mark
 * holds then; on the whole, the one binding before the change, T0. */
const laterTarget = (c: OnceCase): ReadonlyArray<number> =>
	c.bound === "on each part" && twoParts(c) && c.over === "the unmarked items"
		? Arr.filter(c.items, (id) => !marksAfter(c).includes(id))
		: targetBefore(c)

/**
 * The model: each binding of `target` evaluated once, before its part's first stratum (docs/reads-and-writes.md "Writes": a relation
 * parameter bound to a query is scoped to the ChangeSet it was bound on). The first part's reads T0, the items no
 * stored mark holds; the second part's, on each part, T1, the items no mark holds after the first stratum, and on the
 * whole the one T0. The first stratum marks T0 or the drawn ids and logs T0 where it logs there; the second logs its
 * target; `picked`, declared by the last part, is its target, or the marks the change added within its target, the
 * delta read with the target its part's binding read, after that stratum where the binding is the second part's.
 */
export const modelOf = (c: OnceCase): Model => {
	const mark = marksAfter(c)
	const last = laterTarget(c)
	const added = Arr.filter(mark, (id) => !c.marks.includes(id))
	return {
		mark,
		log:
			c.logged === "nowhere"
				? []
				: c.logged === "in the first stratum"
					? sorted(targetBefore(c))
					: sorted(last),
		picked:
			c.read === "no read-back"
				? undefined
				: c.read === "the target alone"
					? sorted(last)
					: sorted(Arr.filter(added, (id) => last.includes(id)))
	}
}

/** Whether the first stratum takes an item out of the target before the change, so a reader after it that evaluated
 * the target again would read another than the binding's. */
const firstTakes = (c: OnceCase): boolean =>
	c.over === "the unmarked items" && Arr.some(targetBefore(c), (id) => marksAfter(c).includes(id))

/**
 * The bindings of `target` the call carries, filled first among their stratum's statements (write/schedule/plan.ts
 * step `bound`): a binding over the items is read the same in every state of the call, so it is a part of every
 * reader's query; one over the unmarked items is carried where a reader reads a state after the first stratum's
 * marks: on the whole, where the second part or a read-back reads it; on each part, the first part's where the
 * read-back of the one part reads it after the marks, and never the second part's, whose readers, its log and the
 * read-back, read the state after the marks, which only the log's insert into Log follows.
 */
export const carriedBindings = (c: OnceCase): number => {
	if (c.over === "the items") {
		return 0
	}
	if (c.bound === "on the whole") {
		return twoParts(c) || c.read !== "no read-back" ? 1 : 0
	}
	return firstReads(c) && !twoParts(c) && c.read !== "no read-back" ? 1 : 0
}

/** Whether the second part's own binding reads the first stratum's writes: on each part, a target the first stratum
 * changed. */
export const laterPartSees = (c: OnceCase): boolean =>
	c.bound === "on each part" && twoParts(c) && firstTakes(c)

/** Whether a binding of the first stratum's state is read after it, by the second stratum or the read-back, where the
 * first stratum takes an item out of its target: an evaluation again there would read another target. */
export const reevaluationDiffers = (c: OnceCase): boolean =>
	firstTakes(c) &&
	(c.bound === "on the whole"
		? twoParts(c) || c.read !== "no read-back"
		: !twoParts(c) && c.read !== "no read-back")

/**
 * The composite a case binds `target` on: a union of the mark and the log of the target, a sequence of them, or a
 * sequence of the mark and a union of the log and the mark again, metis's assign's shape (its due sittings held, then
 * the union of the assignment it makes and what its caller states, `target` bound on the whole).
 */
export type Composed = "a union" | "a sequence" | "a sequence of a union"

/** A case of the caller's own relation parameter read by the binding: the stored items and marks, the items the caller
 * names in `skip`, and the composite. */
export interface SkipCase {
	readonly items: ReadonlyArray<number>
	readonly marks: ReadonlyArray<number>
	readonly skip: ReadonlyArray<number>
	readonly composed: Composed
}

export const skipGen: Gen<SkipCase> = (source) => ({
	items: source.draw(subset(ids, { min: 1, max: 4 })),
	marks: source.draw(subset(ids, { min: 0, max: 2 })),
	skip: source.draw(subset(ids, { min: 0, max: 3 })),
	composed: source.draw(element(["a union", "a sequence", "a sequence of a union"] as const))
})

export const skipSituations = [
	"a union",
	"a sequence",
	"a sequence of a union",
	"a skipped item of the target",
	"no item skipped"
] as const

export type SkipSituation = (typeof skipSituations)[number]

/** The caller's relation parameter `skip`'s heading, Item's. */
const skipped = { id: Item.fields.id } as const

/** The query `target` is bound to here: the items no mark holds and the caller's `skip` names none of, so the call's
 * own relation parameter is read by the binding, a parameter of the call, never one of a part's own. */
const unskippedTargetOf = (): QueryValue =>
	queryOver(Once).rule((r: RuleValue) => {
		const { id } = varsOver(Item, "item")
		return r
			.match(Item, { id })
			.where(r.not(Mark, { id }), r.not(r.relation("skip", skipped), { id }))
			.find({ id })
	})

/** The case's ChangeSet: its composite of the mark and the log of `target`, `target` bound on the whole to the items no
 * mark holds and the caller skips none of. */
export const skipChangeOf = (c: SkipCase): ChangeSetValue => {
	const mark = (): ChangeSetValue => ChangeSet.empty(Once).insert(Mark, fromTarget())
	const log = ChangeSet.empty(Once).insert(Log, fromTarget())
	const composite =
		c.composed === "a union"
			? ChangeSet.union(mark(), log)
			: c.composed === "a sequence"
				? ChangeSet.sequence(mark(), log)
				: ChangeSet.sequence(mark(), ChangeSet.union(log, mark()))
	return composite.bind({ target: unskippedTargetOf() })
}

/** The target the binding reads before the change: the items no stored mark holds and the caller skips none of. */
export const unskippedTarget = (c: SkipCase): ReadonlyArray<number> =>
	sorted(Arr.filter(c.items, (id) => !c.marks.includes(id) && !c.skip.includes(id)))

/** The model: Mark the stored marks and the target, Log the target. */
export const skipModelOf = (
	c: SkipCase
): { readonly mark: ReadonlyArray<number>; readonly log: ReadonlyArray<number> } => ({
	mark: sorted([...c.marks, ...unskippedTarget(c)]),
	log: unskippedTarget(c)
})
