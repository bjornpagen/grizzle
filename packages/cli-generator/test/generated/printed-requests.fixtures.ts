import { createServer } from "node:net"
import { jsonText, type Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Duration, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	workerFixture
} from "#test/support/cli-package.ts"
import { listen } from "#test/support/connection.ts"
import type { WireRequest } from "#test/support/http.ts"
import { type PrintedError, printedText } from "#test/support/printed.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** What the printed-requests properties (printed-requests.test.ts) draw and their fixture: the requests and failures. */

const OBJECT = { "application/json": { schema: { type: "object" } } } as const

/** A secured GET with a header parameter and a 404 declaring its request id, a secured POST, and an open GET. */
const spec = jsonText({
	openapi: "3.1.0",
	info: { title: "Printed requests", version: "1.0.0" },
	security: [{ token: [] }],
	components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
	paths: {
		"/widgets": {
			post: {
				operationId: "widgets-create",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { name: { type: "string" }, size: { type: "integer" } }
							}
						}
					}
				},
				responses: { "201": { description: "Created.", content: OBJECT } }
			}
		},
		"/widgets/{id}": {
			get: {
				operationId: "widgets-get",
				parameters: [
					{ name: "id", in: "path", required: true, schema: { type: "string" } },
					{ name: "X-Trace", in: "header", required: false, schema: { type: "string" } }
				],
				responses: {
					"200": { description: "The widget.", content: OBJECT },
					"404": {
						description: "No such widget.",
						headers: { "X-Request-Id": { schema: { type: "string" } } },
						content: OBJECT
					}
				}
			}
		},
		"/status": {
			get: {
				operationId: "status-get",
				security: [],
				responses: { "200": { description: "The status.", content: OBJECT } }
			}
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonText({
		package: { name: "printed-requests", version: "1.0.0" },
		binName: "om",
		envPrefix: "OM",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The bearer token a configured run carries, which no output may show. */
export const TOKEN = "zq-bearer-token"

/** The placeholder a credential prints as in a dry run. */
const PLACEHOLDER = "Bearer <redacted:token>"

/** A response body marker, which `--verbose` must never copy to stderr. */
export const MARKER = "zq-response"

/** An operation of the box. */
type Operation = "get" | "create" | "status"

const POINTERS: Readonly<Record<Operation, string>> = {
	get: "/paths/~1widgets~1{id}/get",
	create: "/paths/~1widgets/post",
	status: "/paths/~1status/get"
}

/** What a create sends: no body input, its flags, or `--body`. */
type Body =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "flags"; name: Option.Option<string>; size: Option.Option<number> }>
	| Readonly<{ kind: "text"; name: string }>

/** A request the property runs: a GET of a widget with or without a trace, or a create. */
type Request =
	| Readonly<{ kind: "get"; id: string; trace: Option.Option<string> }>
	| Readonly<{ kind: "create"; body: Body }>

/** A header value or body field, given as `--flag=value`, as a generated CLI's help asks for a value that may start
 * with `-`. */
const WORD: Gen<string> = string(characterOf(["a", "Z", "0", "-", "_"]), { min: 1, max: 6 })

/** A path id: never led by `-`, which the parser takes for a flag, since a positional has no `--flag=value` form. */
const ID: Gen<string> = (source) =>
	`${characterOf(["a", "Z", "0", "_"])(source)}${string(characterOf(["a", "Z", "0", "-", "_"]), { min: 0, max: 5 })(source)}`

const BODY: Gen<Body> = weighted<Body>([
	[1, constant<Body>({ kind: "none" })],
	[
		2,
		(source) => ({ kind: "flags", name: option(WORD)(source), size: option(int(0, 99))(source) })
	],
	[1, (source) => ({ kind: "text", name: WORD(source) })]
])

const REQUEST: Gen<Request> = weighted<Request>([
	[1, (source) => ({ kind: "get", id: ID(source), trace: option(WORD)(source) })],
	[1, (source) => ({ kind: "create", body: BODY(source) })]
])

/** The arguments after the command that give a request. */
export const requestArgs = (request: Request): ReadonlyArray<string> => {
	switch (request.kind) {
		case "get":
			return Arr.prepend(
				Option.match(request.trace, {
					onNone: () => [],
					onSome: (trace) => [`--x-trace=${trace}`]
				}),
				request.id
			)
		case "create":
			switch (request.body.kind) {
				case "none":
					return []
				case "flags":
					return Arr.flatten([
						Option.match(request.body.name, {
							onNone: () => [],
							onSome: (name) => [`--name=${name}`]
						}),
						Option.match(request.body.size, {
							onNone: () => [],
							onSome: (size) => [`--size=${String(size)}`]
						})
					])
				case "text":
					return [`--body=${jsonText({ name: request.body.name })}`]
			}
	}
}

export const operationOfRequest = (request: Request): Operation => request.kind

/** A dry-run print split apart: its request line, its header lines and the body after the blank line. */
type Printed = Readonly<{ requestLine: string; headerLines: ReadonlyArray<string>; body: string }>

export const printedOf = (stdout: string): Printed => {
	const [head, body] = Option.match(Str.indexOf("\n\n")(stdout), {
		onNone: () => [stdout, ""],
		onSome: (at) => [Str.slice(0, at)(stdout), Str.slice(at + 2)(stdout)]
	})
	const [requestLine, ...headerLines] = Str.split("\n")(head)
	return { requestLine, headerLines, body: Str.trimEnd(body) }
}

/** The `--verbose` request block: each `> ` line, its prefix removed, the request line first. */
export const verboseRequest = (stderr: string): ReadonlyArray<string> =>
	Arr.flatMap(Str.split("\n")(stderr), (line) =>
		Str.startsWith("> ")(line) ? [Str.slice(2)(line)] : []
	)

/** What the property compares of one request's three runs. */
export type Shown = Readonly<{
	dryRunRequestLine: string
	dryRunExit: number
	dryRunConnections: number
	dryRunStderr: string
	withoutCredential: string
	verboseExit: number
	verboseLinesOnly: boolean
	verboseRequest: ReadonlyArray<string>
	verboseBody: Option.Option<Json>
	responseOnStderr: boolean
	tokenShown: boolean
	printedHeaders: ReadonlyArray<string>
	sentNames: ReadonlyArray<string>
	printedBody: string
}>

/** What the contract fixes of the three runs, from the dry run's own lines and the request that reached the server. */
export const expectedShown = (
	printed: Printed,
	dryRunStdout: string,
	sent: WireRequest,
	base: string,
	request: Request
): Shown => {
	const requestLine = `${METHODS[request.kind]} ${base}${pathOf(request)} HTTP/1.1`
	return {
		dryRunRequestLine: requestLine,
		dryRunExit: 0,
		dryRunConnections: 0,
		dryRunStderr: "",
		withoutCredential: dryRunStdout,
		verboseExit: 0,
		verboseLinesOnly: true,
		verboseRequest: Arr.prepend(printed.headerLines, requestLine),
		verboseBody: Option.some({ marker: MARKER }),
		responseOnStderr: false,
		tokenShown: false,
		printedHeaders: sentLinesOf(sent),
		sentNames: Arr.sort(expectedNames(request), Order.String),
		printedBody: printedText(sent.body)
	}
}

const METHODS: Readonly<Record<Request["kind"], string>> = { get: "GET", create: "POST" }

const pathOf = (request: Request): string =>
	request.kind === "get" ? `/widgets/${request.id}` : "/widgets"

/** The headers a request carries: the accept and user agent every send has, the credential, a trace, a body's type
 * and length. */
const expectedNames = (request: Request): ReadonlyArray<string> =>
	Arr.flatten([
		["accept", "authorization", "user-agent"],
		request.kind === "get" && Option.isSome(request.trace) ? ["x-trace"] : [],
		request.kind === "create" ? ["content-length", "content-type"] : []
	])

/** The headers undici writes on every request itself, which neither print lists. */
const TRANSPORT_HEADERS: ReadonlyArray<string> = ["connection", "host"]

/**
 * The header lines a send carried, in the order it carried them, but those undici writes itself, each with the value it
 * carried and the credential as its placeholder.
 */
const sentLinesOf = (sent: WireRequest): ReadonlyArray<string> =>
	Arr.flatMap(sent.headers, ([name, value]) => {
		const lower = Str.toLowerCase(name)
		return Arr.contains(TRANSPORT_HEADERS, lower)
			? []
			: [`${lower}: ${lower === "authorization" ? PLACEHOLDER : value}`]
	})

/** The names of the headers a send carried, but those undici writes itself, by name. */
export const sentNamesOf = (sent: WireRequest): ReadonlyArray<string> =>
	Arr.sort(
		Arr.filter(
			Arr.map(sent.headers, ([name]) => Str.toLowerCase(name)),
			(name) => !Arr.contains(TRANSPORT_HEADERS, name)
		),
		Order.String
	)

/** The response every send gets: an object holding the marker. */
export const answered = (status: number): ScriptedResponse => ({
	status,
	headers: [["Content-Type", "application/json"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes(jsonText({ marker: MARKER })) }
})

/** A situation the property reaches. */
export type ShownFeature =
	| "a GET"
	| "a header parameter"
	| "a create with no body input"
	| "a create by its flags"
	| "a create by --body"

export const SHOWN_FEATURES: Arr.NonEmptyReadonlyArray<ShownFeature> = [
	"a GET",
	"a header parameter",
	"a create with no body input",
	"a create by its flags",
	"a create by --body"
]

export const shownFeatures = (request: Request): ReadonlyArray<ShownFeature> => {
	switch (request.kind) {
		case "get":
			return Option.isSome(request.trace) ? ["a GET", "a header parameter"] : ["a GET"]
		case "create":
			switch (request.body.kind) {
				case "none":
					return ["a create with no body input"]
				case "flags":
					return ["a create by its flags"]
				case "text":
					return ["a create by --body"]
			}
	}
}

/** A request made to reach `focus`; with no focus, drawn. */
const requestFor = (focus: Option.Option<ShownFeature>): Gen<Request> => {
	if (Option.isNone(focus)) {
		return REQUEST
	}
	switch (focus.value) {
		case "a GET":
			return (source) => ({ kind: "get", id: ID(source), trace: Option.none() })
		case "a header parameter":
			return (source) => ({ kind: "get", id: ID(source), trace: Option.some(WORD(source)) })
		case "a create with no body input":
			return constant<Request>({ kind: "create", body: { kind: "none" } })
		case "a create by its flags":
			return (source) => ({
				kind: "create",
				body: { kind: "flags", name: Option.some(WORD(source)), size: option(int(0, 99))(source) }
			})
		case "a create by --body":
			return (source) => ({ kind: "create", body: { kind: "text", name: WORD(source) } })
	}
}

const FOCUS: Gen<Option.Option<ShownFeature>> = weighted<Option.Option<ShownFeature>>([
	[1, constant(Option.none())],
	[1, map(element(SHOWN_FEATURES), Option.some)]
])

/** A failed run the JSON error exhaustion makes. */
export type Failure =
	| "a 404 with its request id"
	| "a 404 without one"
	| "a refused connection"
	| "a missing credential"
	| "a body that is not JSON"
	| "an unknown flag"
	| "a Retry-After past the timeout"

export const FAILURES: Arr.NonEmptyReadonlyArray<Failure> = [
	"a 404 with its request id",
	"a 404 without one",
	"a refused connection",
	"a missing credential",
	"a body that is not JSON",
	"an unknown flag",
	"a Retry-After past the timeout"
]

/** A request id the server sends with a 404. */
const REQUEST_ID = "zq-request-id"

/** What the oracle compares of a JSON error run. */
export type Rendered = Readonly<{
	exitCode: number
	connections: number
	stdout: string
	lines: number
	kind: Option.Option<string>
	keys: ReadonlyArray<string>
	status: Option.Option<number>
	requestId: Option.Option<string>
	retryAfter: Option.Option<number>
	bodyHasMarker: boolean
}>

/** The members a JSON error line holds, by name in code point order: its kind and message, and each optional one given. */
export const keysOf = (error: PrintedError): ReadonlyArray<string> =>
	Arr.sort(
		Arr.appendAll(
			["kind", "message"],
			Arr.flatMap(
				[
					["body", error.body],
					["data", error.data],
					["matched", error.matched],
					["operation", error.operation],
					["requestId", error.requestId],
					["retryAfter", error.retryAfter],
					["status", error.status]
				] as const,
				([key, value]) => (Option.isSome(value) ? [key] : [])
			)
		),
		Order.String
	)

/** The run each failure gives. */
export const expectedRendered = (failure: Failure): Rendered => {
	const rendered = (
		kind: string,
		keys: ReadonlyArray<string>,
		exitCode: number,
		connections: number
	): Rendered => ({
		exitCode,
		connections,
		stdout: "",
		lines: 1,
		kind: Option.some(kind),
		keys,
		status: Option.none(),
		requestId: Option.none(),
		retryAfter: Option.none(),
		bodyHasMarker: false
	})
	switch (failure) {
		case "a 404 with its request id":
			return {
				...rendered(
					"ApiResponseError",
					["body", "kind", "matched", "message", "operation", "requestId", "status"],
					1,
					1
				),
				status: Option.some(404),
				requestId: Option.some(REQUEST_ID),
				bodyHasMarker: true
			}
		case "a 404 without one":
			return {
				...rendered(
					"ApiResponseError",
					["body", "kind", "matched", "message", "operation", "status"],
					1,
					1
				),
				status: Option.some(404),
				bodyHasMarker: true
			}
		case "a refused connection":
			return rendered("TransportError", ["kind", "message"], 4, 0)
		case "a missing credential":
			return rendered("CredentialMissing", ["kind", "message", "operation"], 3, 0)
		case "a body that is not JSON":
			return rendered("UsageError", ["kind", "message"], 2, 0)
		case "an unknown flag":
			return rendered("UnrecognizedOption", ["kind", "message"], 2, 0)
		case "a Retry-After past the timeout":
			return {
				...rendered(
					"ApiResponseError",
					["kind", "matched", "message", "operation", "retryAfter", "status"],
					1,
					1
				),
				status: Option.some(503),
				retryAfter: Option.some(5)
			}
	}
}

/** A loopback port nothing listens on: a listener opened on a free port and closed with its scope. */
const deadPort = Effect.scoped(listen(createServer()))

/** The suite's fixture, once per worker: the capture server, a loopback origin nothing listens on, the package and its
 * commands. */
export const printedFixture = workerFixture(
	"test/generated/printed-requests.fixtures.ts printedFixture",
	Effect.gen(function* () {
		const server = yield* captureServer
		const port = yield* deadPort
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commands = yield* Effect.all(
			Rec.map(POINTERS, (pointer) =>
				Effect.map(
					Effect.fromOption(
						Arr.findFirst(generated.result.report.commandNames, (name) => name.pointer === pointer)
					),
					(name) => name.path
				)
			)
		)
		const opened: Readonly<{
			server: CaptureServer
			deadOrigin: string
			built: BuiltPackage
			commands: Readonly<Record<Operation, ReadonlyArray<string>>>
		}> = { server, deadOrigin: `http://127.0.0.1:${String(port)}`, built, commands }
		return opened
	})
)

/** The arguments and environment of each failure, and the server's answer. */
export const failureRun = (
	failure: Failure,
	origins: Readonly<{ live: string; dead: string }>
): Readonly<{
	operation: Operation
	args: ReadonlyArray<string>
	env: Readonly<Record<string, string>>
	answer: ScriptedResponse
}> => {
	const json = ["--error-format", "json"]
	switch (failure) {
		case "a 404 with its request id":
			return {
				operation: "get",
				args: Arr.flatten([["--base-url", origins.live], json, ["w1"]]),
				env: { OM_TOKEN: TOKEN },
				answer: {
					...answered(404),
					headers: [
						["Content-Type", "application/json"],
						["X-Request-Id", REQUEST_ID]
					]
				}
			}
		case "a 404 without one":
			return {
				operation: "get",
				args: Arr.flatten([["--base-url", origins.live], json, ["w1"]]),
				env: { OM_TOKEN: TOKEN },
				answer: answered(404)
			}
		case "a refused connection":
			return {
				operation: "status",
				args: Arr.flatten([["--base-url", origins.dead, "--allow-credentials-for-base-url"], json]),
				env: {},
				answer: answered(200)
			}
		case "a missing credential":
			return {
				operation: "get",
				args: Arr.flatten([["--base-url", origins.live], json, ["w1"]]),
				env: {},
				answer: answered(200)
			}
		case "a body that is not JSON":
			return {
				operation: "create",
				args: Arr.flatten([["--base-url", origins.live], json, ["--body", "{not json"]]),
				env: { OM_TOKEN: TOKEN },
				answer: answered(201)
			}
		case "an unknown flag":
			return {
				operation: "get",
				args: ["--base-url", origins.live, "w1", "--no-such-flag"],
				env: { OM_TOKEN: TOKEN, OM_ERROR_FORMAT: "json" },
				answer: answered(200)
			}
		case "a Retry-After past the timeout":
			return {
				operation: "get",
				args: Arr.flatten([
					["--base-url", origins.live, "--timeout", "1", "--retries", "1"],
					json,
					["w1"]
				]),
				env: { OM_TOKEN: TOKEN },
				answer: {
					status: 503,
					headers: [["Retry-After", "5"]],
					delay: Duration.zero,
					body: { kind: "complete", bytes: new Uint8Array(0) }
				}
			}
	}
}

/**
 * The requests a search draws: the floor's and the rotating stream's from FOCUS, a feature's request or any request,
 * each half the time; a case aimed at a required feature still pending, from the request made to reach it
 * (requestFor).
 */
const unsteered: Gen<Request> = (source) => source.draw(requestFor(source.draw(FOCUS)))

export const requests = aimed(
	unsteered,
	Arr.map(SHOWN_FEATURES, (feature) => [feature, requestFor(Option.some(feature))] as const)
)
