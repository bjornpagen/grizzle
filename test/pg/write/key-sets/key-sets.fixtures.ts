/** What key-sets.test.ts reads: its schema, its box, a case's write, the stored state at a scale and the model. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"

/**
 * A session's items and the ones done; the content no value of a write restricts, two relations of an item's tags and
 * one of its links, which the property counts the reads of; an item's pins, which it does not; and the two relations the
 * write fills.
 */
export const Item = relation("Item", { session: int4, k: int4, v: int4 }, ["session", "k"])
export const Done = relation("Done", { session: int4, k: int4 }, ["session", "k"])
export const Tag = relation("Tag", { k: int4, t: int4 }, ["k", "t"])
export const TagB = relation("TagB", { k: int4, t: int4 }, ["k", "t"])
export const Link = relation("Link", { k: int4, j: int4 }, ["k", "j"])
export const Pin = relation("Pin", { k: int4, t: int4 }, ["k", "t"])
const outFields = { session: int4, k: int4, t: int4 } as const
export const Out0 = relation("Out0", outFields, ["session", "k", "t"])
export const Out1 = relation("Out1", outFields, ["session", "k", "t"])

export const build = (name: string) =>
	schema(name, [Item, Done, Tag, TagB, Link, Pin, Out0, Out1], [])

export type Schema = ReturnType<typeof build>

/**
 * How the write reads the content: the labels, a union of two folds of every item's tags (each item's greatest tag in
 * Tag and in TagB), or the joined labels, the labels joined to each item's greatest link, a join of two inputs that
 * both grow with the content and that no read of the statement reads but the join.
 *
 * - `two members by the open items`: both members join the call's open items to the labels by the item, a diamond of
 *   two restricted readers.
 * - `two members by other items`: the first member joins the open items to the labels, the second the call's done
 *   items, two reads at keys of their own, the labels at the union of both.
 * - `one by the open items, one alone`: the second member writes every label, an unrestricted reader, so the labels and
 *   their folds are whole.
 * - `an existence test`: the first member keeps the open items whose value is no label of theirs, the labels read on the
 *   right of an anti-join, keyed by its left side through its pairs.
 * - `two members by the aggregate`: both members join the open items to the labels by the item and by the label's value
 *   to the item's, the folds' aggregate, on which they are never restricted below the fold.
 * - `a chain of joined content`: both members join the open items to the joined labels by the item, the join held at
 *   their keys and the labels, their folds and the links beneath it each at its own, a chain three nodes deep.
 * - `a guarded existence test`: the first member keeps the open items no guard of the call's session holds, a union
 *   of two arms each reading the labels, at the session the call names and on the right of an anti-join, as metis's
 *   assign guards the assigned test by the statuses of its assignments; the second reads them by the open items.
 */
export type Readers =
	| "two members by the open items"
	| "two members by other items"
	| "one by the open items, one alone"
	| "an existence test"
	| "two members by the aggregate"
	| "a chain of joined content"
	| "a guarded existence test"

export const situations = [
	"two members by the open items",
	"two members by other items",
	"one by the open items, one alone",
	"an existence test",
	"two members by the aggregate",
	"a chain of joined content",
	"a guarded existence test"
] as const satisfies ReadonlyArray<Readers>

export const readersGen: Gen<Readers> = element<Readers>(situations)

/** Whether the readers restrict the content they read: every read joins it to the call's open items or session. */
export const restricted = (readers: Readers): boolean =>
	readers !== "one by the open items, one alone"

/** Each item's greatest value in `T`'s second column: a fold of every item's rows, which no value of the write restricts. */
const greatestTag = (s: Schema, T: typeof Tag | typeof TagB) =>
	queryOver(s).rule((r: RuleValue) => {
		const { k, t } = varsOver(T, "tag")
		return r.match(T, { k, t }).find({ k, t: r.max(t) })
	})

/** The labels: each item's greatest tag in Tag and in TagB, a union of the two folds. */
const labelsOf = (s: Schema): QueryValue => {
	const arm = (T: typeof Tag | typeof TagB) => (r: RuleValue) => {
		const f = greatestTag(s, T)
		const { k, t } = varsOver(f, "folded")
		return r.match(f, { k, t }).find({ k, t })
	}
	return queryOver(s).rule(arm(Tag)).rule(arm(TagB))
}

