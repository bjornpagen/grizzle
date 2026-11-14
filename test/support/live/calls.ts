import { Array as Arr, Effect, Option, Record as Rec, Redacted, Ref, Stream } from "effect"
import { HttpClient } from "effect/http"
import { liveRead, memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { openCallError } from "#adapter/live/call-error.ts"
import type { DbLayerOf, ServedLogin } from "#adapter/types/layer.ts"
import { clientCalls } from "#client/client.ts"
import { handlerClient } from "#client/handler.ts"
import { isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import {
	type CallError,
	type CallErrorKind,
	callErrors,
	fold,
	type Keyed,
	opening,
	type ReadEvent,
	type ReadState,
	RowKey
} from "#compiler/live/index.ts"
import { openApiText } from "#compiler/live/openapi.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { type HttpConfigRefused, type HttpHandler, httpHandler } from "#http/index.ts"
import { defined } from "#test/support/assert.ts"
import { readStream } from "#test/support/event-stream.ts"
import { testTimeout } from "#test/support/limits.ts"
import { commitDirectly, commitStatements } from "#test/support/live/direct.ts"
import type { LiveInstallation } from "#test/support/live/harness.ts"
import type {
	CallInput,
	LiveCalls,
	LiveSurfaces,
	LiveValue,
	MarkState,
	RawEvent,
	RawRequest,
	Register,
	Registration
} from "#test/support/live/system.ts"
import {
	type LiveAnchor,
	type LiveCommit,
	type LiveSubscription,
	type LiveWrite,
	paramsOf,
	relationName,
	writeMember
} from "#test/support/live/world.ts"
import { tokenOf } from "#test/support/worlds.ts"

/** The anchor of a page's window as a call takes it (live/program.ts Anchor): a key is its completed order, `o` then `id`. */
const anchorOf = (anchor: LiveAnchor) => {
	switch (anchor.kind) {
		case "start":
		case "end":
			return { kind: anchor.kind }
		case "after":
		case "before":
			return { kind: anchor.kind, key: RowKey([anchor.o, anchor.id]) }
	}
}

/** A subscription's call input: its parameters, no facts, and a page's window. */
export const inputOf = (subscription: LiveSubscription): CallInput => {
	const binding = subscription.binding
	return binding.kind === "window"
		? {
				params: paramsOf(subscription),
				facts: {},
				window: { anchor: anchorOf(binding.anchor), size: binding.size }
			}
		: { params: paramsOf(subscription), facts: {} }
}

/** The member a grizzle call of `write` runs, and its facts: an insert's or a delete's row, an update's put of its new one. */
const callOf = (write: LiveWrite): { readonly member: string; readonly input: CallInput } => {
	const relation = relationName(write.relation)
	switch (write.kind) {
		case "insert":
			return {
				member: writeMember("insert", write.relation),
				input: { params: {}, facts: { insert: { [relation]: [write.fact] } } }
			}
		case "delete":
			return {
				member: writeMember("delete", write.relation),
				input: { params: {}, facts: { delete: { [relation]: [write.fact] } } }
			}
		case "update":
			return {
				member: writeMember("put", write.relation),
				input: { params: {}, facts: { put: { [relation]: [write.to] } } }
			}
	}
}

/**
 * Runs one commit of a history, returning once it committed: a grizzle call through `calls`, or the installation's
 * direct writer's SERIALIZABLE transaction (test/support/live/direct.ts commitDirectly).
 */
export const commitLive = (live: LiveInstallation, calls: LiveCalls, commit: LiveCommit) => {
	if (commit.writer === "psql") {
		return commitDirectly(live.writer, commitStatements(live.installed.plan, live.c, commit))
	}
	const call = callOf(commit.write)
	return Effect.asVoid(calls.write(call.member, call.input))
}

/** Every CallError's class, in the classification's order. */
const callErrorKinds: ReadonlyArray<CallErrorKind> = Rec.keys(callErrors)

/** The class and retry an error event's data names (live/events.ts CallError): a frame that names none fails the case. */
export const errorOf = (
	event: RawEvent
): { readonly kind: CallErrorKind; readonly retry: string } => {
	const data = trustedJson<unknown>(event.data)
	const error = isRecord(data) ? data["error"] : undefined
	const kind = isRecord(error) ? error["kind"] : undefined
	const retry = isRecord(error) ? error["retry"] : undefined
	const known = Arr.findFirst(callErrorKinds, (k) => k === kind)
	if (Option.isNone(known) || typeof retry !== "string") {
		throw new Error(`an error event names no CallError: ${event.data}`)
	}
	return { kind: known.value, retry }
}

/**
 * A read's values as its events make them (live/fold.ts): the fold's value at each `ready`, its first and each live
 * batch's, as the client's watch gives them; the error event fails the stream with its CallError, and the answer's end
 * ends it.
 */
const readiesOf = <S extends "set" | "list", Row extends object>(
	shape: S,
	events: Stream.Stream<ReadEvent<S, Row>>
): Stream.Stream<Keyed<S, Row>, CallError> =>
	events.pipe(
		Stream.mapAccum(
			() => opening<S, Row>(shape),
			(state, event) => {
				const next = fold(state, [event])
				const steps: ReadonlyArray<Step<Keyed<S, Row>>> =
					event.kind === "ready" && next.kind === "ready"
						? [{ kind: "value", value: next.value }]
						: event.kind === "error"
							? [{ kind: "error", error: event.error }]
							: []
				return [next, steps] as const
			}
		),
		Stream.mapEffect((step) =>
			step.kind === "error" ? Effect.fail(step.error) : Effect.succeed(step.value)
		)
	)

/** What a read's answer gives its watcher at an event: a value whole at a ready, or the error that ends it. */
type Step<V> =
	| { readonly kind: "value"; readonly value: V }
	| { readonly kind: "error"; readonly error: CallError }

/** A member a suite named that its role does not serve, or of another shape than its call: a defect of the suite. */
const misnamed = (member: string, what: string) =>
	new Error(`the served member ${member} is ${what}`)

/**
 * The calls of `role` of the served login `file` in process: each call opens a Db through the login's layer with
 * `token` (test/support/worlds.ts tokenOf), as a request handler opens one, and runs its member's once or watch
 * (adapter/db/handles.ts memberCalls) by its name; a Db that does not open ends the call with its CallError
 * (adapter/live/call-error.ts openCallError).
 */
const inProcessCalls = (
	file: ServedLogin<AnyLogin>,
	role: string,
	token: string
): Effect.Effect<LiveCalls, never, DbLayerOf<AnyLogin>> =>
	Effect.map(Effect.context<DbLayerOf<AnyLogin>>(), (context) => {
		const served = defined(file.roles[role], `the served role ${role}`)
		const callsOf = (name: string): Effect.Effect<ServedCalls, CallError> =>
			Effect.provideContext(
				Effect.mapBoth(openServed(served, { token }), {
					onFailure: openCallError,
					onSuccess: (opened) =>
						memberCalls(
							opened.ctx,
							defined(
								Option.getOrUndefined(Arr.findFirst(opened.role.members, (m) => m.name === name)),
								`the served member ${name} of role ${role}`
							)
						)
				}),
				context
			)
		return byName(callsOf)
	})

/** The calls over `callsOf`, each member's served calls by its name (see inProcessCalls). */
const byName = (callsOf: (name: string) => Effect.Effect<ServedCalls, CallError>): LiveCalls => ({
	surface: "in process",
	once: (name, input) =>
		Effect.flatMap(callsOf(name), (member): Effect.Effect<LiveValue, CallError> => {
			switch (member.shape) {
				case "set":
				case "instantSet":
					return member.once(input)
				case "list":
				case "instantList":
					return member.once(input)
				case "write":
					return Effect.die(misnamed(name, "a write"))
			}
		}),
	write: (name, input) =>
		Effect.flatMap(callsOf(name), (member) =>
			member.shape === "write" ? member.once(input) : Effect.die(misnamed(name, "a read"))
		),
	watch: (name, input) =>
		Stream.unwrap(
			Effect.map(callsOf(name), (member): Stream.Stream<LiveValue, CallError> => {
				switch (member.shape) {
					case "set":
						return readiesOf("set", member.watch(input))
					case "list":
						return readiesOf("list", member.watch(input))
					case "instantSet":
					case "instantList":
						return Stream.die(misnamed(name, "a read at its call's instant, never watched"))
					case "write":
						return Stream.die(misnamed(name, "a write"))
				}
			})
		)
})

/** The wire digest a member's call names in its `grizzle-wire` header: the served file's, as a client holds it. */
export const wireOf = (file: ServedLogin<AnyLogin>, role: string, member: string): string =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				defined(
					Option.getOrUndefined(Arr.findFirst(file.file.roles, (r) => r.name === role)),
					`the served role ${role}`
				).members,
				(m) => m.name === member
			)
		),
		`the served member ${member} of role ${role}`
	).wire.digest

