import {
	Array as Arr,
	type Context,
	Data,
	Deferred,
	Effect,
	Exit,
	Option,
	Result,
	Stream
} from "effect"
import { faultAt, timerDelay, timerRule } from "#adapter/connection/config.ts"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { servedContext } from "#adapter/db/served.ts"
import type { Token } from "#adapter/db/token.ts"
import { readHost, toResult } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	AttestationRefused,
	type SettingFault,
	settingFaultText
} from "#adapter/errors/failures.ts"
import { doorRefusal, openCallError } from "#adapter/live/call-error.ts"
import { type HeldRole, heldRole, type ReadLogin, readServedLogin } from "#adapter/pool/served.ts"
import type { LoadedMember, LoadedRole } from "#adapter/served/load.ts"
import { ownServices } from "#adapter/services.ts"
import type { DbLayerOf, ServedLogin } from "#adapter/types/layer.ts"
import type { CallErrorOf, FailureOf } from "#compiler/live/index.ts"
import type { AnyLogin, AttestedFactsOf, ReadsAttested, RolesOf } from "#compiler/plan/common.ts"
import {
	parseInput,
	readCaller,
	slotEncoders,
	type WireFault,
	type WireJson,
	type WireOptions
} from "#compiler/plan/runtime.ts"
import { listFrame, refusedFrames, type SlotEncoders, writeFrame } from "#http/events.ts"
import { authorizationToken, bodyJson, requestLine, wireNamed } from "#http/request.ts"
import { type HttpRoute, type RouteOf, routeLine, routeTable } from "#http/routes.ts"
import { type SseEvent, sseHeaders, sseStream } from "#http/sse.ts"

/**
 * A fetch-style handler: a request in, its response out. Deno.serve, Bun.serve and a Worker's fetch take one as it is,
 * and nodeListener mounts one on node:http's or node:http2's server.
 */
export type HttpHandler = (request: Request) => Promise<Response>

/**
 * What the server attests of a request, for the contexts its served roles declare as attested (attested(...)): under
 * each one's name its one fact, or none, read from the request as the server's own deployment trusts it (an edge's
 * header of the address a request reached it from), never from its token or its body, which the client states.
 */
export type Attest<Ls extends ReadonlyArray<AnyLogin>> = (
	request: Request
) => AttestedFactsOf<RolesOf<Ls[number]>>

/**
 * httpHandler's config: the served logins whose roles' members it serves, each a login served(...) built, whose
 * DbLayer the handler's Effect requires; the interval of the heartbeat every answer carries, in milliseconds, an
 * integer from 1 to 2,147,483,647: the caller's, since grizzle states no interval of its own; and `attest`, the facts
 * the server attests of each request (Attest), required exactly when a served role declares an attested context and
 * absent otherwise.
 */
export type HttpConfig<Ls extends ReadonlyArray<AnyLogin>> = {
	readonly logins: { readonly [K in keyof Ls]: ServedLogin<Ls[K]> }
	readonly heartbeatMs: number
} & (unknown extends ReadsAttested<RolesOf<Ls[number]>>
	? { readonly attest?: Attest<Ls> }
	: ReadsAttested<RolesOf<Ls[number]>> extends true
		? { readonly attest: Attest<Ls> }
		: { readonly attest?: never })

/**
 * Why httpHandler refused its config, when it was built: a setting no handler can use (a value that is no served login,
 * a heartbeat outside its range, a key it does not know), a role of a login whose layer the context does not hold
 * (OpenError, RoleOutsideLayers), or two logins of one name, which give one route twice.
 */
export type HttpConfigFault =
	| { readonly kind: "setting"; readonly fault: SettingFault }
	| { readonly kind: "layer"; readonly error: OpenError }
	| { readonly kind: "route"; readonly route: HttpRoute }

/** httpHandler's config, refused when the handler is built (HttpConfigFault). */
export class HttpConfigRefused extends Data.TaggedError("HttpConfigRefused")<{
	readonly reason: HttpConfigFault
}> {
	override get message(): string {
		const reason = this.reason
		switch (reason.kind) {
			case "setting":
				return settingFaultText(reason.fault)
			case "layer":
				return reason.error.message
			case "route":
				return `two logins serve the route ${routeLine(reason.route)}: serve each login of one name once`
		}
	}
}

