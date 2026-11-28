/**
 * A layer's own services (packages/grizzle/src/adapter/services.ts ownServices): what a layer does for no one caller
 * runs under the services it was built in, the span it was built in left behind, and what a caller asks for itself runs
 * under the caller's.
 *
 * - The installation's live source, which a process's first watch opens and every later watch shares
 *   (adapter/live/subscriptions.ts), opens under the layer's services: the Caller the build provided, and no span, the
 *   build's or any watch's, over drawn rounds of watches, each round's source lost at its end so the next round's
 *   first watch opens it again. Each watch's own read runs under that watch's Caller and span.
 * - A Db's call runs for the caller that makes it, its lease's connection attempt and the password that attempt runs
 *   among its work: Db.open's call under its caller's span and Caller; an HTTP request's, which comes from outside any
 *   fiber, under the handler's services, the Caller its build provided, and under no span, the handler's build's or
 *   any caller's (http/handler.ts httpAnswers), over drawn sequences of doors, each call's attempt refused by its
 *   password, past which nothing runs.
 *
 * Oracle: the specification, services.ts's: the caller each piece of work runs for.
 *
 * Features: a source opened by its first watch, a watch joining an open source, a source opened again after one was
 * lost; a Db opened by Db.open, a Db opened by an HTTP request.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Formatter, Layer, Stream, String as Str } from "effect"
import { ListenerLost } from "#adapter/errors/failures.ts"
import type { ChangeSink, ChangeSource } from "#adapter/live/source.ts"
import { makeSubscriptions } from "#adapter/live/subscriptions.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { httpHandler } from "#http/index.ts"
import {
	asCaller,
	built,
	type Door,
	type Seen,
	type ServicesFeature,
	seen,
	ShelvingServed,
	shelveBody,
	shelveInput,
	shelvingConfig,
	underNone
} from "#test/support/unit/adapter/services.fixtures.ts"
import { answered, fileRoutes, heartbeatGen } from "#test/support/unit/http/routes.fixtures.ts"
import { answer, read } from "#test/support/unit/live/leading.fixtures.ts"

/**
 * The installation's live source opens under its layer's own services, never a watch's, and each watch's read runs
 * under its own.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theLiveSourceOpensUnderItsLayersOwnServicesTheBuildsSpanLeftBehindNeverUnderAWatchsAndEachWatchsReadRunsUnderItsOwn =
	property.explore(array(int(1, 3), { min: 1, max: 4 }), {
		needs: {},
		situations: [
			"a source opened by its first watch",
			"a watch joining an open source",
			"a source opened again after one was lost"
		] satisfies ReadonlyArray<Reached<ServicesFeature>>,
		check: (_, c: Case<ServicesFeature>) => (rounds) =>
			Effect.scoped(
				Effect.gen(function* () {
					const opens: Array<Seen> = []
					const sink: { current: ChangeSink | undefined } = { current: undefined }
					const source: ChangeSource = {
						open: (opened) =>
							Effect.map(seen, (s) => {
								opens.push(s)
								sink.current = opened
							})
					}
					const registry = yield* makeSubscriptions(source).pipe(asCaller(built))
					const watches: Array<string> = []
					for (const [round, count] of rounds.entries()) {
						for (let at = 0; at < count; at++) {
							const name = `watch ${watches.length}`
							watches.push(name)
							const reads: Array<Seen> = []
							const own = Stream.flatMap(Stream.fromEffect(seen), (s) => {
								reads.push(s)
								return read
							})
							const initial = yield* Effect.gen(function* () {
								const live = yield* registry.register({
									read: own,
									answer,
									keys: [],
									expiry: { kind: "never" }
								})
								const events = yield* Stream.runCollect(live.initial)
								return answer.settle(events)
							}).pipe(asCaller(name))
							assert.equal(initial.kind, "ready", `${name} registers on an open source`)
							c.note(
								at === 0 ? "a source opened by its first watch" : "a watch joining an open source"
							)
							if (at === 0 && round > 0) {
								c.note("a source opened again after one was lost")
							}
							assert.deepEqual(
								Arr.map(reads, (r) => r.caller),
								[name],
								`${name}'s read runs once, for ${name}`
							)
							assert.ok(
								Arr.every(reads, (r) => r.spans.includes(name) && !r.spans.includes(built)),
								`${name}'s read runs under ${name}'s span alone: ${Formatter.format(reads)}`
							)
						}
						assert.equal(opens.length, round + 1, "each round's first watch opens the source, once")
						const lost = sink.current
						assert.ok(lost !== undefined, "the source opened")
						lost.lost(new ListenerLost())
					}
					for (const open of opens) {
						assert.equal(
							open.caller,
							built,
							`the source opens under the layer's own services, never a watch's: ${Formatter.format(opens)}`
						)
						assert.ok(
							underNone(open.spans, [built, ...watches]),
							`the source opens under no span, the build's or a watch's: ${Formatter.format(opens)}`
						)
					}
				})
			),
		oracle: {
			kind: "specification",
			name: "services.ts ownServices: the caller each piece of work runs for"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/subscriptions.ts",
				original:
					"\t\t\t\tEffect.forkIn(\n\t\t\t\t\tEffect.updateContext(\n\t\t\t\t\t\trun(generation),\n\t\t\t\t\t\t(_: Context.Context<never>): Context.Context<never> => services\n\t\t\t\t\t),\n\t\t\t\t\tlayer\n\t\t\t\t),",
				replacement: "\t\t\t\tEffect.forkIn(run(generation), layer),",
				why: "The source is forked under the context of the watch whose registering opened it, as subscriptions.ts did: it opens under that watch's Caller and span, and every later watch's source is traced under the first watch's request."
			},
			{
				file: "packages/grizzle/src/adapter/services.ts",
				original: "> => Effect.map(Effect.context<R>(), Context.omit(Tracer.ParentSpan))",
				replacement: "> => Effect.context<R>()",
				why: "A layer's own services keep the span it was built in: the source opens under the build's span, which ended with the build."
			}
		]
	})

/**
 * A Db's call runs for the caller that makes it: its lease's connection attempt, whose password the attempt runs, under
 * Db.open's caller's span and services, and an HTTP request's under the handler's services and no span, never the span
 * the handler or its layer was built in.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDbsCallRunsForTheCallerThatMakesItInProcessUnderItsCallersSpanOverHttpUnderNoSpanNeverTheHandlersBuild =
	property.explore(array(element<Door>(["Db.open", "HTTP"]), { min: 1, max: 4 }), {
		needs: {},
		situations: [
			"a Db opened by Db.open",
			"a Db opened by an HTTP request"
		] satisfies ReadonlyArray<Reached<ServicesFeature>>,
		check: (_, c: Case<ServicesFeature>) => (doors) =>
			Effect.scoped(
				Effect.gen(function* () {
					const attempts: Array<Seen> = []
					const services = yield* Layer.build(DbLayer.make(shelvingConfig(attempts))).pipe(
						asCaller(built)
					)
					const handler = yield* httpHandler({
						logins: [ShelvingServed],
						heartbeatMs: c.draw(heartbeatGen)
					}).pipe(Effect.provideContext(services), asCaller(built))
					const [route] = fileRoutes(ShelvingServed.file)
					assert.ok(route !== undefined, "the login serves its member's route")
					const callers = Arr.map(doors, (_, at) => `caller ${at}`)
					for (const [at, door] of doors.entries()) {
						const name = `caller ${at}`
						const before = attempts.length
						switch (door) {
							case "Db.open": {
								const called = yield* Effect.exit(
									Effect.gen(function* () {
										const db = yield* Db.open(ShelvingServed.roles.shelver, {})
										return yield* db.workload.shelve.once(shelveInput)
									}).pipe(Effect.provideContext(services), asCaller(name))
								)
								assert.ok(Exit.isFailure(called), "the password refuses the call's attempt")
								c.note("a Db opened by Db.open")
								break
							}
							case "HTTP": {
								const path = Str.slice("POST ".length)(route.line)
								const request = new Request(`http://grizzle.invalid${path}`, {
									method: "POST",
									headers: { "grizzle-wire": route.digest },
									body: shelveBody
								})
								yield* answered(handler, request).pipe(asCaller(name))
								c.note("a Db opened by an HTTP request")
								break
							}
						}
						const made = Arr.drop(attempts, before)
						assert.ok(
							made.length > 0,
							`${name}'s call makes a connection attempt, whose password runs: ${Formatter.format(made)}`
						)
						for (const s of made) {
							switch (door) {
								case "Db.open":
									assert.equal(
										s.caller,
										name,
										`the attempt Db.open's call makes runs under ${name}'s services`
									)
									assert.ok(
										s.spans.includes(name) && underNone(s.spans, [built]),
										`the attempt Db.open's call makes runs under ${name}'s span, never the build's: ${Formatter.format(s)}`
									)
									break
								case "HTTP":
									assert.equal(
										s.caller,
										built,
										"an HTTP request's attempt runs under the handler's own services"
									)
									assert.ok(
										underNone(s.spans, [built, ...callers]),
										`an HTTP request's attempt runs under no span, the handler's build's or a caller's: ${Formatter.format(s)}`
									)
									break
							}
						}
					}
				})
			),
		oracle: {
			kind: "specification",
			name: "services.ts ownServices: the caller each piece of work runs for"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/http/handler.ts",
				original: "\t\tconst context = yield* ownServices<DbLayerOf<Ls[number]>>()",
				replacement: "\t\tconst context = yield* Effect.context<DbLayerOf<Ls[number]>>()",
				why: "The handler runs every request under the context it was built in, its span included, as httpAnswers did: each request's call, its connection attempt among its work, is traced under the handler's build, which ended with it."
			}
		]
	})