/**
 * A request a suite writes itself, answered by `handler` and read to the end of its body by the specification's reader
 * (test/support/event-stream.ts), each event by its type and data: an answer that fails ends, so its body does.
 */
const rawCall =
	(handler: HttpHandler) =>
	(request: RawRequest): Effect.Effect<ReadonlyArray<RawEvent>> =>
		Effect.flatMap(
			Effect.promise(() =>
				handler(
					new Request(`http://live.test${request.path}`, {
						method: request.method,
						headers: request.headers,
						body: request.method === "GET" ? null : request.body
					})
				)
			),
			(response) => {
				const body = response.body
				if (body === null) {
					return Effect.die(new Error("an answer always has a body"))
				}
				return Effect.map(Effect.orDie(readStream(body, () => false)), (read) =>
					Arr.map(read.events, (e): RawEvent => ({ type: e.event, data: e.data }))
				)
			}
		)

/** The base URL the handler is reached under in process: any origin, since no socket carries the request. */
const handlerUrl = (): URL => new URL("http://live.test/")

/**
 * The calls of `role` of the served login `file` over HTTP: the client's untyped door (client/client.ts clientCalls)
 * over the login's OpenAPI document as generate writes it (live/openapi.ts openApiText), its every request answered by
 * `handler` in process (client/handler.ts handlerClient), each call sending `token`; a read's watch yields each value
 * the client's fold holds at a ready.
 */