/** The block a handler's settings sit in, as a refusal names their paths. */
const httpConfig = ["HttpConfig"] as const

/** The settings of a handler's config. */
const httpSettings: ReadonlyArray<string> = ["logins", "heartbeatMs", "attest"]

/** The settings a handler's config reads off its typed value, leaving them unread on the copy: its logins and attest. */
const typedSettings: ReadonlySet<string> = new Set(["logins", "attest"])

const refusedSetting = (fault: SettingFault): HttpConfigRefused =>
	new HttpConfigRefused({ reason: { kind: "setting", fault } })

/**
 * A handler's config read: its logins, each as a config reads a served login, its heartbeat's interval, and its attest,
 * none where the config gives none.
 */
interface ReadConfig {
	readonly logins: Arr.NonEmptyReadonlyArray<ReadLogin>
	readonly heartbeatMs: number
	readonly attest: Option.Option<(request: Request) => unknown>
}

/**
 * A handler's config, read once at the boundary as a DbConfig is (core/host.ts readCaller): an object holding only its
 * settings, its logins a nonempty list of served logins, each read as DbLayer.make reads its login (pool/served.ts
 * readServedLogin), and its heartbeat a timer's delay. A JavaScript caller may pass any value, and every refusal names
 * the setting it refuses.
 */
const readConfig = <Ls extends ReadonlyArray<AnyLogin>>(
	config: HttpConfig<Ls>
): Result.Result<ReadConfig, SettingFault> =>
	readHost(faultAt(httpConfig, "logins", { kind: "data" }), () => {
		const passed: unknown = config
		if (typeof passed !== "object" || passed === null) {
			return Result.fail(faultAt(httpConfig, "logins", { kind: "object", settings: httpSettings }))
		}
		const read = readCaller(passed, typedSettings)
		if (!read.ok) {
			return Result.fail(faultAt(httpConfig, "logins", { kind: "data" }))
		}
		const unknown = Arr.findFirst(read.value.keys, (key) => !httpSettings.includes(key))
		if (Option.isSome(unknown)) {
			return Result.fail(
				faultAt(httpConfig, unknown.value, { kind: "known", settings: httpSettings })
			)
		}
		const heartbeatMs = read.value.data["heartbeatMs"]
		if (typeof heartbeatMs !== "number" || !timerDelay(heartbeatMs)) {
			return Result.fail(faultAt(httpConfig, "heartbeatMs", timerRule))
		}
		const attest: unknown = config.attest
		if (attest !== undefined && typeof attest !== "function") {
			return Result.fail(faultAt(httpConfig, "attest", { kind: "function" }))
		}
		const attestOf: Option.Option<(request: Request) => unknown> =
			attest === undefined
				? Option.none()
				: Option.some((request: Request): unknown => Reflect.apply(attest, undefined, [request]))
		const typed: ReadonlyArray<ServedLogin<Ls[number]>> = config.logins
		const given: unknown = typed
		const loginRefused = faultAt(httpConfig, "logins", { kind: "servedLogin" })
		if (!Arr.isArray(given)) {
			return Result.fail(loginRefused)
		}
		const logins: Array<ReadLogin> = []
		for (const login of typed) {
			const served = readServedLogin(login, loginRefused)
			if (Result.isFailure(served)) {
				return Result.fail(served.failure)
			}
			logins.push(served.success)
		}
		return Arr.isReadonlyArrayNonEmpty(logins)
			? Result.succeed({ logins, heartbeatMs, attest: attestOf })
			: Result.fail(loginRefused)
	})

/** A member the handler serves: its name, as its layer loaded it, and the encoders of its events' slots. */
interface ServedMember {
	readonly name: string
	readonly loaded: LoadedMember
	readonly slots: SlotEncoders
}

/** A role the handler serves: its name and members, as its login's layer loaded them, beside its layer. */
interface ServedRole {
	readonly name: string
	readonly members: ReadonlyArray<ServedMember>
	readonly held: HeldRole
}

/** A route as the handler serves it: its role, held by its login's layer, and its member, loaded. */
type ServedRoute = RouteOf<ServedRole>

