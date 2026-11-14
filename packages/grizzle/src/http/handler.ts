import { Array as Arr, type Context, Data, Effect, Option, Result, Stream } from "effect"
import { faultAt, timerDelay, timerRule } from "#adapter/connection/config.ts"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { servedContext } from "#adapter/db/served.ts"
import type { Token } from "#adapter/db/token.ts"
import { readHost, toResult } from "#adapter/engine.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import { settingFaultText, type SettingFault } from "#adapter/errors/failures.ts"
import { doorRefusal, openCallError } from "#adapter/live/call-error.ts"
import { type HeldRole, heldRole, type ReadLogin, readServedLogin } from "#adapter/pool/served.ts"
import type { LoadedMember, LoadedRole } from "#adapter/served/load.ts"
import type { DbLayerOf, ServedLogin } from "#adapter/types/layer.ts"
import type { CallErrorOf, FailureOf } from "#compiler/live/index.ts"
import type { AnyLogin } from "#compiler/plan/common.ts"
import {
	parseInput,
	readCaller,
	slotEncoders,
	type WireFault,
	type WireJson,
	type WireOptions
} from "#compiler/plan/runtime.ts"
import { listFrame, refusedFrames, setFrame, type SlotEncoders, writeFrame } from "#http/events.ts"
import { authorizationToken, bodyJson, requestLine, wireNamed } from "#http/request.ts"
import { type HttpRoute, type RouteOf, routeLine, routeTable } from "#http/routes.ts"
import { type SseEvent, sseHeaders, sseStream } from "#http/sse.ts"

/**
 * A fetch-style handler: a request in, its response out. Deno.serve, Bun.serve and a Worker's fetch take one as it is,
 * and nodeListener mounts one on node:http's or node:http2's server.
 */
export type HttpHandler = (request: Request) => Promise<Response>

/**
 * httpHandler's config: the served logins whose roles' members it serves, each a login served(...) built, whose
 * DbLayer the handler's Effect requires, and the interval of the heartbeat every answer carries, in milliseconds, an
 * integer from 1 to 2,147,483,647: the caller's, since grizzle states no interval of its own.
 */
export interface HttpConfig<Ls extends ReadonlyArray<AnyLogin>> {
	readonly logins: { readonly [K in keyof Ls]: ServedLogin<Ls[K]> }
	readonly heartbeatMs: number
}

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
const httpSettings: ReadonlyArray<string> = ["logins", "heartbeatMs"]

/** The setting a handler's config reads off its typed value, leaving it unread on the copy: its logins. */
const typedSettings: ReadonlySet<string> = new Set(["logins"])

const refusedSetting = (fault: SettingFault): HttpConfigRefused =>
	new HttpConfigRefused({ reason: { kind: "setting", fault } })

