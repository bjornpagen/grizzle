import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Deferred, Effect, Fiber, Formatter, Option, Queue, Stream } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { slotEncoders } from "#compiler/plan/runtime.ts"
import { httpAnswers } from "#http/handler.ts"
import {
	aims,
	batch,
	bodyOf,
	caseGen,
	type Feature,
	holdsAll,
	inProcess,
	Items,
	memberNamed,
	origin,
	outcomeKind,
	programs,
	readFeature,
	sameBatch,
	visibleWrite
} from "#test/pg/http/stream.fixtures.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { holdsCount, openStream, readStream, type StreamEvent } from "#test/support/event-stream.ts"
import { standing } from "#test/support/live/standing.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A call over HTTP answers the in-process call's events, and leaves nothing behind when its client goes away.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/http/stream.test.ts at d8eed1786).
 */
export const aCallOverHTTPAnswersTheInProcessCallsEventsAndLeavesNothingBehindWhenItsClientGoesAway =
	property.explore(aimed(caseGen, aims), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a set read",
			"an ordered read from its start",
			"an ordered read from its end",
			"a key",
			"a write accepted",
			"a write unchanged",
			"a live change reaching both answers",
			"a disconnect while live"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, notes: Case<Feature>) =>
			({ stored, call, write, heartbeatMs }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const o = yield* installed(Items, { Item: stored }, { label: "http", programs })
						const printed = () => Formatter.format({ stored, call, write, heartbeatMs })
						const login = o.served.login
						const role = login.roles.app
						yield* Effect.gen(function* () {
							const answers = yield* httpAnswers({ logins: [login], heartbeatMs })
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
								yield* standing(live.watch(body))
							}
							const handled = answers(
								new Request(`${origin}/${login.name}/${role.role}/${call.member}`, {
									method: "POST",
									headers: { "grizzle-wire": member.wire.digest },
									body: jsonText(body)
								})
							)
							const answer: ReadableStream<Uint8Array> | null = handled.response.body
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
								return assert.fail(`member ${call.member}'s calls are a live read's\n${printed()}`)
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
								return Effect.flatMap(pool.state, ({ leased }) =>
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
									const reading = yield* Effect.forkScoped(http.until(holdsCount("ready", 1)))
									const localFirst = yield* localUntil(1)
									yield* handled.pending(localFirst.length)
									const written = yield* handled.written
									assert.equal(
										written,
										localFirst.length,
										`the frames written to the body once the handler has taken the read's first batch from its call and asks for more\n${printed()}`
									)
									const first = yield* Fiber.join(reading)
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
					}).pipe(Effect.scoped, Effect.orDie),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the same layer's in-process calls of the member (adapter/db/handles.ts memberCalls)"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: []
	})