/** The joined labels: each label of an item that links to another, the labels joined to each item's greatest link. */
const joinedOf = (s: Schema): QueryValue => {
	const labels = labelsOf(s)
	const links = queryOver(s).rule((r: RuleValue) => {
		const { k, j } = varsOver(Link, "link")
		return r.match(Link, { k, j }).find({ k, j: r.max(j) })
	})
	return queryOver(s).rule((r: RuleValue) => {
		const { k, t } = varsOver(labels, "label")
		const { j } = varsOver(links, "linked")
		return r.match(labels, { k, t }).match(links, { k, j }).find({ k, t })
	})
}

const sittingHeading = { session: int4 } as const

/** The open items of the call's sessions: each item of a session the call names no Done fact holds. */
const openOf = (s: Schema): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const sittings = r.relation("sittings", sittingHeading)
		const { session } = varsOver(sittings, "sitting")
		const { k, v } = varsOver(Item, "item")
		return r
			.match(sittings, { session })
			.match(Item, { session, k, v })
			.where(r.not(Done, { session, k }))
			.find({ session, k, v })
	})

/** The call's open items, its sittings bound to the rule's. */
const openIn = (s: Schema, r: RuleValue) =>
	openOf(s).bind({ sittings: r.relation("sittings", sittingHeading) })

/** A member's rows: the open items' rows of `content`. */
const byOpen = (s: Schema, content: QueryValue): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const open = openIn(s, r)
		const { session, k } = varsOver(open, "open")
		const { t } = varsOver(content, "label")
		return r.match(open, { session, k }).match(content, { k, t }).find({ session, k, t })
	})

/** A member's rows: the open items' rows of `content` that an item's pin holds, a region of its own over them. */
const byOpenPinned = (s: Schema, content: QueryValue): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const open = openIn(s, r)
		const { session, k } = varsOver(open, "open")
		const { t } = varsOver(content, "label")
		return r
			.match(open, { session, k })
			.match(content, { k, t })
			.match(Pin, { k, t })
			.find({ session, k, t })
	})

/** A member's rows: the labels of the call's done items. */
const byDone = (s: Schema, labels: QueryValue): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const sittings = r.relation("sittings", sittingHeading)
		const { session } = varsOver(sittings, "sitting")
		const { k } = varsOver(Done, "done")
		const { t } = varsOver(labels, "label")
		return r
			.match(sittings, { session })
			.match(Done, { session, k })
			.match(labels, { k, t })
			.find({ session, k, t })
	})

/** A member's rows: every label, at the call's session, which no open item restricts. */
const alone = (s: Schema, labels: QueryValue): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const { k, t } = varsOver(labels, "label")
		return r.match(labels, { k, t }).find({ session: r.param("session", int4), k, t })
	})

/** A member's rows: the open items whose value is no label of theirs, the labels on an anti-join's right. */
const unlabelled = (s: Schema, labels: QueryValue): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const open = openIn(s, r)
		const { session, k, v } = varsOver(open, "open")
		return r
			.match(open, { session, k, v })
			.where(r.not(labels, { k, t: v }))
			.find({ session, k, t: v })
	})

/** A member's rows: the open items whose value is a label of theirs, joined by the folds' aggregate. */
const byValue = (s: Schema, labels: QueryValue): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const open = openIn(s, r)
		const { session, k, v } = varsOver(open, "open")
		return r.match(open, { session, k, v }).match(labels, { k, t: v }).find({ session, k, t: v })
	})

/** A member's rows: the open items whose value is a label of theirs that a pin holds, a region of its own. */
const byValuePinned = (s: Schema, labels: QueryValue): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const open = openIn(s, r)
		const { session, k, v } = varsOver(open, "open")
		return r
			.match(open, { session, k, v })
			.match(labels, { k, t: v })
			.match(Pin, { k, t: v })
			.find({ session, k, t: v })
	})

/**
 * The guards: each session's item whose value is a label of its, or that is done and labelled, a union of two arms each
 * reading the labels, which no value of the write restricts.
 */
const guardsOf = (s: Schema, labels: QueryValue): QueryValue =>
	queryOver(s)
		.rule((r: RuleValue) => {
			const { session, k, v } = varsOver(Item, "item")
			return r.match(Item, { session, k, v }).match(labels, { k, t: v }).find({ session, k })
		})
		.rule((r: RuleValue) => {
			const { session, k } = varsOver(Done, "done")
			const { t } = varsOver(labels, "label")
			return r.match(Done, { session, k }).match(labels, { k, t }).find({ session, k })
		})