/** A handler's config read: its logins, each as a config reads a served login, and its heartbeat's interval. */
interface ReadConfig {
	readonly logins: Arr.NonEmptyReadonlyArray<ReadLogin>
	readonly heartbeatMs: number
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
			? Result.succeed({ logins, heartbeatMs })
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
 * context, since its contexts are read from a token's claims (a Db.open of it requires one); a role reading one refuses
 * a request without a token.
 */
const openingToken = (
	role: LoadedRole,
	given: Option.Option<Token>
): Result.Result<Option.Option<Token>, FailureOf<"door">> =>
	Arr.isReadonlyArrayNonEmpty(role.contexts) && Option.isNone(given)
		? Result.fail(
				doorRefusal(
					"TokenAbsent",
					`role ${role.name} reads a context, and the call gives no bearer token`
				)
			)
		: Result.succeed(given)

/**
 * A member's events as their frames, by the member's shape: a set read's, an ordered read's, either at its call's
 * instant alone, whose answer ends after its ready, or a write's, each event framed by its payload (events.ts), its slots
 * encoded by the member's wire.
 */
const framed = (
	calls: ServedCalls,
	slots: SlotEncoders,
	input: unknown
): Stream.Stream<SseEvent> => {
	switch (calls.shape) {
		case "set":
			return Stream.map(calls.watch(input), (event) => setFrame(slots, event))
		case "list":
			return Stream.map(calls.watch(input), (event) => listFrame(slots, event))
		case "instantSet":
			return Stream.map(calls.answer(input), (event) => setFrame(slots, event))
		case "instantList":
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
	request: Request
): Effect.Effect<Stream.Stream<SseEvent>, FailureOf<"door" | "open">> =>
	Effect.gen(function* () {
		yield* Effect.fromResult(wireNamed(request, route.member.loaded.wire.digest))
		const given = yield* Effect.fromResult(authorizationToken(request))
		const token = yield* Effect.fromResult(openingToken(route.role.held.role, given))
		const body = yield* bodyJson(request)
		const ctx = yield* Effect.mapError(servedContext(route.role.held, token), openCallError)
		const member = route.member
		const input = yield* Effect.fromResult(
			Result.mapError(toResult(parseInput(member.loaded.wire.member.input, body)), inputRefused)
		)
		return framed(memberCalls(ctx, member.loaded), member.slots, input)
	})

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
 * The events answering `request`: the call of the route its request line names (routeCall), or, for a line no route
 * serves, its refusal. Every refusal is the call's error, then its end, so the stream never fails.
 */
const answerEvents = (
	table: ReadonlyMap<string, ServedRoute>,
	request: Request
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
				Effect.match(routeCall(route, request), {
					onFailure: (error) => Stream.fromIterable(refusedFrames(route.member.slots.error, error)),
					onSuccess: (events) => events
				})
			)
	})
}

/**
 * httpHandler(config): a fetch-style handler serving every member of every role of the config's served logins, one
 * route each, `POST /<login>/<role>/<program>` (routes.ts), built in an Effect that requires each login's DbLayer and
 * captures the context it runs in once, so the handler lives as long as the caller's runtime or layer scope, and
 * grizzle builds no runtime of its own.
 *
 * Every request is answered 200 with a text/event-stream body (sse.ts) carrying its call's events: its member's watch
 * (db/handles.ts memberCalls), reset, upserts, ready and the live changes for a read, reset, upserts, ready then end
 * for a read at its call's instant (a clocked member's answer), its outcome then end for a write.
 * Every failure is one `error` event carrying its CallError, then `end`: a request line no route serves; a request
 * naming no `grizzle-wire` digest, or one naming another form of the member than the one served (`stale`, so a client
 * never decodes by a form the server no longer serves); a token refused, or missing where the role reads a context; a
 * body that is not JSON, or not the member's input; and any failure of the call itself. The Db is opened as Db.open opens one (db/served.ts servedContext), with the bearer token of the
 * Authorization header, through the layer's own verify and the role's contexts, so a token means one thing to either.
 *
 * The response body pulls the call's stream: an event is read only as the client reads, and a client that goes away
 * (the request's signal aborting, or the body cancelled) interrupts the call, which releases what it holds. A heartbeat
 * comment every `heartbeatMs` keeps a quiet stream open. No event carries an id: a reconnect is a new call.
 *
 * The config is read once, when the handler is built (readConfig), and the route table is built then from the logins
 * as their layers loaded them: a refusal is HttpConfigRefused.
 */
export const httpHandler = <const Ls extends readonly [AnyLogin, ...Array<AnyLogin>]>(
	config: HttpConfig<Ls>
): Effect.Effect<HttpHandler, HttpConfigRefused, DbLayerOf<Ls[number]>> =>
	Effect.gen(function* () {
		const read = yield* Effect.fromResult(Result.mapError(readConfig(config), refusedSetting))
		const context = yield* Effect.context<DbLayerOf<Ls[number]>>()
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
		return (request: Request): Promise<Response> =>
			Promise.resolve(
				new Response(
					Stream.toReadableStreamWith(
						sseStream(answerEvents(table, request), read.heartbeatMs),
						context,
						{ signal: request.signal }
					),
					{ status: 200, headers: sseHeaders }
				)
			)
	})
