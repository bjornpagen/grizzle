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
 * - Before a read's first call, its in-process watch is called until it settles at its ready, each refusal before that
 *   `unavailable` and safe to call again (standing): a fresh installation's first live registration meets no
 *   replication slot until the live leader it starts makes one, and its caller calls again, as the contract says. Over
 *   HTTP a read's once is its watch's first value, so it registers live too. A refusal of any other kind fails the case.
 *
 * A case whose turn aims at a pending write feature is drawn constructed to reach it (aimed, aims): a put of an item no
 * stored item states, or a put of stored items as stored, so the label-fixed streams reach both.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Queue, Result, Stream } from "effect"
import { HttpClient } from "effect/http"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { clientOf } from "#client/client.ts"
import { handlerClient } from "#client/handler.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { ListEvent, SetEvent } from "#compiler/live/events.ts"
import { fold, opening } from "#compiler/live/fold.ts"
import { openApiText } from "#compiler/live/openapi.ts"
import { httpHandler } from "#http/index.ts"
import {
	aims,
	caseGen,
	type Feature,
	holdsAll,
	itemsNamed,
	memberNamed,
	origin,
	programs,
	readyRows,
	untilReady,
	visibleWrite
} from "#test/pg/client/client.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { installGenerated, loadMigrated } from "#test/support/install-migrate.ts"
import { hangLimit } from "#test/support/limits.ts"
import { standing } from "#test/support/live/standing.ts"
import { servedFixtureOf } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The client over HTTP answers what the in-process calls answer, values exactly as they are.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/client/client.test.ts at d8eed1786).
 */
export const theClientOverHTTPAnswersWhatTheInProcessCallsAnswerValuesExactlyAsTheyAre =
	property.explore(aimed(caseGen, aims), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a set read",
			"an ordered read from its start",
			"an ordered read from its end",
			"a key",
			"an int8 past 2^53",
			"a write accepted",
			"a write unchanged",
			"a live change reaching the client"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, notes: Case<Feature>) =>
			({ stored, call, write }) =>
				Effect.provideServiceEffect(
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
								heartbeatMs: hangLimit
							})
							const text = openApiText(login.file)
							if (!text.ok) {
								return assert.fail(`the login's document is written\n${printed()}`)
							}
							const clientRead = clientOf<typeof world.server>(
								trustedJson<unknown>(text.value),
								world.server.name,
								{
									url: new URL(origin)
								}
							)
							if (Result.isFailure(clientRead)) {
								return assert.fail(`the login's own document opens its client\n${printed()}`)
							}
							const client = clientRead.success
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
											if ((yield* standing(() => here.watch(input))) > 0) {
												notes.note("a watch called again once the slot stood")
											}
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
											if ((yield* standing(() => here.watch(input))) > 0) {
												notes.note("a watch called again once the slot stood")
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
					}).pipe(Effect.scoped, Effect.orDie),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the same layer's in-process calls of the member (adapter/db/handles.ts memberCalls) and the live fold"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: []
	})