/** A member's rows: the open items no guard of the call's session holds, the guards at it on an anti-join's right. */
const unguarded = (s: Schema, labels: QueryValue): QueryValue => {
	const guards = guardsOf(s, labels)
	const atSession = queryOver(s).rule((r: RuleValue) => {
		const { session, k } = varsOver(guards, "guard")
		return r
			.match(guards, { session, k })
			.where(r.eq(session, r.param("session", int4)))
			.find({ k })
	})
	return queryOver(s).rule((r: RuleValue) => {
		const open = openIn(s, r)
		const { session, k, v } = varsOver(open, "open")
		return r
			.match(open, { session, k, v })
			.where(r.not(atSession.bind({ session: r.param("session", int4) }), { k }))
			.find({ session, k, t: v })
	})
}

/** The session the call names: the write's `sittings`. */
const namedOf = (s: Schema): QueryValue =>
	queryOver(s).rule((r: RuleValue) => r.find({ session: r.param("session", int4) }))

/** The case's write: the two members, Out0's and Out1's, the sittings bound to the call's session. */
export const changeOf = (s: Schema, readers: Readers): ChangeSetValue => {
	const labels = labelsOf(s)
	const [first, second] = ((): readonly [QueryValue, QueryValue] => {
		switch (readers) {
			case "two members by the open items":
				return [byOpen(s, labels), byOpenPinned(s, labels)]
			case "two members by other items":
				return [byOpen(s, labels), byDone(s, labels)]
			case "one by the open items, one alone":
				return [byOpen(s, labels), alone(s, labels)]
			case "an existence test":
				return [unlabelled(s, labels), byOpen(s, labels)]
			case "two members by the aggregate":
				return [byValue(s, labels), byValuePinned(s, labels)]
			case "a chain of joined content": {
				const joined = joinedOf(s)
				return [byOpen(s, joined), byOpenPinned(s, joined)]
			}
			case "a guarded existence test":
				return [unguarded(s, labels), byOpen(s, labels)]
		}
	})()
	return ChangeSet.empty(s)
		.insert(Out0, first)
		.insert(Out1, second)
		.bind({ sittings: namedOf(s) })
}

/** The call's session. */
export const session = 1

/** The items: four of the call's session, the second done, and four of another session. */
export const items: ReadonlyArray<{
	readonly session: number
	readonly k: number
	readonly v: number
}> = Arr.flatMap([1, 2], (s) => Arr.map([1, 2, 3, 4], (k) => ({ session: s, k, v: (k % 3) + 1 })))

export const done: ReadonlyArray<{ readonly session: number; readonly k: number }> = [
	{ session, k: 2 }
]

/** The rows of a relation of (k, second column) the property stores. */
type Pair = { readonly k: number; readonly t: number }

/**
 * The content at a scale: the call's items' four and eight more items' per scale, which no read of the write meets, each
 * item two tags in Tag, every other item one in TagB, and every item but the third two links; and every item's pins.
 */
export const contentAt = (
	scale: number
): {
	readonly tag: ReadonlyArray<Pair>
	readonly tagB: ReadonlyArray<Pair>
	readonly link: ReadonlyArray<Pair>
	readonly pin: ReadonlyArray<Pair>
} => {
	const ks = Array.from({ length: 4 + 8 * scale }, (_, i) => i + 1)
	const dedupe = (rows: ReadonlyArray<Pair>): ReadonlyArray<Pair> =>
		Arr.dedupeWith(rows, (a, b) => a.k === b.k && a.t === b.t)
	return {
		tag: dedupe(
			Arr.flatMap(ks, (k) => [
				{ k, t: (k % 5) + 1 },
				{ k, t: ((k * 7) % 5) + 1 }
			])
		),
		tagB: Arr.flatMap(ks, (k) => (k % 2 === 1 ? [{ k, t: ((k * 3) % 5) + 1 }] : [])),
		link: Arr.flatMap(ks, (k) =>
			k % 3 === 0
				? []
				: [
						{ k, t: k + 1 },
						{ k, t: k + 2 }
					]
		),
		pin: dedupe(
			Arr.flatMap(ks, (k) => [
				{ k, t: (k % 5) + 1 },
				{ k, t: ((k * 3) % 5) + 1 }
			])
		)
	}
}

