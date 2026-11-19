/** What the property of places.test.ts reads: its schema, its space, its model and its helpers. */

import { deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { constant, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, place } from "#compiler/public/fields.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

export const Session = relation(
	"Session",
	{ child: pg.integer, item: pg.integer, n: place.by("stage"), stage: pg.integer },
	["child", "item", "n"]
)

/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
export const Gate = relation("Gate", { n: pg.integer }, ["n"])

/** The schema, the role `writer`, which inserts Session and Gate and nothing else, and its two logins. */
export const places = (name: string) => {
	const base = schema(name, [Session, Gate], [key(on(Session, "child", "item", "stage"))])
	const writer = role(base, "writer", { Session, Gate }, { insert: ["Session", "Gate"] })
	const direct = role(base, "direct", { Session, Gate })
	return {
		schema: base,
		writer,
		direct,
		server: login(base, "server", [writer], {
			workload: [
				workload(writer, {
					stamp: ChangeSet.empty(base).insert(Session, []),
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

export interface Placing {
	readonly mode: Mode
	readonly heads: { readonly 1: Head; readonly 2: Head }
	readonly a: Items
	readonly b: Items
}

export type PlaceFeature =
	| "an item over no place"
	| "an item over one place"
	| "an item over two places"
	| "an item both calls stamp, concurrently"
	| "an item both calls stamp, in turn"
	| "B waited for A at a key"
	| "B retried after A committed"
	| "two items in one call"

const itemsGen: Gen<Items> = element([[1], [2], [1, 2]] as const)

export const placingGen: Gen<Placing> = (source) => ({
	mode: source.draw(element(["concurrent", "sequential"] as const)),
	heads: {
		1: source.draw(element([0, 1, 2] as const)),
		2: source.draw(element([0, 1, 2] as const))
	},
	a: source.draw(itemsGen),
	b: source.draw(itemsGen)
})

/** A case constructed to reach B waiting for A at a key and its retry: both stamping item 1, concurrently. */
export const aims: ReadonlyArray<readonly [Reached<PlaceFeature>, Gen<Placing>]> = [
	[
		"B waited for A at a key",
		constant<Placing>({ mode: "concurrent", heads: { 1: 1, 2: 0 }, a: [1], b: [1] })
	]
]

/** Whether A and B stamp one item, which in `concurrent` B waits for A at. */
export const meets = (c: Placing): boolean => Arr.some(c.a, (item) => Arr.contains(c.b, item))

/** The stage a call's row at `item` states: A's 10 + item, B's 20 + item, a stored row's 100 on. */
const stageOf = (call: "A" | "B", item: 1 | 2): number => (call === "A" ? 10 : 20) + item

/** A call's rows: one at each of its items, of child 1, at its stage. */
export const callRows = (call: "A" | "B", items: Items) =>
	Arr.map(items, (item) => ({ child: 1, item, stage: stageOf(call, item) }))

/** The stored rows of a case's heads: each item's places 0 on, at stages 100 on, as SQL row literals. */
export const seededRows = (c: Placing): ReadonlyArray<string> =>
	Arr.flatMap([1, 2] as const, (item) =>
		Array.from({ length: c.heads[item] }, (_, n) => `(1, ${item}, ${n}, ${100 + n})`)
	)

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
