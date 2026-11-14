/**
 * A call over HTTP answers the events the in-process call answers, and a client that goes away leaves nothing behind.
 * Over a schema of scored items, its stored items and every call drawn, served as an application serves it (its
 * committed file, its DbLayer, and the HTTP handler over the layer, http/handler.ts httpHandler), each case calls one
 * member of the login's role both ways, through the handler and through the same layer's in-process calls
 * (adapter/db/handles.ts memberCalls), the oracle:
 *
 * - A read, a set read by a drawn floor, a key by a drawn id, an ordered read's window from either end: its answer up to
 *   `ready` over HTTP is the in-process watch's, frame for frame as the member's wire spells each event (http/events.ts),
 *   a set read's upserts in any order, an ordered read's in order; then a drawn write committed in-process, and both
 *   answers' next batches up to their `ready` are again one batch.
 * - A write, a put of drawn items: its answer over HTTP is its outcome, then `end`, accepted exactly when some item it
 *   puts is not stored as it states it, and the same put again in-process is unchanged.
 * - Disconnect: the HTTP answer's body cancelled while its read is live, and the in-process read stopped with it,
 *   every session of the login's pool comes back, none leased, read after each release pg's pool reports, so the call
 *   released what it held; one it never released leaves the case waiting, which the hang guard reports.
 * - Before a read's first call, its in-process watch is called until it settles at its ready, each refusal before that
 *   `unavailable` and safe to call again (test/support/live/standing.ts): a fresh installation's first live
 *   registrations meet no replication slot until its leader makes one, and a caller calls again. The in-process read's
 *   events ending before their next ready fail the case, never wait.
 *
 * Every answer is read as WHATWG HTML reads an event stream (test/support/event-stream.ts), never through the
 * server's framing. A case whose turn aims at a pending call feature runs one constructed to reach it (aimedCase), so the
 * label-fixed streams reach every kind of call.
 *
 * Plants (~/.cache/grizzle-release/LIVE-HTTP/plants): http-buffered.patch (the answer's events collected before the
 * body is written: a live read's first upsert never reaches its client, the case hangs and fails).
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { constant, element, type Gen, int, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Deferred, Effect, Formatter, Option, Queue, Result, Stream } from "effect"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { slotEncoders, wireText } from "#compiler/plan/runtime.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { paged } from "#compiler/public/workload.ts"
import { listFrame, setFrame, type SlotEncoders, writeFrame } from "#http/events.ts"
import { httpHandler } from "#http/index.ts"
import type { SseEvent } from "#http/sse.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { holdsCount, openStream, readStream, type StreamEvent } from "#test/support/event-stream.ts"
import { caseHang, nodeTimerMax, nodeTimerMin } from "#test/support/limits.ts"
import { standing } from "#test/support/live/standing.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const Item = relation("Item", { id: pg.integer, score: pg.integer }, ["id"])
const Items = schema("Items", [Item], [mutable(Item)])

/** An item as stored and as a call states it. */
type ItemFact = Readonly<{ id: number; score: number }>

/** The login's members: a set read by a floor, an ordered read by its windows, a key, and a put. */
const programs = Object.freeze({
	atLeast: query(Items).rule((r) => {
		const { id, score } = v(Item, "item")
		return r
			.match(Item, { id, score })
			.where(r.ge(score, r.param("floor", pg.integer)))
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

/**
 * A case: the stored items, one call, the write committed while a read is live, and the heartbeat's interval its
 * handler is built with.
 */
interface StreamCase {
	readonly stored: ReadonlyArray<ItemFact>
	readonly call: Call
	readonly write: ReadonlyArray<ItemFact>
	readonly heartbeatMs: number
}

type Feature =
	| "a set read"
	| "an ordered read from its start"
	| "an ordered read from its end"
	| "a key"
	| "a write accepted"
	| "a write unchanged"
	| "a live change reaching both answers"
	| "a disconnect while live"
	| "a read called again once the slot stood"

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
	constant(nodeTimerMin.value),
	constant(nodeTimerMax.value),
	int(nodeTimerMin.value, nodeTimerMax.value)
])

const caseGen: Gen<StreamCase> = (source) => {
	const stored = source.draw(itemsGen(0, 6))
	return {
		stored,
		call: source.draw(callGen(stored)),
		write: source.draw(itemsGen(1, 3)),
		heartbeatMs: source.draw(heartbeatGen)
	}
}

/**
 * Each call feature with the case constructed to reach it, drawn on the case's own tape: a set read, a key, an ordered
 * read's window from its start or its end, a put of one item at an id the stored items leave free, which no stored item
 * states, so it is accepted, and a put of stored items as stored, so it is unchanged.
 */
const aims: ReadonlyArray<readonly [Feature, Gen<StreamCase>]> = Arr.map(
	[
		[
			"a set read",
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
				write: source.draw(itemsGen(1, 3)),
				heartbeatMs: source.draw(heartbeatGen)
			}
		}
	]
)

/**
 * The case a property runs: its drawn one, or, where its turn aims at a pending call feature (Case.steering), one
 * constructed to reach it, drawn on the case's own tape, so the cases of one window aim at distinct pending features.
 */
const aimedCase = (drawnCase: StreamCase, k: Case<Feature>): StreamCase => {
	const pending = Option.getOrUndefined(k.steering)
	const aim = Arr.findFirst(aims, ([feature]) => pending?.aimed(feature) === true)
	return Option.isNone(aim) ? drawnCase : k.draw(aim.value[1])
}

/** A call's body, `{ params, facts }` and a window's, every member present, `{}` where none. */
const bodyOf = (call: Call): Json => {
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
	data: wireText(frame.data)
})

