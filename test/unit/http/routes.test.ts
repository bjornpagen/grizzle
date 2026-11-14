/**
 * An HTTP handler's routes are exactly its served logins' members, and every request is answered as a stream of
 * events, 200, whatever it asks. Over generated public schemas (test/support/oracle/public), each extended by a drawn
 * law level, and logins drawn over them (test/support/served-login.ts: roles that read the case's queries, an ordered
 * one whole or paged, write relations through ChangeSets, and perhaps a query entry reading a context), each compiled
 * as `grizzle generate` compiles it, served as an application serves its committed file, its layer built with no
 * database, given a live source that connects nothing (test/support/live-layer.ts), and the handler over it
 * (http/handler.ts httpHandler):
 *
 * - The routes are the members: httpRoutes lists exactly `POST /<login>/<role>/<program>` for each member of each role
 *   the served file holds, and nothing else.
 * - The handler dispatches by them: a drawn request line, a route's mutated (another method, a query, a segment
 *   renamed, added or dropped, a trailing slash) or its own, answers `route` exactly when no member names it.
 * - A route's call is refused in its order, before any SQL: a request naming no wire digest is an `input`, one naming
 *   another form `stale`; an Authorization header that is no bearer token, or none where the role reads a context, is
 *   `tokenRefused`; a body that is no JSON is an `input`.
 * - Every answer is 200, text/event-stream, no cache and no proxy buffering, and its stream, read as WHATWG HTML reads
 *   one (test/support/event-stream.ts), is one `error` event whose CallError has its kind's retry, then `end`, with no
 *   `id` and no `retry` field.
 *
 * The oracle is the served file itself, its roles' members and contexts, and the order of the call's checks.
 *
 * A drawn probe calls with no bearer token a route whose role reads a context only as one in nine calls of such a
 * route, and the streams the suite's label fixes held none, so a case whose turn aims at it (Case.steering) is
 * constructed to: its login's first role holds the query entry wherever a field may carry a claim (served-login.ts
 * liveLoginGen), and after its drawn probes it calls a route of a role reading a context, naming the route's wire, with
 * no Authorization header.
 *
 * Plants (~/.cache/grizzle-release/LIVE-HTTP/plants): http-route-non-member.patch (the table serves a route no member
 * names: the routes are not the members); http-status-error.patch (a request line no route serves answered 404: the
 * answer is not the stream). Plant (~/.cache/grizzle-release/STEERSWEEP/plants): http-token-after-body.patch (a call's
 * missing token checked after its body's JSON: a call with no bearer token and no JSON body is an `input`).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	characterOf,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Result as Answered,
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { served } from "#adapter/public/layer.ts"
import { isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { type CallErrorKind, callErrors } from "#compiler/live/index.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { httpHandler, httpRoutes, type HttpHandler } from "#http/index.ts"
import { offlineConnection } from "#test/pg/cli/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { readStream, type StreamRead } from "#test/support/event-stream.ts"
import { caseHang, nodeTimerMax, nodeTimerMin } from "#test/support/limits.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { clusterPool } from "#test/support/pg.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	liveLoginGen,
	loginGen
} from "#test/support/served-login.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

type Feature =
	| "a route of a role reading a context"
	| "a route of a role reading none"
	| "a paged member's route"
	| "a change member's route"
	| "a route named with no wire digest"
	| "a route named with another wire digest"
	| "a route called with no bearer token"
	| "a route called with a refused Authorization header"
	| "a route whose body is no JSON"
	| "a line of another method"
	| "a line with a query"
	| "a line naming no member"
	| "a drawn line a member names"

/** One served route as its file holds it: its request line, its member's kind, its wire's digest, and its role. */
interface FileRoute {
	readonly line: string
	readonly kind: ServedFile["roles"][number]["members"][number]["kind"]
	readonly digest: string
	readonly readsContext: boolean
}

/** The routes a served file's members give, the oracle: one per member of each of its roles. */
const fileRoutes = (file: ServedFile): ReadonlyArray<FileRoute> =>
	Arr.flatMap(file.roles, (role) =>
		Arr.map(role.members, (member) => ({
			line: `POST /${file.login}/${role.name}/${member.name}`,
			kind: member.kind,
			digest: member.wire.digest,
			readsContext: role.contexts.length > 0
		}))
	)

