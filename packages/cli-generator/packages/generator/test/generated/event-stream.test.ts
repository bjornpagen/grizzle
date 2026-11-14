/**
 * A CLI generated from an OpenAPI 3.2 document shaped as grizzle writes one per login (a read and a write, each a
 * `POST` whose streamed response names its events, each with a `grizzle-wire` header whose schema admits one value),
 * run against a local server that sends `text/event-stream` bodies, writes exactly the events the server sent, one
 * JSON line each, and ends as the stream's contract says: after the first `ready` event by default, after `end` under
 * `--follow`, with exit 130 when a followed stream is interrupted, and with exit 1 after an `error` event, which is
 * retried, as a fresh call, only when the event says retrying is safe and the caller gave `--retries`. Every request
 * carries its operation's `grizzle-wire` value, which no flag reads.
 *
 * Generated event lists: items (`reset`, `upsert`, `remove`) whose JSON data, spelled as grizzle spells int8, money,
 * bytes and codes, is written with whitespace between its tokens and across `data` lines, a `ready` event, live items
 * after it and an `end`, comments between events, sent in one or several writes. Oracle: the events' own lines,
 * through the stop point the command's flags name. The failure and retry behaviour is exhausted over every pairing of
 * the error event's verdict, `--retries` and the read or the write; the oracle there is the contract's: the lines
 * printed, the exit code, the calls made and the header each carried.
 *
 * Features: a stop at ready, a stream followed to its end, an interrupted stream, data across lines, a comment, a write
 * that splits an event; each failure verdict with and without a budget, on the read and on the write.
 *
 * Plants (~/.cache/effect-openapi-cli-generator/plants): sse-stops-before-ready.patch (the stream stops one event before
 * its stop point), event-retry-without-budget.patch (a retry-safe error event retries with no `--retries`),
 * constant-not-sent.patch (a constant parameter is sent empty).
 */
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { drawn, exhaust, explore } from "@superstarter/testing/explore"
import { required, requiredInSpace } from "@superstarter/testing/features"
import { array, boolean, element, type Gen, int } from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { completeShrink } from "@superstarter/testing/shrink"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	Record as Rec,
	Ref,
	Schema,
	Stream,
	String as Str
} from "effect"
import { Headers, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { generateFixture } from "#test/support/cli-package.ts"

/** The generated package: its directory and its built entry. */
class Site extends Context.Service<
	Site,
	{ readonly bin: string; readonly dir: string; readonly wire: Readonly<Record<string, string>> }
>()("effect-openapi-cli-generator/test/generated/event-stream.test/Site") {}

/**
 * The fixture's package, generated into a scoped temp directory and built by its own `tsconfig.build.json` with the
 * workspace's TypeScript, its `node_modules` the workspace's installed packages, which are the versions it pins.
 */
const siteLayer = Layer.effect(Site)(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const specPath = path.resolve(import.meta.dirname, "../fixtures/specs/event-stream.json")
		const spec = yield* fs.readFileString(specPath)
		const generated = yield* generateFixture({
			spec: { path: "event-stream.json", text: spec },
			config: {
				path: "author-config.json",
				text: '{"binName":"site","envPrefix":"SITE","package":{"name":"site-cli","version":"0.1.0"}}\n'
			},
			authorFiles: []
		})
		const installed = path.resolve(import.meta.dirname, "../../../../node_modules")
		yield* fs.symlink(installed, path.join(generated.dir, "node_modules"))
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const built = yield* Effect.scoped(
			Effect.flatMap(
				spawner.spawn(
					ChildProcess.make(path.join(installed, ".bin", "tsc"), ["-p", "tsconfig.build.json"], {
						cwd: generated.dir
					})
				),
				(handle) => handle.exitCode
			)
		)
		if (built !== 0) {
			return yield* Effect.die(`the generated package does not build: tsc exited ${built}`)
		}
		const declared = yield* Schema.decodeEffect(WireDigests)(spec)
		return {
			bin: path.join(generated.dir, "dist", "src", "bin.js"),
			dir: generated.dir,
			wire: Rec.map(declared.paths, (item) =>
				Arr.join(
					Arr.map(item.post.parameters, (parameter) => parameter.schema.const),
					""
				)
			)
		}
	})
)