/** The in-process answer of a member's calls to `body`, each event framed as the member's wire spells it. */
const inProcess = (
	calls: ServedCalls,
	slots: SlotEncoders,
	body: unknown
): Stream.Stream<StreamEvent> => {
	switch (calls.shape) {
		case "set":
			return Stream.map(calls.watch(body), (event) => carried(setFrame(slots, event)))
		case "list":
			return Stream.map(calls.watch(body), (event) => carried(listFrame(slots, event)))
		case "instantSet":
			return Stream.map(calls.answer(body), (event) => carried(setFrame(slots, event)))
		case "instantList":
			return Stream.map(calls.answer(body), (event) => carried(listFrame(slots, event)))
		case "write":
			return Stream.map(calls.watch(body), (event) => carried(writeFrame(slots, event)))
	}
}

/** The events from `from` through the `count`th `ready` at or after it: one batch of an answer. */
const batch = (
	events: ReadonlyArray<StreamEvent>,
	from: number,
	count: number
): ReadonlyArray<StreamEvent> => {
	const readies = Arr.filterMap(events, (e, place) =>
		e.event === "ready" && place >= from ? Result.succeed(place) : Result.failVoid
	)
	return events.slice(from, defined(readies[count - 1], `ready ${count}`) + 1)
}

/** That two batches are one: a set read's in any order, an ordered read's in order. */
const sameBatch = (
	shape: "set" | "list",
	http: ReadonlyArray<StreamEvent>,
	local: ReadonlyArray<StreamEvent>,
	why: string
): void => (shape === "set" ? unorderedEqual(http, local, why) : assert.deepEqual(http, local, why))

/** Whether `stored` holds every item `put` states, as it states it. */
const holdsAll = (stored: ReadonlyArray<ItemFact>, put: ReadonlyArray<ItemFact>): boolean =>
	Arr.every(put, (item) => Arr.some(stored, (s) => s.id === item.id && s.score === item.score))

/** An id no drawn item takes. */
const sentinelId = 13

/**
 * The item a live read's next batch must show, beside the case's drawn write: a set read's new item above every floor,
 * a key's own item rescored past every drawn score, an ordered read's new item first in its order from the start and
 * last from the end. Every drawn item of the key's id is left out of the write, which puts each key once.
 */
const visibleWrite = (call: Call, write: ReadonlyArray<ItemFact>): ReadonlyArray<ItemFact> => {
	switch (call.member) {
		case "atLeast":
			return [...write, { id: sentinelId, score: 3 }]
		case "item":
			return [
				...Arr.filter(write, (item) => item.id !== call.input.params.id),
				{ id: call.input.params.id, score: 4 }
			]
		case "ranked":
			return [
				...write,
				{ id: sentinelId, score: call.input.window.anchor.kind === "start" ? 4 : -4 }
			]
		case "put":
			return write
	}
}

/** The feature a read's call exercises. */
const readFeature = (call: Exclude<Call, { readonly member: "put" }>): Feature => {
	switch (call.member) {
		case "atLeast":
			return "a set read"
		case "item":
			return "a key"
		case "ranked":
			return call.input.window.anchor.kind === "start"
				? "an ordered read from its start"
				: "an ordered read from its end"
	}
}

/** An outcome event's kind, off its data's JSON. */
const outcomeKind = (event: StreamEvent | undefined): unknown => {
	const data: unknown = trustedJson<unknown>(defined(event, "the outcome event").data)
	return isRecord(data) && isRecord(data["outcome"]) ? data["outcome"]["kind"] : undefined
}

/** The member of the opened role named `name`, as its layer loaded it. */
const memberNamed = (members: ReadonlyArray<LoadedMember>, name: string): LoadedMember =>
	defined(Option.getOrUndefined(Arr.findFirst(members, (m) => m.name === name)), `member ${name}`)

const origin = "http://grizzle.invalid"

