/**
 * The client over HTTP answers what the in-process calls answer (packages/grizzle/src/client): over a schema of items
 * whose fields are an int4 key, an int8, a numeric(12, 2), a money and a boolean, its stored items and every call drawn,
 * installed and served as an application deploys it (test/support/install-migrate.ts installGenerated: drafted with
 * its login's served workload, so its installation's live source routes the reads; its served file, its DbLayer given
 * that source, the HTTP handler over the layer), each case
 * calls one member of the login's role both ways: through the typed client, clientOf<typeof Login> over the login's
 * OpenAPI document and handlerClient(handler), and through the same layer's in-process calls (adapter/db/handles.ts
 * memberCalls), the oracle:
 *
 * - A read, a set read by a drawn int8 floor, a key by a drawn id, an ordered read's window from either end: its once is
 *   the in-process once, row for row and value for value (a bigint as a bigint, a Decimal and a Money as themselves), a
 *   set read's rows in any order and an ordered read's in order; and its watch's first value is the in-process watch's
 *   events folded to their first `ready` (live/fold.ts fold), and, after a write committed in-process that the read
 *   sees, its next value is them folded to their next `ready`.
 * - A write, a put of drawn items: its once is accepted exactly when some item it puts is not stored as it states it,
 *   and the same put again in-process is unchanged.
 *
 * Plants (~/.cache/grizzle-release/LIVE-CLIENT/plants): client-int8-decoded-as-number (live/wire.ts carrierWire.int8
 * decoding an int8 as a number), client-watch-every-event (watch's value taken at every event, before `ready`).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, int, oneOf, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Queue, Stream } from "effect"
import { HttpClient } from "effect/http"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import { clientOf } from "#client/client.ts"
import { handlerClient } from "#client/handler.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { ListEvent, SetEvent } from "#compiler/live/events.ts"
import { fold, opening, type ReadState } from "#compiler/live/fold.ts"
import { openApiText } from "#compiler/live/openapi.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Decimal, Money, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { paged } from "#compiler/public/workload.ts"
import { httpHandler } from "#http/index.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { installGenerated, loadMigrated } from "#test/support/install-migrate.ts"
import { caseHang, testTimeout } from "#test/support/limits.ts"
import { servedFixtureOf } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld } from "#test/support/worlds.ts"

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
const itemsNamed = (name: string) => schema(name, [Item], [mutable(Item)])

/** An item as stored and as a call states it. */
type ItemFact = Readonly<{ id: number; big: bigint; amount: Decimal; cash: Money; flag: boolean }>

