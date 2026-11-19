/** What the properties of client.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, constant, element, type Gen, int, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Queue } from "effect"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { ReadState } from "#compiler/live/fold.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Decimal, Money, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { paged } from "#compiler/public/workload.ts"

const Item = relation(
	"Item",
	{
		id: pg.integer,
		big: pg.bigint,
		amount: pg.numeric(12, 2),
		cash: pg.money,
		flag: pg.boolean
	},
	["id"]
)

const Items = schema("Items", [Item], [mutable(Item)])

/** The items' schema under the name `name` an installation is allocated, over the same relation. */
export const itemsNamed = (name: string) => schema(name, [Item], [mutable(Item)])

/** An item as stored and as a call states it. */
type ItemFact = Readonly<{ id: number; big: bigint; amount: Decimal; cash: Money; flag: boolean }>

/** The login's members: a set read by an int8 floor, an ordered read by its windows, a key, and a put. */
export const programs = Object.freeze({
	atLeast: query(Items).rule((r) => {
		const { id, big, amount, cash, flag } = v(Item, "item")
		return r
			.match(Item, { id, big, amount, cash, flag })
			.where(r.ge(big, r.param("floor", pg.bigint)))
			.find({ id, big, amount, cash, flag })
	}),
	ranked: paged(
		query(Items)
			.rule((r) => {
				const { id, big, amount, cash, flag } = v(Item, "item")
				return r.match(Item, { id, big, amount, cash, flag }).find({ id, big, amount, cash, flag })
			})
			.orderBy(["big", "desc"])
	),
	item: Item,
	put: ChangeSet.empty(Items).put(Item, [])
})

/** One call of a member, with the input its program takes. */
type Call =
	| { readonly member: "atLeast"; readonly floor: bigint }
	| { readonly member: "ranked"; readonly from: "start" | "end"; readonly size: number }
	| { readonly member: "item"; readonly id: number }
	| { readonly member: "put"; readonly put: ReadonlyArray<ItemFact> }

/** A case: the stored items, one call, and the items a write commits while a read is live. */
interface ClientCase {
	readonly stored: ReadonlyArray<ItemFact>
	readonly call: Call
	readonly write: ReadonlyArray<ItemFact>
}

export type Feature =
	| "a set read"
	| "an ordered read from its start"
	| "an ordered read from its end"
	| "a key"
	| "an int8 past 2^53"
	| "a write accepted"
	| "a write unchanged"
	| "a live change reaching the client"

const ids = Object.freeze(Arr.range(1, 10))

/** An int8 around zero or past 2^53 in either direction, where a number holds no integer exactly. */
const bigGen: Gen<bigint> = (source) => {
	const scale = source.draw(element([1n, 2n ** 53n, 2n ** 61n] as const))
	return BigInt(source.draw(int(-3, 3))) * scale + BigInt(source.draw(int(0, 3)))
}

/** An item of id `id`, its other fields drawn: a numeric(12, 2) of two fraction digits, a money of minor units. */
const itemGen =
	(id: number): Gen<ItemFact> =>
	(source) => ({
		id,
		big: source.draw(bigGen),
		amount: Decimal.of(`${source.draw(int(-999, 999))}.${source.draw(int(10, 99))}`),
		cash: Money.of(BigInt(source.draw(int(-100_000, 100_000)))),
		flag: source.draw(boolean)
	})

/** Items of distinct ids among `ids`. */
const itemsGen =
	(min: number, max: number): Gen<ReadonlyArray<ItemFact>> =>
	(source) =>
		Arr.map(source.draw(shuffled(ids, { min, max })), (id) => source.draw(itemGen(id)))

const callGen =
	(stored: ReadonlyArray<ItemFact>): Gen<Call> =>
	(source) => {
		switch (source.draw(element(["atLeast", "ranked", "item", "put"] as const))) {
			case "atLeast":
				return { member: "atLeast", floor: source.draw(bigGen) }
			case "ranked":
				return {
					member: "ranked",
					from: source.draw(element(["start", "end"] as const)),
					size: source.draw(int(1, 5))
				}
			case "item":
				return { member: "item", id: source.draw(element([...ids] as const)) }
			case "put":
				return {
					member: "put",
					put: source.draw(oneOf([constant(Arr.take(stored, 2)), itemsGen(1, 3)]))
				}
		}
	}