/** The `grizzle-wire` digest each operation of the fixture declares as its one header value. */
const WireDigests = Schema.fromJsonString(
	Schema.Struct({
		paths: Schema.Record(
			Schema.String,
			Schema.Struct({
				post: Schema.Struct({
					parameters: Schema.Array(
						Schema.Struct({ schema: Schema.Struct({ const: Schema.String }) })
					)
				})
			})
		)
	})
)

/** One scripted response: the writes of its body, and whether the server then closes it or holds it open. */
type Scripted = Readonly<{ writes: ReadonlyArray<string>; close: boolean }>

/** The local server: its origin, the responses it gives the next requests, and how many requests it has had. */
class Server extends Context.Service<
	Server,
	{
		readonly origin: string
		readonly script: (responses: ReadonlyArray<Scripted>) => Effect.Effect<void>
		readonly requests: Effect.Effect<number>
		readonly wire: Effect.Effect<ReadonlyArray<string>>
	}
>()("effect-openapi-cli-generator/test/generated/event-stream.test/Server") {}

/**
 * A server that answers each request with the next scripted response, a `text/event-stream` body of its writes, then
 * closed or held open, and 404 once the script is spent.
 */
const serverLayer = Layer.effect(Server)(
	Effect.gen(function* () {
		const queue = yield* Ref.make<ReadonlyArray<Scripted>>([])
		const count = yield* Ref.make(0)
		const wire = yield* Ref.make<ReadonlyArray<string>>([])
		const encoder = new TextEncoder()
		yield* HttpServer.serveEffect()(
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				yield* Ref.update(count, (seen) => seen + 1)
				yield* Ref.update(wire, (seen) => [
					...seen,
					...Option.toArray(Headers.get(request.headers, "grizzle-wire"))
				])
				const next = yield* Ref.modify(
					queue,
					(responses) => [Arr.head(responses), Arr.drop(responses, 1)] as const
				)
				return Option.match(next, {
					onNone: () => HttpServerResponse.empty({ status: 404 }),
					onSome: (scripted) =>
						HttpServerResponse.stream(
							Stream.concat(
								Stream.fromIterable(Arr.map(scripted.writes, (write) => encoder.encode(write))),
								scripted.close ? Stream.empty : Stream.never
							),
							{ contentType: "text/event-stream" }
						)
				})
			})
		)
		const server = yield* HttpServer.HttpServer
		const port = "port" in server.address ? server.address.port : 0
		return {
			origin: `http://127.0.0.1:${port}`,
			requests: Ref.get(count),
			script: (responses) =>
				Effect.andThen(
					Ref.set(queue, responses),
					Effect.andThen(Ref.set(count, 0), Ref.set(wire, []))
				),
			wire: Ref.get(wire)
		}
	})
)

/** What a run of the generated CLI did: its exit code, and its stdout and stderr text. */
type Run = Readonly<{ exitCode: number; stdout: string; stderr: string }>

/**
 * Run the generated CLI with `args`; when `interruptAt` is given, send it SIGINT once its stdout holds that text.
 */
const runCli = (args: ReadonlyArray<string>, interruptAt: Option.Option<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const site = yield* Site
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const handle = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [site.bin, ...args], {
					cwd: site.dir,
					env: {},
					extendEnv: false
				})
			)
			const stdout = yield* Ref.make("")
			const interrupted = yield* Ref.make(false)
			const watch = Stream.runForEach(Stream.decodeText(handle.stdout), (text) =>
				Effect.gen(function* () {
					const seen = yield* Ref.updateAndGet(stdout, (before) => `${before}${text}`)
					const due = Option.exists(interruptAt, (marker) => Str.includes(marker)(seen))
					const already = yield* Ref.getAndSet(interrupted, due)
					if (due && !already) {
						yield* handle.kill({ killSignal: "SIGINT" })
					}
				})
			)
			const [, stderr, exitCode] = yield* Effect.all(
				[watch, Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
				{ concurrency: "unbounded" }
			)
			const run: Run = { exitCode, stderr, stdout: yield* Ref.get(stdout) }
			return run
		})
	)

/** An event the server sends: its type and its JSON data, as the tokens it is written with. */
type SentEvent = Readonly<{
	type: "remove" | "reset" | "upsert"
	tokens: Arr.NonEmptyReadonlyArray<string>
}>

