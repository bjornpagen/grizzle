/** What the property of stream.test.ts reads: its space, model and helpers. */

import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { timerMaxMs, timerMinMs } from "@bjornpagen/grizzle/runtime"
import { defined } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, int, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Stream } from "effect"
import type { ServedCalls } from "#adapter/db/handles.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { answered, paged } from "#compiler/public/workload.ts"
import { listFrame, type SlotEncoders, writeFrame } from "#http/events.ts"
import type { SseEvent } from "#http/sse.ts"
import type { StreamEvent } from "#test/support/event-stream.ts"

const Item = relation("Item", { id: int4, score: int4 }, ["id"])

export const Items = schema("Items", [Item], [mutable(Item), unit("Ranked", { id: int4 })])

/** An item as stored and as a call states it. */
type ItemFact = Readonly<{ id: number; score: number }>

/** The login's members: a read by a floor, an ordered read by its windows, a key, and a put. */
const programs = Object.freeze({
	atLeast: query(Items).rule((r) => {
		const { id, score } = v(Item, "item")
		return r
			.match(Item, { id, score })
			.where(r.ge(score, r.param("floor", int4)))
			.find({ id, score })
	}),
	ranked: paged(
		query(Items)
			.rule((r) => {
				const { id, score } = v(Item, "item")
				return r.match(Item, { id, score }).find({ id, score })
			})
			.orderBy(["score", "desc"])
	),
	item: Item,
	put: ChangeSet.empty(Items).put(Item, [])
})

/**
 * The same members as an operations login serving a serverless route declares them (workload answered): each read
 * answered at its call's instant alone, never live, beside the put, so no member of the login is live and its layer
 * needs no live source.
 */
export const answeredMembers = Object.freeze({
	atLeast: answered(programs.atLeast),
	ranked: answered(programs.ranked),
	item: answered(Item),
	put: programs.put
})

/** One call: a member's input as JSON, which is its host input too, every value an int4's JSON integer. */
type Call =
	| { readonly member: "atLeast"; readonly input: { readonly params: { readonly floor: number } } }
	| {
			readonly member: "ranked"
			readonly input: {
				readonly window: {
					readonly anchor: { readonly kind: "start" | "end" }
					readonly size: number
				}
			}
	  }
	| { readonly member: "item"; readonly input: { readonly params: { readonly id: number } } }
	| { readonly member: "put"; readonly input: { readonly put: ReadonlyArray<ItemFact> } }

/** A case: the stored items, one call, and the heartbeat's interval its handler is built with. */
interface StreamCase {
	readonly stored: ReadonlyArray<ItemFact>
	readonly call: Call
	readonly heartbeatMs: number
}

export type Feature =
	| "a read in its key order"
	| "an ordered read from its start"
	| "an ordered read from its end"
	| "a key"
	| "a write accepted"
	| "a write unchanged"

const ids = Object.freeze(Arr.range(1, 12))

/** Items of distinct ids among `ids`, each with a score. */
const itemsGen =
	(min: number, max: number): Gen<ReadonlyArray<ItemFact>> =>
	(source) =>
		Arr.map(source.draw(shuffled(ids, { min, max })), (id) => ({
			id,
			score: source.draw(int(-3, 3))
		}))

const callGen =
	(stored: ReadonlyArray<ItemFact>): Gen<Call> =>
	(source) => {
		switch (source.draw(element(["atLeast", "ranked", "item", "put"] as const))) {
			case "atLeast":
				return { member: "atLeast", input: { params: { floor: source.draw(int(-3, 3)) } } }
			case "ranked":
				return {
					member: "ranked",
					input: {
						window: {
							anchor: { kind: source.draw(element(["start", "end"] as const)) },
							size: source.draw(int(1, 5))
						}
					}
				}
			case "item":
				return {
					member: "item",
					input: { params: { id: source.draw(element([...ids] as const)) } }
				}
			case "put":
				return {
					member: "put",
					input: {
						put: source.draw(oneOf([constant(Arr.take(stored, 2)), itemsGen(1, 3)]))
					}
				}
		}
	}

/**
 * The heartbeat's interval a case's handler is built with: a Node timer's delay, from the least to the longest, its
 * range's ends or one between. A heartbeat is a comment line, so no answer's events depend on it.
 */
const heartbeatGen: Gen<number> = oneOf<number>([
	constant(timerMinMs),
	constant(timerMaxMs),
	int(timerMinMs, timerMaxMs)
])

export const caseGen: Gen<StreamCase> = (source) => {
	const stored = source.draw(itemsGen(0, 6))
	return {
		stored,
		call: source.draw(callGen(stored)),
		heartbeatMs: source.draw(heartbeatGen)
	}
}

