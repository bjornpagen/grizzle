/** What the property of places.test.ts reads: its schema, its space, its model and its helpers. */

import { deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { constant, element, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, place, int4 } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import {
	fin,
	key,
	login,
	mutable,
	on,
	ordered,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

export const Session = relation(
	"Session",
	{
		child: int4,
		item: int4,
		n: place.by("stage"),
		stage: int4,
		marks: drawn(natural)
	},
	["child", "item", "n"]
)

/** A session's marks, its ordered family, each carrying its session's (child, item, n): the place its insert stamps. */
export const Mark = relation(
	"Mark",
	{ child: int4, item: int4, n: natural, at: drawn(natural), v: int4 },
	["child", "item", "n", "at"]
)

/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
export const Gate = relation("Gate", { n: int4 }, ["n"])

/** The schema, the role `writer`, which inserts Session and Gate and nothing else, and its two logins. */
export const places = (name: string) => {
	const base = schema(
		name,
		[Session, Mark, Gate],
		[
			key(on(Session, "child", "item", "stage")),
			ordered(on(Mark, "child", "item", "n", "at"), fin(Session, "marks"))
		]
	)
	const writer = role(
		base,
		"writer",
		{ Session, Mark, Gate },
		{ insert: ["Session", "Mark", "Gate"] }
	)
	const direct = role(base, "direct", { Session, Mark, Gate })
	return {
		schema: base,
		writer,
		direct,
		server: login(base, "server", [writer], {
			workload: [
				workload(writer, {
					stamp: ChangeSet.empty(base)
						.insert(Session, [])
						.read("stamped", (delta) =>
							query(base).rule((r) => {
								const { child, item, n, stage } = v(delta.added(Session), "added")
								return r
									.match(delta.added(Session), { child, item, n, stage })
									.find({ child, item, n, stage })
							})
						),
					held: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Session, []),
						ChangeSet.empty(base).insert(Gate, [])
					)
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** How many places an item holds before the calls, at stages 100 on. */
type Head = 0 | 1 | 2

/** The items a call stamps, one row at each, at a stage of its own. */
export type Items = readonly [1] | readonly [2] | readonly [1, 2]

type Mode = "concurrent" | "sequential"

/** How many marks each of a call's sessions nests: none, one or two. */
type Marks = 0 | 1 | 2

export interface Placing {
	readonly mode: Mode
	readonly heads: { readonly 1: Head; readonly 2: Head }
	readonly a: Items
	readonly b: Items
	readonly marks: { readonly A: Marks; readonly B: Marks }
}

export type PlaceFeature =
	| "an item over no place"
	| "an item over one place"
	| "an item over two places"
	| "an item both calls stamp, concurrently"
	| "an item both calls stamp, in turn"
	| "B waited for A at a group"
	| "two items in one call"
	| "a session nesting marks"
	| "a session nesting none"

const itemsGen: Gen<Items> = element([[1], [2], [1, 2]] as const)

export const placingGen: Gen<Placing> = (source) => ({
	mode: source.draw(element(["concurrent", "sequential"] as const)),
	heads: {
		1: source.draw(element([0, 1, 2] as const)),
		2: source.draw(element([0, 1, 2] as const))
	},
	a: source.draw(itemsGen),
	b: source.draw(itemsGen),
	marks: {
		A: source.draw(element([0, 1, 2] as const)),
		B: source.draw(element([0, 1, 2] as const))
	}
})

/** A case constructed to reach B waiting for A at a group: both stamping item 1, concurrently. */
export const aims: ReadonlyArray<readonly [Reached<PlaceFeature>, Gen<Placing>]> = [
	[
		"B waited for A at a group",
		constant<Placing>({
			mode: "concurrent",
			heads: { 1: 1, 2: 0 },
			a: [1],
			b: [1],
			marks: { A: 2, B: 1 }
		})
	]
]

/** Whether A and B stamp one item, whose group's head B waits for A at in `concurrent`. */
export const meets = (c: Placing): boolean => Arr.some(c.a, (item) => Arr.contains(c.b, item))

/** The stage a call's row at `item` states: A's 10 + item, B's 20 + item, a stored row's 100 on. */
const stageOf = (call: "A" | "B", item: 1 | 2): number => (call === "A" ? 10 : 20) + item

/** The marks' values of a call's session at `item`: its stage times ten and on, `count` of them. */
const markValues = (call: "A" | "B", item: 1 | 2, count: number): ReadonlyArray<number> =>
	Array.from({ length: count }, (_, at) => stageOf(call, item) * 10 + at)

/** A call's rows: one at each of its items, of child 1, at its stage, nesting `count` marks each. */
export const callRows = (call: "A" | "B", items: Items, count: Marks) =>
	Arr.map(items, (item) => ({
		child: 1,
		item,
		stage: stageOf(call, item),
		marks: Arr.map(markValues(call, item, count), (value) => ({ v: value }))
	}))

/** The stored rows of a case's heads: each item's places 0 on, at stages 100 on, nesting no mark, as SQL row
 * literals. */
export const seededRows = (c: Placing): ReadonlyArray<string> =>
	Arr.flatMap([1, 2] as const, (item) =>
		Array.from({ length: c.heads[item] }, (_, n) => `(1, ${item}, ${n}, ${100 + n}, 0)`)
	)

/** A stored mark, read back: its item, its session's place, its slot and its value. */
export interface StoredMark {
	readonly item: number
	readonly n: number
	readonly at: number
	readonly v: number
}

/**
 * Where the marks the calls added depart from their sessions' (see the property's header), why; none where every
 * session a call added at `n` holds exactly its call's marks at (item, n), in slot order, and no mark stands at a place
 * no session of a call holds. `added` are the calls' sessions as stored, `marks` every stored mark.
 */
export const marksDeparture = (
	c: Placing,
	added: ReadonlyArray<Stored>,
	marks: ReadonlyArray<StoredMark>
): string | undefined => {
	const expected = Arr.flatMap(added, (s) => {
		const call = s.stage < 20 ? "A" : "B"
		const item = s.item === 1 ? 1 : 2
		return Arr.map(markValues(call, item, c.marks[call]), (value, at) => ({
			item: s.item,
			n: s.n,
			at,
			v: value
		}))
	})
	const order = (m: StoredMark) => `${m.item} ${m.n} ${m.at}`
	const sorted = (xs: ReadonlyArray<StoredMark>) =>
		Arr.sort(xs, Order.mapInput(Order.String, order))
	return deepEquals(sorted(marks), sorted(expected))
		? undefined
		: `every session the calls added holds its call's marks at its own place, and no other mark stands: ${Formatter.format(sorted(expected))}: ${Formatter.format(sorted(marks))}`
}

/** A stored row, read back: its item, its place and its stage. */
export interface Stored {
	readonly item: number
	readonly n: number
	readonly stage: number
}

/** A call's answer once it is no TransientFailure, and how many times it ran. */
export interface Answered {
	readonly tries: number
	readonly ran: Result.Result<WriteAnswer<WriteOutcome<unknown>>, CallError>
}

/** `call` run until it ends other than in a TransientFailure, each run counted. */
export const untilAnswered = (call: Effect.Effect<WriteAnswer<WriteOutcome<unknown>>, CallError>) =>
	Effect.gen(function* () {
		for (let tries = 1; ; tries++) {
			const ran = yield* Effect.result(call)
			if (Result.isSuccess(ran) || ran.failure.kind !== "transient") {
				return { tries, ran } satisfies Answered
			}
		}
	})

export const addedTo = (outcome: WriteAnswer<WriteOutcome<unknown>>): bigint =>
	outcome.kind === "accepted"
		? Option.getOrElse(
				Option.map(
					Arr.findFirst(outcome.counts, (c) => c.relation === "Session"),
					(c) => c.added
				),
				() => 0n
			)
		: 0n

/**
 * Where the places the calls added at `item` depart from the rule (see the property's header), why; none where they
 * keep it. `added` are the item's rows the calls added, by place, and `order` the calls in commit order with their
 * items.
 */
export const departureAt = (
	item: 1 | 2,
	head: Head,
	added: ReadonlyArray<Stored>,
	order: ReadonlyArray<readonly ["A" | "B", Items]>
): string | undefined => {
	const stamping = Arr.filter(order, ([, items]) => Arr.contains(items, item))
	const expected = Arr.map(stamping, ([call], k) => ({
		item,
		n: head + k,
		stage: stageOf(call, item)
	}))
	return deepEquals(added, expected)
		? undefined
		: `item ${item} holds its calls' places from its head, ${head}, in commit order, ${Formatter.format(expected)}: ${Formatter.format(added)}`
}

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const placesRig = rigTemplate(import.meta, "places", places)

/**
 * Where B's read-back of the sessions it added departs from them, why; none where it reads back exactly its sessions as
 * stored, each at the place its insert stamped, which its one statement returned: `stored` are B's sessions as stored.
 */
export const stampedDeparture = (
	b: Answered,
	stored: ReadonlyArray<Stored>
): string | undefined => {
	if (
		!Result.isSuccess(b.ran) ||
		b.ran.success.kind === "refused" ||
		b.ran.success.kind === "outsideWorld"
	) {
		return undefined
	}
	const reads: unknown = b.ran.success.reads
	const rows =
		typeof reads === "object" && reads !== null && "stamped" in reads && Arr.isArray(reads.stamped)
			? Arr.map(reads.stamped, (row: unknown) =>
					typeof row === "object" && row !== null && "item" in row && "n" in row && "stage" in row
						? `${String(row.item)} ${String(row.n)} ${String(row.stage)}`
						: "unread"
				)
			: ["no read-back"]
	const expected = Arr.map(stored, (s) => `${s.item} ${s.n} ${s.stage}`)
	return deepEquals(Arr.sort(rows, Order.String), Arr.sort(expected, Order.String))
		? undefined
		: `B reads back the sessions it added at the places stamped: ${Formatter.format(expected)}: ${Formatter.format(rows)}`
}

/** A child's note of an item at its place `n` within the child's item: a place's relation that owns no family. */
export const Note = relation("Note", { child: int4, item: int4, n: place, w: int4 }, [
	"child",
	"item",
	"n"
])

/**
 * The schema of the clearing property: Session and its marks, and Note, which owns no family, each open, mutable inside
 * the unit of a child's item, whose rows the clearer deletes; the role `writer`, which inserts them, and `clearer`,
 * which deletes whole groups of either, an item of a child's sessions with their marks or its notes, by the place's
 * group (write/frontend/instants.ts Removal), a Session's through its owner's units and a Note's by its exact rows, in
 * one login.
 */
export const cleared = (name: string) => {
	const base = schema(
		name,
		[Session, Mark, Note],
		[
			key(on(Session, "child", "item", "stage")),
			ordered(on(Mark, "child", "item", "n", "at"), fin(Session, "marks")),
			unit("Item", { child: int4, item: int4 }),
			mutable(Session),
			mutable(Mark),
			mutable(Note)
		]
	)
	const writer = role(
		base,
		"writer",
		{ Session, Mark, Note },
		{ insert: ["Session", "Mark", "Note"] }
	)
	const clearer = role(
		base,
		"clearer",
		{ Session, Mark, Note },
		{ write: ["Session", "Mark", "Note"] }
	)
	const direct = role(base, "direct", { Session, Mark, Note })
	return {
		schema: base,
		writer,
		clearer,
		direct,
		server: login(base, "server", [writer, clearer], {
			workload: [
				workload(writer, {
					stamp: ChangeSet.empty(base).insert(Session, []),
					note: ChangeSet.empty(base).insert(Note, [])
				}),
				workload(clearer, {
					clear: ChangeSet.empty(base).deleteWhere({
						Session: { child: param("child", int4), item: param("item", int4) }
					}),
					clearNotes: ChangeSet.empty(base).deleteWhere({
						Note: { child: param("child", int4), item: param("item", int4) }
					})
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** The clearing property's installation made once per member, which each case's clone holds. */
export const clearedRig = rigTemplate(import.meta, "cleared", cleared)

/** A clearing case: the relation it clears, each item's places before it, at least one, and the items it clears, at
 * least one. */
export interface Clearing {
	readonly relation: "Session" | "Note"
	readonly heads: { readonly 1: 1 | 2; readonly 2: 1 | 2 }
	readonly cleared: ReadonlyArray<1 | 2>
}

export const clearingGen: Gen<Clearing> = (source) => ({
	relation: source.draw(element(["Session", "Note"] as const)),
	heads: {
		1: source.draw(element([1, 2] as const)),
		2: source.draw(element([1, 2] as const))
	},
	cleared: source.draw(subset([1, 2] as const, { min: 1, max: 2 }))
})

export type ClearingFeature =
	| "an owner's groups cleared"
	| "a plain relation's groups cleared"
	| "one item cleared"
	| "both items cleared"
	| "a cleared item over two places"

export const clearingFeatures = (c: Clearing): ReadonlyArray<ClearingFeature> => [
	c.relation === "Session" ? "an owner's groups cleared" : "a plain relation's groups cleared",
	c.cleared.length === 1 ? "one item cleared" : "both items cleared",
	...(Arr.some(c.cleared, (item) => c.heads[item] === 2)
		? ["a cleared item over two places" as const]
		: [])
]

/** The stored rows of a clearing case's relation: each item's places 0 on, a Session's at stages 100 on nesting no
 * mark, a Note's at 100 on, as SQL row literals. */
export const clearingRows = (c: Clearing): ReadonlyArray<string> =>
	Arr.flatMap([1, 2] as const, (item) =>
		Array.from({ length: c.heads[item] }, (_, n) =>
			c.relation === "Session"
				? `(1, ${item}, ${n}, ${100 + n}, 0)`
				: `(1, ${item}, ${n}, ${100 + n})`
		)
	)