/** A stream to send: items, `ready`, live items, an optional `end`, the gaps written between data tokens. */
type Feed = Readonly<{
	before: ReadonlyArray<SentEvent>
	after: ReadonlyArray<SentEvent>
	ends: boolean
	gaps: ReadonlyArray<string>
	comments: boolean
	writes: number
	follow: boolean
}>

/**
 * Event data as grizzle spells it on the wire: a reset's key fields; a row whose uuid, int8, money and bytes are
 * strings, whose code is an enum member, and whose int4 is a number; a removed row's key.
 */
const tokenSets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = [
	["{", '"key"', ":", "[", '"id"', "]", "}"],
	[
		"{",
		'"row"',
		":",
		"{",
		'"id"',
		":",
		'"6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90"',
		",",
		'"title"',
		":",
		'"a b"',
		",",
		'"body"',
		":",
		'"x"',
		",",
		'"comments"',
		":",
		"[",
		"]",
		",",
		'"views"',
		":",
		'"9007199254740993"',
		",",
		'"price"',
		":",
		'"12.50"',
		",",
		'"avatar"',
		":",
		'"AAECAw=="',
		",",
		'"status"',
		":",
		'"active"',
		",",
		'"rank"',
		":",
		"7",
		"}",
		"}"
	],
	["{", '"key"', ":", "[", '"6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90"', "]", "}"]
]

const sentEvent: Gen<SentEvent> = (source) => ({
	type: element<SentEvent["type"]>(["reset", "upsert", "remove"])(source),
	tokens: element(tokenSets)(source)
})

const feed: Gen<Feed> = (source) => ({
	before: array(sentEvent, { min: 0, max: 3 })(source),
	after: array(sentEvent, { min: 0, max: 2 })(source),
	ends: boolean(source),
	gaps: array(element(["", " ", "\n", "\t "]), { min: 40, max: 40 })(source),
	comments: boolean(source),
	writes: int(1, 3)(source),
	follow: boolean(source)
})

/** An event's data as written: its tokens with the feed's gaps between them, a gap with a line feed splitting lines. */
const writtenData = (
	event: Readonly<{ tokens: Arr.NonEmptyReadonlyArray<string> }>,
	gaps: ReadonlyArray<string>
) =>
	Arr.join(
		Arr.map(event.tokens, (token, index) =>
			index === 0 ? token : `${Option.getOrElse(Arr.get(gaps, index - 1), () => "")}${token}`
		),
		""
	)

/** One event's text on the wire. */
const eventText = (type: string, data: string, comments: boolean): string =>
	`${comments ? ": note\n" : ""}event: ${type}\n${Arr.join(
		Arr.map(Str.split("\n")(data), (line) => `data: ${line}\n`),
		""
	)}\n`

const readyEvent = { tokens: ["{", "}"] } as const satisfies Readonly<{
	tokens: Arr.NonEmptyReadonlyArray<string>
}>

/** The feed's whole body, the events in order. */
const bodyOf = (sent: Feed): string =>
	Arr.join(
		[
			...Arr.map(sent.before, (event) =>
				eventText(event.type, writtenData(event, sent.gaps), sent.comments)
			),
			eventText("ready", writtenData(readyEvent, sent.gaps), sent.comments),
			...Arr.map(sent.after, (event) =>
				eventText(event.type, writtenData(event, sent.gaps), sent.comments)
			),
			...(sent.ends ? [eventText("end", "{}", sent.comments)] : [])
		],
		""
	)

/** The body cut into the feed's number of writes. */
const writesOf = (body: string, writes: number): ReadonlyArray<string> => {
	const size = Math.ceil(body.length / writes)
	return Arr.map(Arr.range(0, writes - 1), (index) =>
		Str.slice(index * size, (index + 1) * size)(body)
	)
}

const quoted = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

/** One event's line, as the contract states it: its JSON data compacted, then its type. */
const lineOf = (type: string, tokens: ReadonlyArray<string>) =>
	Effect.map(quoted(type), (name) => `{"data":${Arr.join(tokens, "")},"event":${name}}\n`)

/** The lines a run prints: the items, `ready`; under `--follow` the live items and `end`. */
const expectedOf = (sent: Feed) =>
	Effect.gen(function* () {
		const before = yield* Effect.forEach(sent.before, (event) => lineOf(event.type, event.tokens))
		const ready = yield* lineOf("ready", readyEvent.tokens)
		const after = yield* Effect.forEach(sent.after, (event) => lineOf(event.type, event.tokens))
		const end = sent.ends ? [yield* lineOf("end", ["{", "}"])] : []
		return Arr.join([...before, ready, ...(sent.follow ? [...after, ...end] : [])], "")
	})