export const caseGen: Gen<ClientCase> = (source) => {
	const stored = source.draw(itemsGen(0, 6))
	return { stored, call: source.draw(callGen(stored)), write: source.draw(itemsGen(1, 3)) }
}

/**
 * Each write feature with the case constructed to reach it, which a case whose turn aims at the feature draws (aimed),
 * so the cases of one window aim at distinct pending features: a put of one item whose id the stored items leave free,
 * which no stored item states, so it is accepted; or a put of stored items exactly as stored, so it is unchanged.
 */
export const aims: ReadonlyArray<readonly [Feature, Gen<ClientCase>]> = [
	[
		"a write accepted",
		(source) => {
			const stored = source.draw(itemsGen(0, 6))
			const free = Arr.filter(ids, (id) => !Arr.some(stored, (item) => item.id === id))
			const id = source.draw(element(Arr.isReadonlyArrayNonEmpty(free) ? free : ids))
			return {
				stored,
				call: { member: "put", put: [source.draw(itemGen(id))] },
				write: source.draw(itemsGen(1, 3))
			}
		}
	],
	[
		"a write unchanged",
		(source) => {
			const stored = source.draw(itemsGen(1, 6))
			return {
				stored,
				call: { member: "put", put: Arr.take(stored, 2) },
				write: source.draw(itemsGen(1, 3))
			}
		}
	]
]

/** Whether two items state one fact. */
const sameItem = (a: ItemFact, b: ItemFact): boolean =>
	a.id === b.id &&
	a.big === b.big &&
	a.amount.equals(b.amount) &&
	a.cash.minorUnits === b.cash.minorUnits &&
	a.flag === b.flag

/** Whether `stored` holds every item `put` states, as it states it. */
export const holdsAll = (stored: ReadonlyArray<ItemFact>, put: ReadonlyArray<ItemFact>): boolean =>
	Arr.every(put, (item) => Arr.some(stored, (s) => sameItem(s, item)))

/** An id no drawn item takes. */
const sentinelId = 11

/**
 * The largest and the least int8, the bounds of the sentinel's `big`: past every value bigGen draws, whose magnitude is
 * at most 3 * 2^61 + 3, so the sentinel meets any drawn floor and enters an ordered window from either end.
 */
const int8Max = 2n ** 63n - 1n

const int8Min = -(2n ** 63n)

/**
 * The items a live read's next batch must show, beside the case's drawn write: a set read's new item above every
 * floor, a key's own item changed, an ordered read's new item first in its order from the start and last from the
 * end. A drawn item of the key's id is left out of the write, which puts each key once.
 */
export const visibleWrite = (
	call: Call,
	write: ReadonlyArray<ItemFact>,
	seen: ItemFact
): ReadonlyArray<ItemFact> => {
	switch (call.member) {
		case "atLeast":
			return [...write, { ...seen, id: sentinelId, big: int8Max }]
		case "item":
			return [
				...Arr.filter(write, (item) => item.id !== call.id),
				{ ...seen, id: call.id, flag: !seen.flag }
			]
		case "ranked":
			return [...write, { ...seen, id: sentinelId, big: call.from === "start" ? int8Max : int8Min }]
		case "put":
			return write
	}
}

/** The member of the opened role named `name`, as its layer loaded it. */
export const memberNamed = (members: ReadonlyArray<LoadedMember>, name: string): LoadedMember =>
	defined(Option.getOrUndefined(Arr.findFirst(members, (m) => m.name === name)), `member ${name}`)

/** The in-process events of a read up to and including their next `ready`, taken from `events`. */
export const untilReady = <E extends { readonly kind: string }>(
	events: Queue.Queue<E>
): Effect.Effect<ReadonlyArray<E>> =>
	Effect.gen(function* () {
		const batch: Array<E> = []
		let ready = false
		while (!ready) {
			const event = yield* Queue.take(events)
			if (event.kind === "error" || event.kind === "end") {
				return yield* Effect.die(
					`a live read's events end before their next ready: ${Formatter.format(event)}`
				)
			}
			batch.push(event)
			ready = event.kind === "ready"
		}
		return batch
	})

/** A read state's value, which a state folded to a `ready` holds. */
export const readyRows = <S extends "set" | "list">(
	state: ReadState<S, object>
): ReadonlyArray<object> => {
	if (state.kind !== "ready") {
		return assert.fail(`a read folded to its ready holds its value, not ${state.kind}`)
	}
	return [...state.value]
}

export const origin = "http://grizzle.invalid"