/** Effect's Option, as a member's wire reads and writes an attachment of one row at most (live/shape.ts WireOptions). */
const wireOptions: WireOptions = {
	some: Option.some,
	none: Option.none(),
	is: Option.isOption,
	fold: Option.match
}

/**
 * The roles of a login as its layer among `context`'s loaded them, by the names its served file gives them, each
 * member with its slots' encoders built from its wire: a role of a login whose layer the context does not hold is
 * refused with its OpenError (RoleOutsideLayers).
 */
const servedRoles = <S>(
	context: Context.Context<S>,
	login: ReadLogin
): Result.Result<ReadonlyArray<ServedRole>, HttpConfigRefused> =>
	Result.mapError(
		Result.all(
			Arr.map(login.file.roles, (role) =>
				Result.map(
					heldRole(context, { base: login.base, login: login.name, role: role.name }),
					(held): ServedRole => ({
						name: held.role.name,
						members: Arr.map(held.role.members, (loaded) => ({
							name: loaded.name,
							loaded,
							slots: slotEncoders(loaded.wire.member, held.role.wire.witness, wireOptions)
						})),
						held
					})
				)
			)
		),
		(error) => new HttpConfigRefused({ reason: { kind: "layer", error } })
	)

/**
 * The token a Db of `role` opens with: the one the request gives, and none without one only where the role reads no
 * token's context, since those are read from a token's claims (a Db.open of it requires one); a role reading one
 * refuses a request without a token.
 */
const openingToken = (
	role: LoadedRole,
	given: Option.Option<Token>
): Result.Result<Option.Option<Token>, FailureOf<"door">> =>
	Arr.some(role.contexts, (context) => context.source.kind === "token") && Option.isNone(given)
		? Result.fail(
				doorRefusal(
					"TokenAbsent",
					`role ${role.name} declares a token's context, and the call gives no bearer token`
				)
			)
		: Result.succeed(given)

/** No key of an attest's answer is left unread: every own property is copied. */
const noTypedKeys: ReadonlySet<string> = new Set()

/**
 * The facts the server attests of `request` for a Db of `role` (claims.ts attestedFacts): none where the role declares
 * no attested context; else the members of what the config's attest returns for the request that name the role's
 * attested contexts. Its answer is read once as data (core/host.ts readCaller): no record, or a member naming no
 * attested context of any role the handler serves (`names`), is AttestationRefused, so a name no served role reads is
 * never dropped unseen; a member of another role's context is that role's, which this Db never reads.
 */
const openingAttested = (
	attesting: Attesting,
	role: LoadedRole,
	request: Request
): Result.Result<Option.Option<Readonly<Record<string, unknown>>>, OpenError> => {
	const own = new Set(
		Arr.flatMap(role.contexts, (c) => (c.source.kind === "attested" ? [c.name] : []))
	)
	const attest = attesting.attest
	if (own.size === 0 || Option.isNone(attest)) {
		return Result.succeed(Option.none())
	}
	const refused = (context: string, fault: AttestationRefused["fault"]): OpenError =>
		new OpenError({ reason: new AttestationRefused({ context, fault }) })
	const [first] = own
	const answerRefused = refused(first ?? role.name, { kind: "notAnObject" })
	return readHost(answerRefused, () => {
		const answer = attest.value(request)
		if (typeof answer !== "object" || answer === null || Arr.isArray(answer)) {
			return Result.fail(answerRefused)
		}
		const read = readCaller(answer, noTypedKeys)
		if (!read.ok) {
			return Result.fail(answerRefused)
		}
		const facts: Record<string, unknown> = {}
		for (const name of read.value.keys) {
			if (!attesting.names.has(name)) {
				return Result.fail(refused(name, { kind: "undeclared" }))
			}
			if (own.has(name)) {
				facts[name] = read.value.data[name]
			}
		}
		return Result.succeed(Option.some(facts))
	})
}

/**
 * A member's events as their frames, by the member's shape: a live read's, its watch; an answered one's, at its call's
 * instant alone, its answer, which ends after its ready and never watches, so it holds no live source; or a write's,
 * each event framed by its payload (events.ts), its slots encoded by the member's wire.
 */