/** The features a feed reaches. */
type FeedFeature =
	| "stopped at ready"
	| "followed to its end"
	| "interrupted while following"
	| "data across lines"
	| "a comment"
	| "a write that splits an event"

const feedFeatures = (sent: Feed): ReadonlyArray<FeedFeature> => {
	const features: ReadonlyArray<readonly [FeedFeature, boolean]> = [
		["stopped at ready", !sent.follow],
		["followed to its end", sent.follow && sent.ends],
		["interrupted while following", sent.follow && !sent.ends],
		["data across lines", Arr.contains(sent.gaps, "\n")],
		["a comment", sent.comments],
		["a write that splits an event", sent.writes > 1]
	]
	return Arr.flatMap(features, ([feature, reached]) => (reached ? [feature] : []))
}

/** A read's request body: the post it reads, no facts. */
const readBody = '{"params":{"id":"6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90"},"facts":{}}'

/** A write's request body: one comment inserted. */
const writeBody =
	'{"params":{},"facts":{"insert":{"Comment":[{"author":"user_a","body":"hi","id":"0d1e2f3a-4b5c-4d6e-8f70-112233445566","post":"6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90"}]}}}'

/** The arguments of one read call, with `--follow` when the case follows. */
const readArgs = (origin: string, follow: boolean): ReadonlyArray<string> => [
	"--base-url",
	origin,
	"--error-format",
	"json",
	"reader",
	"post-page",
	"--body",
	readBody,
	...(follow ? ["--follow"] : [])
]

/** A failure case: the error event's verdict, the caller's `--retries`, and the command. */
type FailureCase = Readonly<{
	verdict: "never" | "safe"
	retries: Option.Option<number>
	command: "comment" | "post-page"
}>

const failureCase: Gen<FailureCase> = (source) => ({
	verdict: element<FailureCase["verdict"]>(["safe", "never"])(source),
	retries: element([Option.none(), Option.some(1)])(source),
	command: element<FailureCase["command"]>(["post-page", "comment"])(source)
})

/** The features of the failure space. */
type FailureFeature =
	`${FailureCase["verdict"]} ${"with" | "without"} a budget on ${FailureCase["command"]}`

const failureFeature = (failure: FailureCase): FailureFeature =>
	`${failure.verdict} ${Option.isSome(failure.retries) ? "with" : "without"} a budget on ${failure.command}`

/** The error event's text for a verdict. */
const errorText = (verdict: string): string =>
	`event: error\ndata: {"error":{"kind":"transient","retry":"${verdict}","message":"try again"}}\n\n`

/** The first item each failing call sends before its error: a read's reset, a write's outcome. */
const firstItem = (command: FailureCase["command"]): readonly [string, string] =>
	command === "post-page"
		? ["reset", 'event: reset\ndata: {"key":["id"]}\n\n']
		: ["outcome", 'event: outcome\ndata: {"outcome":{"kind":"unchanged","reads":[]}}\n\n']

const ErrorLine = Schema.fromJsonString(
	Schema.Struct({ error: Schema.Struct({ kind: Schema.String }) })
)

const environment = Layer.mergeAll(siteLayer, serverLayer).pipe(
	Layer.provideMerge(
		Layer.mergeAll(NodeChildProcessSpawner.layer, NodeCrypto.layerDigest).pipe(
			Layer.provideMerge(NodeHttpServer.layerTest)
		)
	)
)