/** The login's members: a set read by an int8 floor, an ordered read by its windows, a key, and a put. */
const programs = Object.freeze({
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

type Feature =
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

const caseGen: Gen<ClientCase> = (source) => {
	const stored = source.draw(itemsGen(0, 6))
	return { stored, call: source.draw(callGen(stored)), write: source.draw(itemsGen(1, 3)) }
}

/** Whether two items state one fact. */
const sameItem = (a: ItemFact, b: ItemFact): boolean =>
	a.id === b.id &&
	a.big === b.big &&
	a.amount.equals(b.amount) &&
	a.cash.minorUnits === b.cash.minorUnits &&
	a.flag === b.flag

/** Whether `stored` holds every item `put` states, as it states it. */
const holdsAll = (stored: ReadonlyArray<ItemFact>, put: ReadonlyArray<ItemFact>): boolean =>
	Arr.every(put, (item) => Arr.some(stored, (s) => sameItem(s, item)))

/** An id no drawn item takes. */
const sentinelId = 11

/**
 * The items a live read's next batch must show, beside the case's drawn write: a set read's new item above every
 * floor, a key's own item changed, an ordered read's new item first in its order from the start and last from the
 * end. A drawn item of the key's id is left out of the write, which puts each key once.
 */
const visibleWrite = (
	call: Call,
	write: ReadonlyArray<ItemFact>,
	seen: ItemFact
): ReadonlyArray<ItemFact> => {
	switch (call.member) {
		case "atLeast":
			return [...write, { ...seen, id: sentinelId, big: 2n ** 62n }]
		case "item":
			return [
				...Arr.filter(write, (item) => item.id !== call.id),
				{ ...seen, id: call.id, flag: !seen.flag }
			]
		case "ranked":
			return [
				...write,
				{ ...seen, id: sentinelId, big: call.from === "start" ? 2n ** 62n : -(2n ** 62n) }
			]
		case "put":
			return write
	}
}

/** The member of the opened role named `name`, as its layer loaded it. */
const memberNamed = (members: ReadonlyArray<LoadedMember>, name: string): LoadedMember =>
	defined(Option.getOrUndefined(Arr.findFirst(members, (m) => m.name === name)), `member ${name}`)

/** The in-process events of a read up to and including their next `ready`, taken from `events`. */
const untilReady = <E extends { readonly kind: string }>(
	events: Queue.Queue<E>
): Effect.Effect<ReadonlyArray<E>> =>
	Effect.gen(function* () {
		const batch: Array<E> = []
		let ready = false
		while (!ready) {
			const event = yield* Queue.take(events)
			batch.push(event)
			ready = event.kind === "ready"
		}
		return batch
	})

/** A read state's value, which a state folded to a `ready` holds. */
const readyRows = <S extends "set" | "list">(
	state: ReadState<S, object>
): ReadonlyArray<object> => {
	if (state.kind !== "ready") {
		return assert.fail(`a read folded to its ready holds its value, not ${state.kind}`)
	}
	return [...state.value]
}

const origin = "http://grizzle.invalid"

layer(Substrate.layer, { excludeTestServices: true })("the client over HTTP", (it) => {
	it.effect("answers what the in-process calls answer, values exactly as they are", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "the same layer's in-process calls of the member (adapter/db/handles.ts memberCalls) and the live fold"
					},
					suite: "pg/client/client",
					draw: drawn((source) => source.draw(caseGen)),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a set read",
							"an ordered read from its start",
							"an ordered read from its end",
							"a key",
							"an int8 past 2^53",
							"a write accepted",
							"a write unchanged",
							"a live change reaching the client"
						],
						{ cases: 24, sense: notesOnly }
					),
					kept: [],
					/** Each case installs the schema over its items and makes its calls. */
					runs: 24,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 4,
					caseHang
				},
				({ stored, call, write }, notes) =>
					Effect.gen(function* () {
						const generated = yield* installGenerated(
							(name) => ({
								schema: itemsNamed(name),
								logins: [fullWorld(itemsNamed(name), programs).server]
							}),
							{ label: "client", ambient: ordinarySession }
						)
						const installed = generated.installed
						yield* loadMigrated(installed, { Item: stored })
						const world = fullWorld(itemsNamed(installed.declared), programs)
						const served = servedFixtureOf(
							installed,
							world.server,
							defined(generated.served.get(world.server.name), "the login's served file")
						)
						const printed = () => Formatter.format({ stored, call, write })
						if (Arr.some(stored, (item) => item.big > 2n ** 53n || item.big < -(2n ** 53n))) {
							notes.note("an int8 past 2^53")
						}
						const login = served.login
						yield* Effect.gen(function* () {
							const handler = yield* httpHandler({
								logins: [login],
								heartbeatMs: testTimeout.value
							})
							const text = openApiText(login.file)
							if (!text.ok) {
								return assert.fail(`the login's document is written\n${printed()}`)
							}
							const client = clientOf<typeof world.server>(
								trustedJson<unknown>(text.value),
								world.server.name,
								{
									url: new URL(origin)
								}
							)
							const overHttp = Effect.provideService(HttpClient.HttpClient, handlerClient(handler))
							const opened = yield* openServed(login.roles.app, {})
							const local = (name: string): ServedCalls =>
								memberCalls(opened.ctx, memberNamed(opened.role.members, name))
							const put = local("put")
							if (put.shape !== "write") {
								return assert.fail("the put member is a write")
							}
							if (call.member === "put") {
								const input = { params: {}, facts: { put: { Item: call.put } } }
								const outcome = yield* overHttp(client.app.put.once(input))
								const accepted = !holdsAll(stored, call.put)
								notes.note(accepted ? "a write accepted" : "a write unchanged")
								assert.equal(outcome.kind, accepted ? "accepted" : "unchanged", printed())
								const again = yield* put.once(input)
								assert.equal(
									again.kind,
									"unchanged",
									`the same put again changes nothing\n${printed()}`
								)
								return
							}
							const seen = defined(stored[0] ?? write[0], "an item")
							const writeVisible = put.once({
								params: {},
								facts: { put: { Item: visibleWrite(call, write, seen) } }
							})
							yield* Effect.scoped(
								Effect.gen(function* () {
									switch (call.member) {
										case "atLeast":
										case "item": {
											notes.note(call.member === "atLeast" ? "a set read" : "a key")
											const here = local(call.member)
											if (here.shape !== "set") {
												return assert.fail(`${call.member} is a set read`)
											}
											const input =
												call.member === "atLeast"
													? { params: { floor: call.floor }, facts: {} }
													: { params: { id: call.id }, facts: {} }
											const remoteOnce =
												call.member === "atLeast"
													? yield* overHttp(
															client.app.atLeast.once({ params: { floor: call.floor }, facts: {} })
														)
													: yield* overHttp(
															client.app.item.once({ params: { id: call.id }, facts: {} })
														)
											const localOnce = yield* here.once(input)
											const remoteRows: ReadonlyArray<object> = [...remoteOnce]
											unorderedEqual(remoteRows, [...localOnce], `once\n${printed()}`)
											const values = yield* Queue.unbounded<ReadonlyArray<object>>()
											const watched =
												call.member === "atLeast"
													? client.app.atLeast.watch({ params: { floor: call.floor }, facts: {} })
													: client.app.item.watch({ params: { id: call.id }, facts: {} })
											yield* Effect.forkScoped(
												Stream.runForEach(watched, (w) => Queue.offer(values, [...w.value])).pipe(
													overHttp
												)
											)
											const events = yield* Queue.unbounded<SetEvent<object>>()
											yield* Effect.forkScoped(
												Stream.runForEach(here.watch(input), (e) => Queue.offer(events, e))
											)
											const firstBatch = yield* untilReady(events)
											const firstLocal = fold(opening("set"), firstBatch)
											const firstRemote = yield* Queue.take(values)
											unorderedEqual(
												firstRemote,
												readyRows(firstLocal),
												`first value\n${printed()}`
											)
											yield* writeVisible
											const nextBatch = yield* untilReady(events)
											const nextLocal = fold(firstLocal, nextBatch)
											const nextRemote = yield* Queue.take(values)
											unorderedEqual(nextRemote, readyRows(nextLocal), `next value\n${printed()}`)
											notes.note("a live change reaching the client")
											return
										}
										case "ranked": {
											notes.note(
												call.from === "start"
													? "an ordered read from its start"
													: "an ordered read from its end"
											)
											const here = local("ranked")
											if (here.shape !== "list") {
												return assert.fail("ranked is an ordered read")
											}
											const input = {
												params: {},
												facts: {},
												window: { anchor: { kind: call.from }, size: call.size }
											}
											const remoteOnce = yield* overHttp(client.app.ranked.once(input))
											const localOnce = yield* here.once(input)
											const remoteRows: ReadonlyArray<object> = [...remoteOnce]
											assert.deepEqual(remoteRows, [...localOnce], `once\n${printed()}`)
											const values = yield* Queue.unbounded<ReadonlyArray<object>>()
											yield* Effect.forkScoped(
												Stream.runForEach(client.app.ranked.watch(input), (w) =>
													Queue.offer(values, [...w.value])
												).pipe(overHttp)
											)
											const events = yield* Queue.unbounded<ListEvent<object>>()
											yield* Effect.forkScoped(
												Stream.runForEach(here.watch(input), (e) => Queue.offer(events, e))
											)
											const firstBatch = yield* untilReady(events)
											const firstLocal = fold(opening("list"), firstBatch)
											const firstRemote = yield* Queue.take(values)
											assert.deepEqual(
												firstRemote,
												readyRows(firstLocal),
												`first value\n${printed()}`
											)
											yield* writeVisible
											const nextBatch = yield* untilReady(events)
											const nextLocal = fold(firstLocal, nextBatch)
											const nextRemote = yield* Queue.take(values)
											assert.deepEqual(nextRemote, readyRows(nextLocal), `next value\n${printed()}`)
											notes.note("a live change reaching the client")
											return
										}
									}
								})
							)
						}).pipe(withLayer(served.layer))
					}).pipe(Effect.scoped, Effect.orDie)
			)
		)
	)
})