const framed = (
	calls: ServedCalls,
	slots: SlotEncoders,
	input: unknown
): Stream.Stream<SseEvent> => {
	switch (calls.shape) {
		case "list":
			return Stream.map(calls.watch(input), (event) => listFrame(slots, event))
		case "answeredList":
			return Stream.map(calls.answer(input), (event) => listFrame(slots, event))
		case "write":
			return Stream.map(calls.watch(input), (event) => writeFrame(slots, event))
	}
}

/** The refusal of a body its member's wire does not parse: the fault, at its path in the body. */
const inputRefused = (fault: WireFault): FailureOf<"door"> =>
	doorRefusal(
		"InputUnparsed",
		`the body does not parse as the program's input: ${fault.kind} at ${Arr.join(
			Arr.map(fault.at, (step) => `${step}`),
			"."
		)}`
	)

/**
 * One call of `route`: the wire the request names held to its member's (request.ts wireNamed), the request's token, its
 * body's JSON, the Db of the route's role opened with the token
 * (db/served.ts servedContext, as Db.open opens one), the body parsed as the member's input by its wire, then the
 * member's watch (db/handles.ts memberCalls), framed, whose stream ends with its own terminal event. A refusal before
 * the watch is the call's CallError.
 */
const routeCall = (
	route: ServedRoute,
	attesting: Attesting,
	request: Request
): Effect.Effect<Stream.Stream<SseEvent>, FailureOf<"door" | "open">> =>
	Effect.gen(function* () {
		yield* Effect.fromResult(wireNamed(request, route.member.loaded.wire.digest))
		const given = yield* Effect.fromResult(authorizationToken(request))
		const token = yield* Effect.fromResult(openingToken(route.role.held.role, given))
		const attested = yield* Effect.mapError(
			Effect.fromResult(openingAttested(attesting, route.role.held.role, request)),
			openCallError
		)
		const body = yield* bodyJson(request)
		const ctx = yield* Effect.mapError(
			servedContext(route.role.held, { token, attested }),
			openCallError
		)
		const member = route.member
		const input = yield* Effect.fromResult(
			Result.mapError(toResult(parseInput(member.loaded.wire.member.input, body)), inputRefused)
		)
		return framed(memberCalls(ctx, member.loaded), member.slots, input)
	})

/**
 * One request's answer (httpAnswers): its response, and how far the handler has come between its member's call and the
 * response's body, as values. `written` counts the frames written to the body so far, each counted as it joins the
 * body's stream, before the heartbeat is merged in and whatever the client has read. `pending(taken)` resolves once the
 * handler has taken at least `taken` events from its member's call and its read of the next one is pending, or once the
 * call has ended, when no read of it is pending again. One fiber takes each event and writes its frame, and it asks the
 * call for more only once it has written the frame of every event it took, so at that ask `written` counts them all: a
 * handler that held its call's events back from the body would ask with fewer written. A request that no route serves,
 * or that is refused before its member runs, takes no event from a call: its frames are the refusal's.
 */
export interface HttpAnswer {
	readonly response: Response
	readonly written: Effect.Effect<number>
	readonly pending: (taken: number) => Effect.Effect<void>
}

/**
 * Where the handler's read of its member's call stands: not asked yet; asked for the event after the `taken` it had
 * taken at its latest ask; or ended, the call's stream done or the answer stopped.
 */
type CallRead =
	| { readonly kind: "unasked" }
	| { readonly kind: "asked"; readonly taken: number }
	| { readonly kind: "ended" }

/** Whether `read` has come as far as `pending(taken)` waits for (HttpAnswer). */
const readReached = (read: CallRead, taken: number): boolean => {
	switch (read.kind) {
		case "unasked":
			return false
		case "asked":
			return read.taken >= taken
		case "ended":
			return true
	}
}

/** An answer's progress as its handler records it (HttpAnswer), with the two stages that count it. */
interface AnswerProgress extends Pick<HttpAnswer, "written" | "pending"> {
	/** The member's call's events: each counted as the handler takes it, and each ask for more noted as it is made. */
	readonly reading: (events: Stream.Stream<SseEvent>) => Stream.Stream<SseEvent>
	/** The answer's frames, each counted as it joins the body. */
	readonly writing: (frames: Stream.Stream<SseEvent>) => Stream.Stream<SseEvent>
}