const httpCalls = (
	handler: HttpHandler,
	file: ServedLogin<AnyLogin>,
	role: string,
	token: string
): LiveCalls => {
	const text = openApiText(file.file)
	if (!text.ok) {
		throw new Error(`the OpenAPI document of login ${file.name}: ${text.error.message}`)
	}
	const client = handlerClient(handler)
	const programs = defined(
		clientCalls(trustedJson<unknown>(text.value), file.name, {
			url: handlerUrl(),
			token: Redacted.make(token)
		})[role],
		`the role ${role} of the document of login ${file.name}`
	)
	const shapedOf = (name: string) =>
		defined(programs[name], `the program ${name} of role ${role} of the document`)
	return {
		surface: "over HTTP",
		once: (name, input): Effect.Effect<LiveValue, CallError> => {
			const shaped = shapedOf(name)
			switch (shaped.shape) {
				case "set":
				case "instantSet":
					return Effect.provideService(shaped.calls.once(input), HttpClient.HttpClient, client)
				case "list":
				case "instantList":
					return Effect.provideService(shaped.calls.once(input), HttpClient.HttpClient, client)
				case "write":
					return Effect.die(misnamed(name, "a write"))
			}
		},
		write: (name, input) => {
			const shaped = shapedOf(name)
			return shaped.shape === "write"
				? Effect.provideService(shaped.calls.once(input), HttpClient.HttpClient, client)
				: Effect.die(misnamed(name, "a read"))
		},
		watch: (name, input) => {
			const shaped = shapedOf(name)
			switch (shaped.shape) {
				case "set":
					return Stream.provideService(
						Stream.map(shaped.calls.watch(input), (answered): LiveValue => answered.value),
						HttpClient.HttpClient,
						client
					)
				case "list":
					return Stream.provideService(
						Stream.map(shaped.calls.watch(input), (answered): LiveValue => answered.value),
						HttpClient.HttpClient,
						client
					)
				case "instantSet":
				case "instantList":
					return Stream.die(misnamed(name, "a read at its call's instant, never watched"))
				case "write":
					return Stream.die(misnamed(name, "a write"))
			}
		}
	}
}