layer(environment, { timeout: Duration.minutes(5) })(
	"a generated CLI reading an event stream",
	(it) => {
		it.effect(
			"writes exactly the events sent, through the stop point its flags name",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "generated/event-stream-feed",
							draw: drawn(feed),
							literal: Formatter.format,
							coverage: required<FeedFeature>(
								[
									"stopped at ready",
									"followed to its end",
									"interrupted while following",
									"data across lines",
									"a comment",
									"a write that splits an event"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 4,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang: Duration.seconds(60)
						},
						(sent, c) =>
							Effect.gen(function* () {
								const server = yield* Server
								yield* server.script([
									{ writes: writesOf(bodyOf(sent), sent.writes), close: sent.ends }
								])
								const interrupted = sent.follow && !sent.ends
								const expected = yield* expectedOf(sent)
								const lastLine = Option.getOrElse(
									Arr.last(Str.split("\n")(Str.trimEnd(expected))),
									() => ""
								)
								const run = yield* runCli(
									readArgs(server.origin, sent.follow),
									interrupted ? Option.some(lastLine) : Option.none()
								)
								c.noteAll(feedFeatures(sent))
								deepStrictEqual(
									{ exitCode: run.exitCode, stdout: run.stdout },
									{ exitCode: interrupted ? 130 : 0, stdout: expected }
								)
							})
					)
				),
			Duration.toMillis(Duration.minutes(5))
		)

		it.effect(
			"fails with exit 1 after an error event, retrying as a fresh call only a safe one under --retries",
			(ctx) =>
				searched(
					ctx,
					exhaust(
						{
							suite: "generated/event-stream-failure",
							generator: failureCase,
							literal: Formatter.format,
							limit: 100,
							coverage: requiredInSpace<FailureFeature>([
								"safe with a budget on post-page",
								"safe without a budget on post-page",
								"never with a budget on post-page",
								"never without a budget on post-page",
								"safe with a budget on comment",
								"safe without a budget on comment",
								"never with a budget on comment",
								"never without a budget on comment"
							]),
							caseHang: Duration.seconds(60)
						},
						(failure, c) =>
							Effect.gen(function* () {
								const server = yield* Server
								const [itemType, itemText] = firstItem(failure.command)
								const retried = failure.verdict === "safe" && Option.isSome(failure.retries)
								const success =
									failure.command === "post-page"
										? "event: ready\ndata: {}\n\n"
										: "event: end\ndata: {}\n\n"
								yield* server.script([
									{ writes: [itemText, errorText(failure.verdict)], close: true },
									{ writes: [itemText, success], close: true }
								])
								const run = yield* runCli(
									[
										"--base-url",
										server.origin,
										"--error-format",
										"json",
										...Option.match(failure.retries, {
											onNone: () => [],
											onSome: (n) => ["--retries", String(n)]
										}),
										"reader",
										failure.command,
										"--body",
										failure.command === "post-page" ? readBody : writeBody
									],
									Option.none()
								)
								const item = yield* lineOf(
									itemType,
									failure.command === "post-page"
										? ["{", '"key"', ":", "[", '"id"', "]", "}"]
										: [
												"{",
												'"outcome"',
												":",
												"{",
												'"kind"',
												":",
												'"unchanged"',
												",",
												'"reads"',
												":",
												"[",
												"]",
												"}",
												"}"
											]
								)
								const error = yield* lineOf("error", [
									"{",
									'"error"',
									":",
									"{",
									'"kind"',
									":",
									'"transient"',
									",",
									'"retry"',
									":",
									`"${failure.verdict}"`,
									",",
									'"message"',
									":",
									'"try again"',
									"}",
									"}"
								])
								const last = yield* lineOf(failure.command === "post-page" ? "ready" : "end", [
									"{",
									"}"
								])
								const lastError = Option.getOrElse(
									Arr.last(Str.split("\n")(Str.trim(run.stderr))),
									() => ""
								)
								const kind = Option.map(
									Schema.decodeOption(ErrorLine)(lastError),
									(line) => line.error.kind
								)
								const site = yield* Site
								const digest = Rec.get(
									site.wire,
									failure.command === "post-page" ? "/site/reader/postPage" : "/site/reader/comment"
								)
								const requests = yield* server.requests
								const wire = yield* server.wire
								c.note(failureFeature(failure))
								deepStrictEqual(wire, Arr.getSomes(Arr.replicate(digest, requests)))
								deepStrictEqual(
									{
										exitCode: run.exitCode,
										requests,
										stdout: run.stdout,
										kind
									},
									retried
										? {
												exitCode: 0,
												requests: 2,
												stdout: `${item}${error}${item}${last}`,
												kind: Option.none()
											}
										: {
												exitCode: 1,
												requests: 1,
												stdout: `${item}${error}`,
												kind: Option.some("StreamEventError")
											}
								)
							})
					)
				),
			Duration.toMillis(Duration.minutes(5))
		)
	}
)