/**
 * A fresh answer's progress: no event taken, no frame written, its call not asked yet. `moved` is completed, and
 * replaced, at each step of the call's read.
 */
const answerProgress = (): AnswerProgress => {
	let taken = 0
	let written = 0
	let read: CallRead = { kind: "unasked" }
	let moved = Deferred.makeUnsafe<void>()
	const step = (next: CallRead): void => {
		read = next
		const done = moved
		moved = Deferred.makeUnsafe<void>()
		Deferred.doneUnsafe(done, Effect.void)
	}
	const pending = (count: number): Effect.Effect<void> =>
		Effect.suspend(() => {
			const next = moved
			return readReached(read, count)
				? Effect.void
				: Effect.andThen(Deferred.await(next), pending(count))
		})
	return {
		reading: (events) =>
			Stream.transformPull(events, (pull) =>
				Effect.succeed(
					Effect.suspend(() => {
						step({ kind: "asked", taken })
						return Effect.onExit(pull, (exit) =>
							Effect.sync(() =>
								Exit.match(exit, {
									onSuccess: (chunk) => {
										taken += chunk.length
									},
									onFailure: () => step({ kind: "ended" })
								})
							)
						)
					})
				)
			),
		writing: (frames) =>
			Stream.mapArray(frames, (chunk) => {
				written += chunk.length
				return chunk
			}),
		written: Effect.sync(() => written),
		pending
	}
}

/**
 * The JSON of the refusal of a request line no route serves, which no member's slots encode: its kind, its retry, and
 * its payload, a message alone (live/events.ts callErrors route).
 */
const routeErrorJson = (error: CallErrorOf<"route">): WireJson => ({
	kind: error.kind,
	retry: error.retry,
	message: error.message
})

/**
 * How the handler attests a request's facts: the config's attest, none where it gives none, and the names of the
 * attested contexts of every role it serves, which an attest's answer names alone.
 */
interface Attesting {
	readonly attest: Option.Option<(request: Request) => unknown>
	readonly names: ReadonlySet<string>
}

/**
 * The events answering `request`: the call of the route its request line names (routeCall), its events read through the
 * answer's progress (AnswerProgress reading), or, for a line no route serves, its refusal. Every refusal is the call's
 * error, then its end, so the stream never fails.
 */
const answerEvents = (
	table: ReadonlyMap<string, ServedRoute>,
	attesting: Attesting,
	request: Request,
	progress: AnswerProgress
): Stream.Stream<SseEvent> => {
	const line = requestLine(request)
	return Option.match(Option.fromNullishOr(table.get(line)), {
		onNone: () =>
			Stream.fromIterable(
				refusedFrames(
					routeErrorJson,
					doorRefusal("RouteUnserved", `no served program answers ${line}`)
				)
			),
		onSome: (route) =>
			Stream.unwrap(
				Effect.match(Effect.map(routeCall(route, attesting, request), progress.reading), {
					onFailure: (error) => Stream.fromIterable(refusedFrames(route.member.slots.error, error)),
					onSuccess: (events) => events
				})
			)
	})
}

/**
 * How a handler attests its requests (Attesting): its config's attest and the attested contexts of every role it
 * serves; a config that gives no attest beside a served role declaring an attested context is refused, naming the role.
 */
const attestingOf = (
	read: ReadConfig,
	logins: ReadonlyArray<{ readonly login: string; readonly roles: ReadonlyArray<ServedRole> }>
): Result.Result<Attesting, HttpConfigRefused> => {
	const names = new Set<string>()
	for (const { login, roles } of logins) {
		for (const role of roles) {
			for (const context of role.held.role.contexts) {
				if (context.source.kind !== "attested") {
					continue
				}
				if (Option.isNone(read.attest)) {
					return Result.fail(
						refusedSetting(
							faultAt(httpConfig, "attest", { kind: "attester", role: role.name, login })
						)
					)
				}
				names.add(context.name)
			}
		}
	}
	return Result.succeed({ attest: read.attest, names })
}