/**
 * Each call feature with the case constructed to reach it, which a case whose turn aims at that pending feature draws
 * (aimed), so the cases of one window aim at distinct pending features: a read in its key order, a key, an ordered
 * read's window from its start or its end, a put of one item at an id the stored items leave free, which no stored item
 * states, so it is accepted, and a put of stored items as stored, so it is unchanged.
 */
export const aims: ReadonlyArray<readonly [Feature, Gen<StreamCase>]> = Arr.map(
	[
		[
			"a read in its key order",
			(): Gen<Call> => (source) => ({
				member: "atLeast",
				input: { params: { floor: source.draw(int(-3, 3)) } }
			})
		],
		[
			"a key",
			(): Gen<Call> => (source) => ({
				member: "item",
				input: { params: { id: source.draw(element([...ids] as const)) } }
			})
		],
		...Arr.map(
			["start", "end"] as const,
			(kind) =>
				[
					kind === "start" ? "an ordered read from its start" : "an ordered read from its end",
					(): Gen<Call> => (source) => ({
						member: "ranked",
						input: { window: { anchor: { kind }, size: source.draw(int(1, 5)) } }
					})
				] as const
		),
		[
			"a write accepted",
			(stored: ReadonlyArray<ItemFact>): Gen<Call> =>
				(source) => {
					const free = Arr.filter(ids, (id) => !Arr.some(stored, (item) => item.id === id))
					return {
						member: "put",
						input: {
							put: [
								{
									id: source.draw(element(Arr.isReadonlyArrayNonEmpty(free) ? free : ids)),
									score: source.draw(int(-3, 3))
								}
							]
						}
					}
				}
		],
		[
			"a write unchanged",
			(stored: ReadonlyArray<ItemFact>): Gen<Call> =>
				() => ({
					member: "put",
					input: { put: Arr.take(stored, 2) }
				})
		]
	] as const,
	([feature, callOf]): readonly [Feature, Gen<StreamCase>] => [
		feature,
		(source) => {
			const stored = source.draw(itemsGen(feature === "a write unchanged" ? 1 : 0, 6))
			return {
				stored,
				call: source.draw(callOf(stored)),
				heartbeatMs: source.draw(heartbeatGen)
			}
		}
	]
)

/** A call's body, `{ params, facts }` and a window's, every member present, `{}` where none. */
export const bodyOf = (call: Call): Json => {
	switch (call.member) {
		case "atLeast":
		case "item":
			return { params: call.input.params, facts: {} }
		case "ranked":
			return { params: {}, facts: {}, window: call.input.window }
		case "put":
			return { params: {}, facts: { put: { Item: call.input.put } } }
	}
}

/** A frame as an event stream carries it: its name, and its data's JSON text. */
const carried = (frame: SseEvent): StreamEvent => ({
	event: frame.event,
	data: jsonText(frame.data)
})

/** The in-process answer of a member's calls to `body`, each event framed as the member's wire spells it. */
export const inProcess = (
	calls: ServedCalls,
	slots: SlotEncoders,
	body: unknown
): Stream.Stream<StreamEvent> => {
	switch (calls.shape) {
		case "list":
			return Stream.map(calls.watch(body), (event) => carried(listFrame(slots, event)))
		case "answeredList":
			return Stream.map(calls.answer(body), (event) => carried(listFrame(slots, event)))
		case "write":
			return Stream.map(calls.watch(body), (event) => carried(writeFrame(slots, event)))
	}
}

/** Whether `stored` holds every item `put` states, as it states it. */
export const holdsAll = (stored: ReadonlyArray<ItemFact>, put: ReadonlyArray<ItemFact>): boolean =>
	Arr.every(put, (item) => Arr.some(stored, (s) => s.id === item.id && s.score === item.score))

/** The feature a read's call exercises. */
export const readFeature = (call: Exclude<Call, { readonly member: "put" }>): Feature => {
	switch (call.member) {
		case "atLeast":
			return "a read in its key order"
		case "item":
			return "a key"
		case "ranked":
			return call.input.window.anchor.kind === "start"
				? "an ordered read from its start"
				: "an ordered read from its end"
	}
}

/** An outcome event's kind, off its data's JSON. */
export const outcomeKind = (event: StreamEvent | undefined): unknown => {
	const data: unknown = trustedJson<unknown>(defined(event, "the outcome event").data)
	return isRecord(data) && isRecord(data["outcome"]) ? data["outcome"]["kind"] : undefined
}

/** The member of the opened role named `name`, as its layer loaded it. */
export const memberNamed = (members: ReadonlyArray<LoadedMember>, name: string): LoadedMember =>
	defined(Option.getOrUndefined(Arr.findFirst(members, (m) => m.name === name)), `member ${name}`)

export const origin = "http://grizzle.invalid"
