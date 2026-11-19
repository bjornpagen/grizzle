/** What the properties of routes.test.ts read: its spaces, models and helpers. */

import { timerMaxMs, timerMinMs } from "@bjornpagen/grizzle/runtime"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	characterOf,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { type CallErrorKind, callErrors } from "#compiler/live/index.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { type HttpHandler } from "#http/index.ts"
import { readStream, type StreamRead } from "#test/support/event-stream.ts"
import {
	type CaseSketch,
	caseSketchGen,
	orderedCaseSketchGen
} from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { upTo } from "#test/support/up-to.ts"

export type Feature =
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
export const fileRoutes = (file: ServedFile): ReadonlyArray<FileRoute> =>
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
export const probesGen =
	(routes: number): Gen<ReadonlyArray<Probe>> =>
	(source) =>
		upTo(source.draw(int(1, 8)), () => source.draw(probeGen(routes)))

/** The requirement a drawn probe seldom meets, which a case whose turn aims at it is built to meet (see the header). */
export const noBearer: Feature = "a route called with no bearer token"

export const pagedRoute: Feature = "a paged member's route"

/**
 * How a case draws its login and its probes: as drawn; aimed at a call with no bearer token; or aimed at a paged
 * member, its case's every read ordered (generate.ts orderedCaseSketchGen) and its login's first role reading each
 * paged (served-login.ts pagedLoginGen) (see the header).
 */
type Probing = "drawn" | "no bearer" | "paged"

/** A case's sketch: its schema's, its law level, and how it draws its login and its probes. */
type Sketch = readonly [CaseSketch, LawLevel, Probing]

/** A sketch whose case, login and probes are drawn as `probing` says. */
export const sketchGen =
	(probing: Probing): Gen<Sketch> =>
	(source) => [
		source.draw(probing === "paged" ? orderedCaseSketchGen : caseSketchGen),
		source.draw(lawLevelGen),
		probing
	]

/**
 * The probes of a case aimed at a call with no bearer token (see the header): its drawn ones, then a call naming its
 * wire, with no Authorization header, of a route whose role reads a context, drawn among them, where the login serves
 * one.
 */
export const noBearerProbesGen =
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
export const probeRequest = (
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
export const refusedAs = (
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
export const answered = (handler: HttpHandler, request: Request) =>
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
export const heartbeatGen: Gen<number> = oneOf<number>([
	constant(timerMinMs),
	constant(timerMaxMs),
	int(timerMinMs, timerMaxMs)
])
