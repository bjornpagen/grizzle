/**
 * A generated CLI shows the request it would send without sending it, shows what it sends and receives on stderr
 * without changing stdout, and renders a failed run as one JSON object:
 *
 * - `--dry-run` prints `METHOD <absolute URL> HTTP/1.1`, then the headers a real send carries, in the order it sends
 *   them, but the two undici writes itself (`host` and `connection`), each with the value it sends, then a blank line
 *   and the body; it exits 0 and opens no connection. A credential prints as `<redacted:<scheme>>` whether or not one is
 *   configured, so the print never depends on it and never shows it.
 * - `--verbose` writes `> ` lines for the request, the lines `--dry-run` prints, and `< ` lines for the response to
 *   stderr and nothing else there, while stdout is the response body alone.
 * - `--error-format json` writes exactly one line, a `{"error":{...}}` object, and nothing on stdout. Its keys follow
 *   the error: an API error carries `body`, `matched`, `operation` and `status`, its declared request id when the
 *   response sent one, and `retryAfter` when a `Retry-After` past the timeout stopped retrying; a missing credential
 *   carries `operation`; a refused connection and a usage error carry `kind` and `message` alone. The exit codes are 1,
 *   3, 4 and 2.
 *
 * One package with a secured GET taking a header parameter, a secured POST with a JSON body, and an open GET. A
 * property draws a request and runs it as a dry run with and without the credential and as a verbose real send,
 * comparing the three with each other and with what reached the capture server; an exhaustion runs every JSON error.
 *
 * Plants, each applied to src/runtime-src/runtime and seen to fail this suite and reverted:
 * - client.ts's sendOrder listing the headers sorted by name, as fetch's `Headers` iterates them, not as undici writes
 *   them;
 * - client.ts's sendOrder leaving `content-length` where the record holds it, not last, where undici writes it;
 * - client.ts's `--verbose` request block redacting a header by its name before the run's scrubber writes the credential
 *   as its placeholder, so it printed `<redacted>` where the dry run prints `Bearer <redacted:token>`;
 * - auth.ts's shownRedactedValue without a placeholder's `Bearer` form;
 * - redact.ts's placeholder written `<redacted-<scheme>>`;
 * - output.ts's dry run without its `content-length` line;
 * - output.ts's send ignoring `--dry-run`, so a dry run opened a connection;
 * - output.ts's JSON error without `requestId`, so a 404 carrying its declared request id rendered without it.
 */