/** How a probe of a served route names its member's wire, and how it authorizes. */
type Wire = "named" | "absent" | "other"
type Authorization = "bearer" | "none" | "basic"

/** One request a case sends: a call of a served route, or a drawn request line no header names a wire for. */
type Probe =
	| {
			readonly kind: "route"
			readonly route: number
			readonly wire: Wire
			readonly authorization: Authorization
	  }
	| {
			readonly kind: "line"
			readonly method: string
			readonly target: Mutation
			readonly route: number
	  }

/** How a drawn request line's target differs from a route's. */
type Mutation =
	| { readonly kind: "same" }
	| { readonly kind: "query" }
	| { readonly kind: "trailing" }
	| { readonly kind: "renamed"; readonly segment: number; readonly name: string }
	| { readonly kind: "added"; readonly name: string }
	| { readonly kind: "dropped"; readonly segment: number }

/** A declared name's characters: ASCII letters, digits and underscores. */
const nameGen: Gen<string> = string(
	characterOf(["a", "b", "x", "_", "1", "p", "r", "o", "l", "e"]),
	{ min: 1, max: 6 }
)

/** A mutation of a target's path: a trailing slash, or a segment renamed, added or dropped. */
const pathMutationGen: Gen<Mutation> = (source) => {
	const kind = source.draw(element(["trailing", "renamed", "added", "dropped"] as const))
	switch (kind) {
		case "trailing":
			return { kind }
		case "renamed":
			return { kind, segment: source.draw(int(0, 2)), name: source.draw(nameGen) }
		case "added":
			return { kind, name: source.draw(nameGen) }
		case "dropped":
			return { kind, segment: source.draw(int(0, 2)) }
	}
}

/** Any mutation of a target: none, a query, or one of its path. */
const mutationGen: Gen<Mutation> = oneOf<Mutation>([
	constant({ kind: "same" }),
	constant({ kind: "query" }),
	pathMutationGen
])

/** The methods no route answers. */
const otherMethodGen: Gen<string> = element(["GET", "PUT", "DELETE", "PATCH", "OPTIONS"] as const)

/** A drawn request line: route `route`'s, under a method drawn by `method` and its target mutated as `target` draws. */
const lineGen =
	(route: number, method: Gen<string>, target: Gen<Mutation>): Gen<Probe> =>
	(source) => ({
		kind: "line",
		route,
		method: source.draw(method),
		target: source.draw(target)
	})

/**
 * One probe of a login of `routes` routes, its route drawn first: half of them a call of the route, and the rest a
 * request line, each kind of line constructed: the route's under a method no route answers, any target; its own target
 * with a query; its path mutated; and its own line, sent as a drawn line is, with no header naming its wire.
 */
const probeGen =
	(routes: number): Gen<Probe> =>
	(source) => {
		const route = source.draw(int(0, routes - 1))
		return source.draw(
			weighted<Probe>([
				[
					4,
					(s) => ({
						kind: "route",
						route,
						wire: s.draw(element(["named", "absent", "other"] as const)),
						authorization: s.draw(element(["bearer", "none", "basic"] as const))
					})
				],
				[1, lineGen(route, otherMethodGen, mutationGen)],
				[1, lineGen(route, constant("POST"), constant<Mutation>({ kind: "query" }))],
				[1, lineGen(route, constant("POST"), pathMutationGen)],
				[1, lineGen(route, constant("POST"), constant<Mutation>({ kind: "same" }))]
			])
		)
	}

/** Between one and eight probes of a login of `routes` routes. */
const probesGen =
	(routes: number): Gen<ReadonlyArray<Probe>> =>
	(source) =>
		upTo(source.draw(int(1, 8)), () => source.draw(probeGen(routes)))

/** The requirement a drawn probe seldom meets, which a case whose turn aims at it is built to meet (see the header). */
const noBearer: Feature = "a route called with no bearer token"

/** Whether the case's turn aims at a call with no bearer token (Case.steering); a rotating or kept case never does. */
const aimsNoBearer = (c: Case<Feature>): boolean =>
	Option.exists(c.steering, (pending) => pending.aimed(noBearer))

/**
 * The probes of a case aimed at a call with no bearer token (see the header): its drawn ones, then a call naming its
 * wire, with no Authorization header, of a route whose role reads a context, drawn among them, where the login serves
 * one.
 */