/**
 * The answers httpHandler serves, each request's with its progress (HttpAnswer): its config read and its route table
 * built as httpHandler's are, once, and each answer's body its events framed (sse.ts sseStream), their frames counted as
 * they join it. Each request comes from outside any fiber and runs under the handler's own services
 * (services.ts ownServices), its layers among them, never under the span the handler was built in.
 */
export const httpAnswers = <const Ls extends readonly [AnyLogin, ...Array<AnyLogin>]>(
	config: HttpConfig<Ls>
): Effect.Effect<(request: Request) => HttpAnswer, HttpConfigRefused, DbLayerOf<Ls[number]>> =>
	Effect.gen(function* () {
		const read = yield* Effect.fromResult(Result.mapError(readConfig(config), refusedSetting))
		const context = yield* ownServices<DbLayerOf<Ls[number]>>()
		const logins = yield* Effect.fromResult(
			Result.all(
				Arr.map(read.logins, (login) =>
					Result.map(servedRoles(context, login), (roles) => ({ login: login.name, roles }))
				)
			)
		)
		const table = yield* Effect.fromResult(
			Result.mapError(
				routeTable(logins),
				(route) => new HttpConfigRefused({ reason: { kind: "route", route } })
			)
		)
		const attesting = yield* Effect.fromResult(attestingOf(read, logins))
		return (request: Request): HttpAnswer => {
			const progress = answerProgress()
			return {
				response: new Response(
					Stream.toReadableStreamWith(
						sseStream(
							progress.writing(answerEvents(table, attesting, request, progress)),
							read.heartbeatMs
						),
						context,
						{ signal: request.signal }
					),
					{ status: 200, headers: sseHeaders }
				),
				written: progress.written,
				pending: progress.pending
			}
		}
	})

/**
 * httpHandler(config): a fetch-style handler serving every member of every role of the config's served logins, one
 * route each, `POST /<login>/<role>/<program>` (routes.ts), built in an Effect that requires each login's DbLayer and
 * captures the context it runs in once, the span it runs in left behind (services.ts ownServices), so the handler lives
 * as long as the caller's runtime or layer scope, grizzle builds no runtime of its own, and no request is traced under
 * the handler's build.
 *
 * Every request is answered 200 with a text/event-stream body (sse.ts) carrying its call's events (db/handles.ts
 * memberCalls): a live read's watch, reset, upserts, ready and the live changes; an answered read's answer, at its
 * call's instant alone (an answered(...) or a clocked member's), reset, upserts, ready then end, which never watches; a
 * write's outcome then end. A handler whose logins' reads are all answered serves with no live source: its layers
 * require none (types/layer.ts LiveOf).
 * Every failure is one `error` event carrying its CallError, then `end`: a request line no route serves; a request
 * naming no `grizzle-wire` digest, or one naming another form of the member than the one served (`stale`, so a client
 * never decodes by a form the server no longer serves); a token refused, or missing where the role declares a context; a
 * body that is not JSON, or not the member's input; and any failure of the call itself. The Db is opened as Db.open opens one (db/served.ts servedContext), with the bearer token of the
 * Authorization header, through the layer's own verify and the role's contexts, so a token means one thing to either.
 *
 * The response body pulls the call's stream: an event is read only as the client reads, and a client that goes away
 * (the request's signal aborting, or the body cancelled) interrupts the call, which releases what it holds. A heartbeat
 * comment every `heartbeatMs` keeps a quiet stream open. No event carries an id: a reconnect is a new call.
 *
 * The config is read once, when the handler is built (readConfig), and the route table is built then from the logins
 * as their layers loaded them: a refusal is HttpConfigRefused. Each request's response is its answer's (httpAnswers).
 */
export const httpHandler = <const Ls extends readonly [AnyLogin, ...Array<AnyLogin>]>(
	config: HttpConfig<Ls>
): Effect.Effect<HttpHandler, HttpConfigRefused, DbLayerOf<Ls[number]>> =>
	Effect.map(
		httpAnswers(config),
		(answer) =>
			(request: Request): Promise<Response> =>
				Promise.resolve(answer(request).response)
	)