/**
 * The surfaces of `role` of the served login `file`, each call sending `token`: in process, a Db opened per call; over
 * HTTP, the login's handler (http/handler.ts httpHandler) through the client; and that handler answering a request a
 * suite writes itself. The handler's heartbeat is a test's whole timeout, so no answer carries one.
 */
export const liveSurfaces = (
	file: ServedLogin<AnyLogin>,
	role: string,
	token: string
): Effect.Effect<LiveSurfaces, HttpConfigRefused, DbLayerOf<AnyLogin>> =>
	Effect.gen(function* () {
		const inProcess = yield* inProcessCalls(file, role, token)
		const handler = yield* httpHandler({ logins: [file], heartbeatMs: testTimeout.value })
		return { inProcess, http: httpCalls(handler, file, role, token), raw: rawCall(handler) }
	})

/** A live world's surfaces: its login's one role `app`, which reads no context, with the token of no claim. */
export const worldSurfaces = (
	live: LiveInstallation
): Effect.Effect<LiveSurfaces, HttpConfigRefused, DbLayerOf<AnyLogin>> =>
	liveSurfaces(live.file, "app", tokenOf({}))

/**
 * A live read registered on watch's own path (adapter/db/handles.ts liveRead), read to its first ready: its value there,
 * its registration's state, and its turn, each batch a turn gives folded onto the value the turns before it left.
 */
const registeredFrom = <S extends "set" | "list", Row extends object>(
	shape: S,
	live: {
		readonly initial: Stream.Stream<ReadEvent<S, Row>>
		readonly state: Effect.Effect<MarkState>
		readonly turn: Effect.Effect<Option.Option<ReadonlyArray<ReadEvent<S, Row>>>>
	}
): Effect.Effect<Registration, CallError> =>
	Effect.gen(function* () {
		const initial = yield* Stream.runCollect(live.initial)
		const settled = fold(opening<S, Row>(shape), initial)
		switch (settled.kind) {
			case "failed":
				return yield* Effect.fail(settled.error)
			case "opening":
			case "provisional":
				return yield* Effect.die(
					new Error("a live read's initial events end at its ready or its error")
				)
			case "ready": {
				const held = yield* Ref.make<ReadState<S, Row>>(settled)
				const turn: Effect.Effect<Option.Option<LiveValue>, CallError> = Effect.flatMap(
					live.turn,
					(batch) =>
						Option.isNone(batch)
							? Effect.succeedNone
							: Effect.flatMap(Ref.get(held), (was) => {
									const next = fold(was, batch.value)
									return next.kind === "failed"
										? Effect.fail(next.error)
										: Effect.as(
												Ref.set(held, next),
												next.kind === "ready" ? Option.some(next.value) : Option.none()
											)
								})
				)
				return { state: live.state, value: settled.value, turn }
			}
		}
	})

/**
 * The registrations of `role` of the served login `file`, each on a Db opened with `token` through the login's layer, by
 * its member's name: what a suite holds to read a subscription's state while it decides when to pull its changes.
 */
const liveRegistrations = (
	file: ServedLogin<AnyLogin>,
	role: string,
	token: string
): Effect.Effect<Register, never, DbLayerOf<AnyLogin>> =>
	Effect.map(
		Effect.context<DbLayerOf<AnyLogin>>(),
		(context) => (name, input) =>
			Effect.gen(function* () {
				const served = defined(file.roles[role], `the served role ${role}`)
				const opened = yield* Effect.mapError(
					Effect.provideContext(openServed(served, { token }), context),
					openCallError
				)
				const member = defined(
					Option.getOrUndefined(Arr.findFirst(opened.role.members, (m) => m.name === name)),
					`the served member ${name} of role ${role}`
				)
				const started = yield* defined(
					Option.getOrUndefined(liveRead(opened.ctx, member, input)),
					`the served member ${name}, a read`
				)
				switch (started.shape) {
					case "set":
						return yield* registeredFrom("set", started.live)
					case "list":
						return yield* registeredFrom("list", started.live)
				}
			})
	)

/** A live world's registrations: its login's one role `app`, with the token of no claim. */
export const worldRegistrations = (
	live: LiveInstallation
): Effect.Effect<Register, never, DbLayerOf<AnyLogin>> =>
	liveRegistrations(live.file, "app", tokenOf({}))