const noBearerProbesGen =
	(routes: ReadonlyArray<FileRoute>): Gen<ReadonlyArray<Probe>> =>
	(source) => {
		const drawnProbes = source.draw(probesGen(routes.length))
		return Arr.match(
			Arr.flatMap(routes, (r, place) => (r.readsContext ? [place] : [])),
			{
				onEmpty: () => drawnProbes,
				onNonEmpty: (places): ReadonlyArray<Probe> => [
					...drawnProbes,
					{
						kind: "route",
						route: source.draw(element(places)),
						wire: "named",
						authorization: "none"
					}
				]
			}
		)
	}

/** What every route's request line starts with: its method and the space after it. */
const routeMethod = "POST "

/** The target of `line`, mutated. */
const mutated = (line: string, mutation: Mutation): string => {
	const target = Str.slice(routeMethod.length)(line)
	const segments = Str.split("/")(Str.slice(1)(target))
	switch (mutation.kind) {
		case "same":
			return target
		case "query":
			return `${target}?q=1`
		case "trailing":
			return `${target}/`
		case "renamed":
			return `/${Arr.join(
				Arr.map(segments, (segment, place) =>
					place === mutation.segment ? mutation.name : segment
				),
				"/"
			)}`
		case "added":
			return `${target}/${mutation.name}`
		case "dropped":
			return `/${Arr.join(Arr.remove(segments, mutation.segment), "/")}`
	}
}

/** The origin every probe's URL is read against: a name no host holds (RFC 2606). */
const origin = "http://grizzle.invalid"

/** A probe as a Request, and the error kind the oracle expects its answer to carry, noting what it exercises. */
const probeRequest = (
	routes: ReadonlyArray<FileRoute>,
	lines: ReadonlySet<string>,
	probe: Probe,
	note: (feature: Feature) => void
): { readonly request: Request; readonly expected: CallErrorKind } => {
	const route = defined(routes[probe.route], "the probe's route")
	if (probe.kind === "line") {
		const target = mutated(route.line, probe.target)
		const line = `${probe.method} ${target}`
		note(
			lines.has(line)
				? "a drawn line a member names"
				: probe.method !== "POST"
					? "a line of another method"
					: probe.target.kind === "query"
						? "a line with a query"
						: "a line naming no member"
		)
		return {
			request: new Request(`${origin}${target}`, {
				method: probe.method,
				...(probe.method === "GET" ? {} : { body: "{" })
			}),
			expected: lines.has(line) ? "input" : "route"
		}
	}
	note(
		route.readsContext ? "a route of a role reading a context" : "a route of a role reading none"
	)
	if (route.kind === "paged") {
		note("a paged member's route")
	}
	if (route.kind === "change") {
		note("a change member's route")
	}
	const headers = new Headers()
	if (probe.wire !== "absent") {
		headers.set("grizzle-wire", probe.wire === "named" ? route.digest : `${route.digest}0`)
	}
	if (probe.authorization !== "none") {
		headers.set("authorization", probe.authorization === "bearer" ? "Bearer e30" : "Basic e30=")
	}
	const expected = ((): CallErrorKind => {
		if (probe.wire === "absent") {
			note("a route named with no wire digest")
			return "input"
		}
		if (probe.wire === "other") {
			note("a route named with another wire digest")
			return "stale"
		}
		if (probe.authorization === "basic") {
			note("a route called with a refused Authorization header")
			return "tokenRefused"
		}
		if (probe.authorization === "none" && route.readsContext) {
			note("a route called with no bearer token")
			return "tokenRefused"
		}
		note("a route whose body is no JSON")
		return "input"
	})()
	return {
		request: new Request(`${origin}${Str.slice(routeMethod.length)(route.line)}`, {
			method: "POST",
			headers,
			body: "{"
		}),
		expected
	}
}