layer(Substrate.layer, { excludeTestServices: true })("a call over HTTP", (it) => {
	it.effect(
		"answers the in-process call's events, and leaves nothing behind when its client goes away",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the same layer's in-process calls of the member (adapter/db/handles.ts memberCalls)"
						},
						suite: "pg/http/stream",
						draw: drawn((source) => source.draw(caseGen)),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a set read",
								"an ordered read from its start",
								"an ordered read from its end",
								"a key",
								"a write accepted",
								"a write unchanged",
								"a live change reaching both answers",
								"a disconnect while live"
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
					(drawnCase, notes) =>
						Effect.gen(function* () {
							const { stored, call, write, heartbeatMs } = aimedCase(drawnCase, notes)
							const o = yield* installed(Items, { Item: stored }, { label: "http", programs })
							const printed = () => Formatter.format({ stored, call, write, heartbeatMs })
							const login = o.served.login
							const role = login.roles.app
							yield* Effect.gen(function* () {
								const handler = yield* httpHandler({ logins: [login], heartbeatMs })
								const opened = yield* openServed(role, {})
								const member = memberNamed(opened.role.members, call.member)
								const calls = memberCalls(opened.ctx, member)
								const slots = slotEncoders(member.wire.member, opened.role.wire.witness, {
									some: Option.some,
									none: Option.none(),
									is: Option.isOption,
									fold: Option.match
								})
								const body = bodyOf(call)
								if (calls.shape === "set" || calls.shape === "list") {
									const live = calls
									if ((yield* standing(() => live.watch(body))) > 0) {
										notes.note("a read called again once the slot stood")
									}
								}
								const response = yield* Effect.promise(() =>
									handler(
										new Request(`${origin}/${login.name}/${role.role}/${call.member}`, {
											method: "POST",
											headers: { "grizzle-wire": member.wire.digest },
											body: jsonText(body)
										})
									)
								)
								const answer: ReadableStream<Uint8Array> | null = response.body
								if (answer === null) {
									return assert.fail("every answer has a body")
								}
								if (call.member === "put") {
									const read = yield* readStream(answer, () => false)
									const accepted = !holdsAll(stored, call.input.put)
									notes.note(accepted ? "a write accepted" : "a write unchanged")
									assert.deepEqual(
										[Arr.map(read.events, (e) => e.event), outcomeKind(read.events[0])],
										[["outcome", "end"], accepted ? "accepted" : "unchanged"],
										`a write answers its outcome, then its end\n${printed()}`
									)
									const again = yield* Stream.runCollect(inProcess(calls, slots, body))
									assert.deepEqual(
										[Arr.map(again, (e) => e.event), outcomeKind(again[0])],
										[["outcome", "end"], "unchanged"],
										`the same put again in-process changes nothing\n${printed()}`
									)
									return
								}
								notes.note(readFeature(call))
								const shape = calls.shape
								if (shape !== "set" && shape !== "list") {
									return assert.fail(
										`member ${call.member}'s calls are a live read's\n${printed()}`
									)
								}
								const local = yield* Queue.unbounded<StreamEvent>()
								const pool = opened.sessions.pool
								const release = { next: Deferred.makeUnsafe<void>() }
								pool.native.on("release", () => {
									const released = release.next
									release.next = Deferred.makeUnsafe<void>()
									Deferred.doneUnsafe(released, Effect.void)
								})
								/** Every lease of the pool released: its count read after each release pg reports, never a timer. */
								const allReleased: Effect.Effect<void> = Effect.suspend(() => {
									const next = release.next
									return Effect.flatMap(pool.leased, (leased) =>
										leased === 0 ? Effect.void : Effect.andThen(Deferred.await(next), allReleased)
									)
								})
								const localUntil = (count: number) =>
									Effect.gen(function* () {
										const events: Array<StreamEvent> = []
										while (Arr.filter(events, (e) => e.event === "ready").length < count) {
											const event = yield* Queue.take(local)
											if (event.event === "error" || event.event === "end") {
												return yield* Effect.die(
													`the in-process read ends before its next ready: ${Formatter.format(events.concat(event))}\n${printed()}`
												)
											}
											events.push(event)
										}
										return events
									})
								yield* Effect.scoped(
									Effect.gen(function* () {
										yield* Effect.forkScoped(
											Stream.runForEach(inProcess(calls, slots, body), (e) => Queue.offer(local, e))
										)
										const http = yield* openStream(answer)
										const first = yield* http.until(holdsCount("ready", 1))
										const localFirst = yield* localUntil(1)
										sameBatch(
											shape,
											batch(first.events, 0, 1),
											localFirst,
											`the answers up to ready are one\n${printed()}`
										)
										const put = memberCalls(opened.ctx, memberNamed(opened.role.members, "put"))
										if (put.shape !== "write") {
											return assert.fail("the put member is a write")
										}
										yield* Stream.runDrain(
											put.watch({ params: {}, facts: { put: { Item: visibleWrite(call, write) } } })
										)
										const second = yield* http.until(holdsCount("ready", 2))
										const localSecond = yield* localUntil(1)
										sameBatch(
											shape,
											batch(second.events, first.events.length, 1),
											localSecond,
											`the answers' batches after the write are one\n${printed()}`
										)
										notes.note("a live change reaching both answers")
									})
								)
								yield* allReleased
								notes.note("a disconnect while live")
							}).pipe(withLayer(o.served.layer))
						}).pipe(Effect.scoped, Effect.orDie)
				)
			)
	)
})