import { createServer } from "node:net"
import { type Case as SearchCase, drawn, exhaust, explore } from "@bjornpagen/testing/explore"
import { required, requiredInSpace } from "@bjornpagen/testing/features"
import {
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
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
	Order,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { listen } from "#test/support/connection.ts"
import type { WireRequest } from "#test/support/http.ts"
import { latin1Bytes } from "#test/support/wire.ts"

const OBJECT = { "application/json": { schema: { type: "object" } } } as const

/** A secured GET with a header parameter and a 404 declaring its request id, a secured POST, and an open GET. */
const spec = jsonTextOf({
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
	jsonTextOf({
		package: { name: "printed-requests", version: "1.0.0" },
		binName: "om",
		envPrefix: "OM",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The bearer token a configured run carries, which no output may show. */
const TOKEN = "zq-bearer-token"

/** The placeholder a credential prints as in a dry run. */
const PLACEHOLDER = "Bearer <redacted:token>"

/** A response body marker, which `--verbose` must never copy to stderr. */
const MARKER = "zq-response"

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
const requestArgs = (request: Request): ReadonlyArray<string> => {
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
					return [`--body=${jsonTextOf({ name: request.body.name })}`]
			}
	}
}

const operationOfRequest = (request: Request): Operation => request.kind

/** A dry-run print split apart: its request line, its header lines and the body after the blank line. */
type Printed = Readonly<{ requestLine: string; headerLines: ReadonlyArray<string>; body: string }>

const printedOf = (stdout: string): Printed => {
	const [head, body] = Option.match(Str.indexOf("\n\n")(stdout), {
		onNone: () => [stdout, ""],
		onSome: (at) => [Str.slice(0, at)(stdout), Str.slice(at + 2)(stdout)]
	})
	const [requestLine, ...headerLines] = Str.split("\n")(head)
	return { requestLine, headerLines, body: Str.trimEnd(body) }
}

/** The `--verbose` request block: each `> ` line, its prefix removed, the request line first. */
const verboseRequest = (stderr: string): ReadonlyArray<string> =>
	Arr.flatMap(Str.split("\n")(stderr), (line) =>
		Str.startsWith("> ")(line) ? [Str.slice(2)(line)] : []
	)

/** What the property compares of one request's three runs. */
type Shown = Readonly<{
	dryRunRequestLine: string
	dryRunExit: number
	dryRunConnections: number
	dryRunStderr: string
	withoutCredential: string
	verboseExit: number
	verboseLinesOnly: boolean
	verboseRequest: ReadonlyArray<string>
	verboseBody: Option.Option<Schema.Json>
	responseOnStderr: boolean
	tokenShown: boolean
	printedHeaders: ReadonlyArray<string>
	sentNames: ReadonlyArray<string>
	printedBody: string
}>

/** What the contract fixes of the three runs, from the dry run's own lines and the request that reached the server. */
const expectedShown = (
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
		printedBody: Buffer.from(sent.body).toString("utf8")
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
const sentNamesOf = (sent: WireRequest): ReadonlyArray<string> =>
	Arr.sort(
		Arr.filter(
			Arr.map(sent.headers, ([name]) => Str.toLowerCase(name)),
			(name) => !Arr.contains(TRANSPORT_HEADERS, name)
		),
		Order.String
	)

/** The response every send gets: an object holding the marker. */
const answered = (status: number): ScriptedResponse => ({
	status,
	headers: [["Content-Type", "application/json"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes(jsonTextOf({ marker: MARKER })) }
})

/** A situation the property reaches. */
type ShownFeature =
	| "a GET"
	| "a header parameter"
	| "a create with no body input"
	| "a create by its flags"
	| "a create by --body"

const SHOWN_FEATURES: Arr.NonEmptyReadonlyArray<ShownFeature> = [
	"a GET",
	"a header parameter",
	"a create with no body input",
	"a create by its flags",
	"a create by --body"
]

const shownFeatures = (request: Request): ReadonlyArray<ShownFeature> => {
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

const aimedFocus = <F extends string>(
	features: ReadonlyArray<F>,
	drawnFocus: Option.Option<F>,
	k: SearchCase<F>
): Option.Option<F> =>
	Option.match(
		Option.flatMap(k.steering, (pending) =>
			Arr.match(
				Arr.filter(features, (feature) => pending.names(feature)),
				{
					onEmpty: () => Option.none(),
					onNonEmpty: (pendingFeatures) => Option.some(pendingFeatures)
				}
			)
		),
		{
			onNone: () => drawnFocus,
			onSome: (pendingFeatures) => Option.some(k.draw(element(pendingFeatures)))
		}
	)

const FOCUS: Gen<Option.Option<ShownFeature>> = weighted<Option.Option<ShownFeature>>([
	[1, constant(Option.none())],
	[1, map(element(SHOWN_FEATURES), Option.some)]
])

/** A failed run the JSON error exhaustion makes. */
type Failure =
	| "a 404 with its request id"
	| "a 404 without one"
	| "a refused connection"
	| "a missing credential"
	| "a body that is not JSON"
	| "an unknown flag"
	| "a Retry-After past the timeout"

const FAILURES: Arr.NonEmptyReadonlyArray<Failure> = [
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
type Rendered = Readonly<{
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

const ErrorLine = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite]))
	})
)

const decodeErrorLine = Schema.decodeUnknownOption(ErrorLine)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** The run each failure gives. */
const expectedRendered = (failure: Failure): Rendered => {
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

/** The suite's fixture: the capture server, a loopback origin nothing listens on, the package and its commands. */
class PrintedFixture extends Context.Service<
	PrintedFixture,
	Readonly<{
		server: CaptureServer
		deadOrigin: string
		built: BuiltPackage
		commands: Readonly<Record<Operation, ReadonlyArray<string>>>
	}>
>()("effect-openapi-cli-generator/test/generated/printed-requests.test/PrintedFixture") {}

/** A loopback port nothing listens on: a listener opened on a free port and closed with its scope. */
const deadPort = Effect.scoped(listen(createServer()))

const fixture = Layer.effect(
	PrintedFixture,
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
		return { server, deadOrigin: `http://127.0.0.1:${String(port)}`, built, commands }
	})
).pipe(Layer.provideMerge(harnessLayer))

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8")

/** The arguments and environment of each failure, and the server's answer. */
const failureRun = (
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

layer(fixture, { excludeTestServices: true })(
	"a generated CLI's printed requests and errors",
	(it) => {
		it.effect(
			"print the request a send carries, redacted, and change nothing else",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { server, built, commands } = yield* PrintedFixture
						const base = server.origins["127.0.0.1"]
						return yield* explore(
							{
								suite: "printed requests",
								oracle: {
									kind: "specification",
									name: "the dry run, the verbose send and what reached the capture server, each against the others"
								},
								draw: drawn(FOCUS),
								literal: Formatter.format,
								coverage: required<ShownFeature>(SHOWN_FEATURES, { cases: 16, sense: notesOnly }),
								kept: [],
								runs: 4,
								shrink: { kind: "bounded", candidates: 20 },
								concurrency: 1,
								steerEvery: 1,
								caseHang: Duration.seconds(60)
							},
							(drawnFocus, k) =>
								Effect.gen(function* () {
									const request = k.draw(requestFor(aimedFocus(SHOWN_FEATURES, drawnFocus, k)))
									k.noteAll(shownFeatures(request))
									const args = Arr.flatten([
										commands[operationOfRequest(request)],
										["--base-url", base],
										requestArgs(request)
									])
									const run = (flag: string, env: Readonly<Record<string, string>>) =>
										server.observe(
											() => answered(request.kind === "get" ? 200 : 201),
											runBin(built, {
												args: Arr.prepend(args, flag),
												env,
												stdin: new Uint8Array(0)
											})
										)
									const dryRun = yield* run("--dry-run", { OM_TOKEN: TOKEN })
									const bare = yield* run("--dry-run", {})
									const verbose = yield* run("--verbose", { OM_TOKEN: TOKEN })
									const sent = yield* Effect.fromOption(Arr.head(verbose.requests))
									const dryRunStdout = utf8(dryRun.result.stdout)
									const verboseStderr = utf8(verbose.result.stderr)
									const printed = printedOf(dryRunStdout)
									const verboseLines = Arr.filter(Str.split("\n")(verboseStderr), Str.isNonEmpty)
									deepStrictEqual<Shown>(
										{
											dryRunRequestLine: printed.requestLine,
											dryRunExit: dryRun.result.exitCode,
											dryRunConnections: dryRun.connections.length + bare.connections.length,
											dryRunStderr: utf8(dryRun.result.stderr),
											withoutCredential: utf8(bare.result.stdout),
											verboseExit: verbose.result.exitCode,
											verboseLinesOnly: Arr.every(
												verboseLines,
												(line) => Str.startsWith("> ")(line) || Str.startsWith("< ")(line)
											),
											verboseRequest: verboseRequest(verboseStderr),
											verboseBody: decodeJson(utf8(verbose.result.stdout)),
											responseOnStderr: Str.includes(MARKER)(verboseStderr),
											tokenShown: Arr.some(
												[
													dryRunStdout,
													utf8(bare.result.stdout),
													utf8(bare.result.stderr),
													verboseStderr,
													utf8(verbose.result.stdout)
												],
												Str.includes(TOKEN)
											),
											printedHeaders: printed.headerLines,
											sentNames: sentNamesOf(sent),
											printedBody: printed.body
										},
										expectedShown(printed, dryRunStdout, sent, base, request),
										"the dry run prints what a send carries, the same with or without the credential, and verbose changes nothing else"
									)
								})
						)
					})
				),
			Duration.toMillis(Duration.minutes(5))
		)

		it.effect(
			"render every failure as one JSON object with its error's keys",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { server, deadOrigin, built, commands } = yield* PrintedFixture
						return yield* exhaust(
							{
								suite: "JSON errors",
								oracle: {
									kind: "specification",
									name: "one JSON error line with the keys its error carries, nothing on stdout, and its exit code"
								},
								box: "every failure the suite lists: API errors with and without a request id, a refused connection, a missing credential, a usage error and a Retry-After past the timeout",
								concurrency: 1,
								generator: element(FAILURES),
								literal: Formatter.format,
								coverage: requiredInSpace<Failure>(FAILURES),
								caseHang: Duration.seconds(60)
							},
							(failure, k) =>
								Effect.gen(function* () {
									k.note(failure)
									const planned = failureRun(failure, {
										live: server.origins["127.0.0.1"],
										dead: deadOrigin
									})
									const observed = yield* server.observe(
										() => planned.answer,
										runBin(built, {
											args: Arr.appendAll(commands[planned.operation], planned.args),
											env: planned.env,
											stdin: new Uint8Array(0)
										})
									)
									const lines = Arr.filter(
										Str.split("\n")(utf8(observed.result.stderr)),
										Str.isNonEmpty
									)
									const error = Option.map(
										Arr.findFirst(lines, (line) => decodeErrorLine(line)),
										(decoded) => decoded.error
									)
									const field = <A>(
										name: string,
										refine: (value: string | number) => Option.Option<A>
									) =>
										Option.flatMap(error, (fields) => Option.flatMap(Rec.get(fields, name), refine))
									const asString = (value: string | number): Option.Option<string> =>
										typeof value === "string" ? Option.some(value) : Option.none()
									const asNumber = (value: string | number): Option.Option<number> =>
										typeof value === "number" ? Option.some(value) : Option.none()
									deepStrictEqual<Rendered>(
										{
											exitCode: observed.result.exitCode,
											connections: observed.connections.length,
											stdout: utf8(observed.result.stdout),
											lines: lines.length,
											kind: field("kind", asString),
											keys: Option.match(error, {
												onNone: () => [],
												onSome: (fields) => Arr.sort(Rec.keys(fields), Order.String)
											}),
											status: field("status", asNumber),
											requestId: field("requestId", asString),
											retryAfter: field("retryAfter", asNumber),
											bodyHasMarker: Option.exists(field("body", asString), Str.includes(MARKER))
										},
										expectedRendered(failure),
										"one JSON object with the error's keys, and the error's exit code"
									)
								})
						)
					})
				),
			Duration.toMillis(Duration.minutes(5))
		)
	}
)