/** That an answer is the stream of one `error` of kind `expected`, then `end`, as every refused call answers. */
const refusedAs = (
	response: Response,
	read: StreamRead,
	expected: CallErrorKind,
	printed: () => string
): void => {
	assert.equal(response.status, 200, `every answer is 200\n${printed()}`)
	assert.deepEqual(
		[
			response.headers.get("content-type"),
			response.headers.get("cache-control"),
			response.headers.get("x-accel-buffering")
		],
		["text/event-stream", "no-cache", "no"],
		`every answer is an unbuffered event stream\n${printed()}`
	)
	assert.deepEqual(
		Arr.sort([...read.fields], Order.String),
		["data", "event"],
		`no event carries an id or a retry\n${printed()}`
	)
	assert.deepEqual(
		Arr.map(read.events, (e) => e.event),
		["error", "end"],
		`a refused call is its error, then its end\n${printed()}`
	)
	const [error, end] = read.events
	const data: unknown = trustedJson<unknown>(defined(error, "the error event").data)
	const carried = isRecord(data) && isRecord(data["error"]) ? data["error"] : {}
	assert.deepEqual(
		[carried["kind"], carried["retry"]],
		[expected, callErrors[expected].retry],
		`the error is ${expected}, with its kind's retry\n${printed()}`
	)
	assert.equal(defined(end, "the end event").data, "{}", `end carries {}\n${printed()}`)
}

/** Every probe's answer, read whole: a refused call's stream ends. */
const answered = (handler: HttpHandler, request: Request) =>
	Effect.gen(function* () {
		const response = yield* Effect.promise(() => handler(request))
		const body: ReadableStream<Uint8Array> | null = response.body
		if (body === null) {
			return assert.fail("every answer has a body")
		}
		return { response, read: yield* readStream(body, () => false) }
	})

/**
 * The heartbeat's interval a case's handler is built with: a Node timer's delay, from the least to the longest, its
 * range's ends or one between. A heartbeat is a comment line, so no answer's events depend on it.
 */
const heartbeatGen: Gen<number> = oneOf<number>([
	constant(nodeTimerMin.value),
	constant(nodeTimerMax.value),
	int(nodeTimerMin.value, nodeTimerMax.value)
])

describe("an HTTP handler's routes", () => {
	it.effect(
		"are exactly the served members, and every request is answered as one stream of events",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the served file's members, their roles' contexts, and the order of a call's checks"
						},
						suite: "unit/http/routes",
						draw: drawn(
							(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a route of a role reading a context",
								"a route of a role reading none",
								"a paged member's route",
								"a change member's route",
								"a route named with no wire digest",
								"a route named with another wire digest",
								"a route called with no bearer token",
								"a route called with a refused Authorization header",
								"a route whose body is no JSON",
								"a line of another method",
								"a line with a query",
								"a line naming no member",
								"a drawn line a member names"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([sketch, level], notes) =>
						Effect.gen(function* () {
							const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
							const aimed = aimsNoBearer(notes)
							const shapes = notes.draw((aimed ? liveLoginGen : loginGen)(schema))
							const compiled = yield* Effect.result(
								compiledLogin(drawnLogin(schema, shapes), schema.laws.codes)
							)
							if (Answered.isFailure(compiled)) {
								return
							}
							const { json, back } = compiled.success
							const printed = () =>
								`${printCase(schema.case)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
							const login = served<AnyLogin>(json, back.login)
							const routes = fileRoutes(back)
							const lines = new Set(Arr.map(routes, (r) => r.line))
							const listed = httpRoutes([login])
							assert.ok(Answered.isSuccess(listed), `one login's routes are distinct\n${printed()}`)
							assert.deepEqual(
								Arr.sort([...listed.success.keys()], Order.String),
								Arr.sort([...lines], Order.String),
								`the routes are exactly the served members\n${printed()}`
							)
							if (!Arr.isReadonlyArrayNonEmpty(routes)) {
								return
							}
							const probes = notes.draw(
								aimed ? noBearerProbesGen(routes) : probesGen(routes.length)
							)
							yield* Effect.gen(function* () {
								const handler = yield* httpHandler({
									logins: [login],
									heartbeatMs: notes.draw(heartbeatGen)
								})
								for (const probe of probes) {
									const { request, expected } = probeRequest(routes, lines, probe, notes.note)
									const { response, read } = yield* answered(handler, request)
									refusedAs(
										response,
										read,
										expected,
										() => `${printed()}\n${Formatter.format(probe)}`
									)
								}
							}).pipe(
								withLayer(
									servedSourcedLayer(offlineDecoders, {
										...offlineConnection,
										pool: clusterPool,
										login,
										verify: testVerify
									})
								),
								Effect.orDie
							)
						}).pipe(Effect.scoped)
				)
			)
	)
})