/** A fact of Out0 or Out1 as the property compares it: "session | k | t". */
const factText = (f: {
	readonly session: number
	readonly k: number
	readonly t: number
}): string => `${f.session} | ${f.k} | ${f.t}`

/** The model's Out0 and Out1 at a scale: each member's meaning over the stored state, as text, sorted. */
export const modelOf = (
	readers: Readers,
	scale: number
): { readonly out0: ReadonlyArray<string>; readonly out1: ReadonlyArray<string> } => {
	const { tag, tagB, link, pin } = contentAt(scale)
	/** Each item's greatest second column among `rows`. */
	const greatest = (rows: ReadonlyArray<Pair>): ReadonlyArray<Pair> => {
		const best = new Map<number, number>()
		for (const r of rows) {
			best.set(r.k, Math.max(best.get(r.k) ?? r.t, r.t))
		}
		return Arr.map([...best], ([k, t]) => ({ k, t }))
	}
	const labels = Arr.dedupeWith(
		[...greatest(tag), ...greatest(tagB)],
		(a, b) => a.k === b.k && a.t === b.t
	)
	const linked = new Set(Arr.map(greatest(link), (l) => l.k))
	const joined = Arr.filter(labels, (l) => linked.has(l.k))
	const isLabel = (k: number, t: number): boolean => Arr.some(labels, (l) => l.k === k && l.t === t)
	const open = Arr.filter(
		items,
		(i) => i.session === session && !Arr.some(done, (d) => d.session === i.session && d.k === i.k)
	)
	const byOpenRows = (content: ReadonlyArray<Pair>) =>
		Arr.flatMap(open, (i) =>
			Arr.flatMap(content, (l) => (l.k === i.k ? [{ session, k: i.k, t: l.t }] : []))
		)
	const isPin = (k: number, t: number): boolean => Arr.some(pin, (x) => x.k === k && x.t === t)
	const pinned = (content: ReadonlyArray<Pair>) =>
		Arr.filter(byOpenRows(content), (f) => isPin(f.k, f.t))
	const byValueRows = Arr.flatMap(open, (i) =>
		isLabel(i.k, i.v) ? [{ session, k: i.k, t: i.v }] : []
	)
	const doneHere = Arr.filter(done, (d) => d.session === session)
	const byDoneRows = Arr.flatMap(doneHere, (d) =>
		Arr.flatMap(labels, (l) => (l.k === d.k ? [{ session, k: d.k, t: l.t }] : []))
	)
	/** Whether a guard of the call's session holds item `k`: its value a label of its, or done and labelled. */
	const guarded = (k: number): boolean =>
		Arr.some(items, (i) => i.session === session && i.k === k && isLabel(k, i.v)) ||
		Arr.some(done, (d) => d.session === session && d.k === k && Arr.some(labels, (l) => l.k === k))
	const rows = (() => {
		switch (readers) {
			case "two members by the open items":
				return { out0: byOpenRows(labels), out1: pinned(labels) }
			case "two members by other items":
				return { out0: byOpenRows(labels), out1: byDoneRows }
			case "one by the open items, one alone":
				return {
					out0: byOpenRows(labels),
					out1: Arr.map(labels, (l) => ({ session, k: l.k, t: l.t }))
				}
			case "an existence test":
				return {
					out0: Arr.flatMap(open, (i) => (isLabel(i.k, i.v) ? [] : [{ session, k: i.k, t: i.v }])),
					out1: byOpenRows(labels)
				}
			case "two members by the aggregate":
				return { out0: byValueRows, out1: Arr.filter(byValueRows, (f) => isPin(f.k, f.t)) }
			case "a chain of joined content":
				return { out0: byOpenRows(joined), out1: pinned(joined) }
			case "a guarded existence test":
				return {
					out0: Arr.flatMap(open, (i) => (guarded(i.k) ? [] : [{ session, k: i.k, t: i.v }])),
					out1: byOpenRows(labels)
				}
		}
	})()
	const texts = (
		fs: ReadonlyArray<{ readonly session: number; readonly k: number; readonly t: number }>
	) => Arr.sort(Arr.dedupe(Arr.map(fs, factText)), Order.String)
	return { out0: texts(rows.out0), out1: texts(rows.out1) }
}
