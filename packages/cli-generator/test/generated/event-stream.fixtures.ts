import { dictionary, word } from "@bjornpagen/testing/dictionary"
import {
	aimed,
	array,
	boolean,
	constant,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
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
import { generateFixture, workerFixture } from "#test/support/cli-package.ts"

/** What the event-stream properties (event-stream.test.ts) draw and their fixture: the package and its server. */

/** The generated package: its directory and its built entry. */
export class Site extends Context.Service<
	Site,
	{ readonly bin: string; readonly dir: string; readonly wire: Readonly<Record<string, string>> }
>()("@bjornpagen/grizzle-cli-generator/test/generated/event-stream.fixtures/Site") {}

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
export class Server extends Context.Service<
	Server,
	{
		readonly origin: string
		readonly script: (responses: ReadonlyArray<Scripted>) => Effect.Effect<void>
		readonly requests: Effect.Effect<number>
		readonly wire: Effect.Effect<ReadonlyArray<string>>
	}
>()("@bjornpagen/grizzle-cli-generator/test/generated/event-stream.fixtures/Server") {}

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
export const runCli = (args: ReadonlyArray<string>, interruptAt: Option.Option<string>) =>
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
 * Event data as grizzle spells it on the wire, each as the fixture's `contentSchema` of its event admits it, since the
 * CLI checks it there: a reset's key fields, none for the key read `postPage`; a row whose uuid, int8, money and bytes
 * are strings, whose code is an enum member, and whose int4 is a number; a removed row's key, none.
 */
const tokenSets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = [
	["{", '"key"', ":", "[", "]", "}"],
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
	["{", '"key"', ":", "[", "]", "}"]
]

/** Each item event's data, as the fixture's `contentSchema` of that event admits it. */
const tokensOf = (type: SentEvent["type"]): Arr.NonEmptyReadonlyArray<string> =>
	Option.getOrElse(Arr.get(tokenSets, type === "reset" ? 0 : type === "upsert" ? 1 : 2), () =>
		Arr.headNonEmpty(tokenSets)
	)

const sentEvent: Gen<SentEvent> = (source) => {
	const type = element<SentEvent["type"]>(["reset", "upsert", "remove"])(source)
	return { type, tokens: tokensOf(type) }
}

const feed: Gen<Feed> = (source) => ({
	before: array(sentEvent, { min: 0, max: 3 })(source),
	after: array(sentEvent, { min: 0, max: 2 })(source),
	ends: boolean(source),
	gaps: array(element(["", " ", "\n", "\t "]), { min: 40, max: 40 })(source),
	comments: boolean(source),
	writes: int(1, 3)(source),
	follow: boolean(source)
})

/** A feed made to reach `feature`, every other choice drawn. */
const feedFor =
	(feature: FeedFeature): Gen<Feed> =>
	(source) => {
		const drawnFeed = feed(source)
		switch (feature) {
			case "stopped at ready":
				return { ...drawnFeed, follow: false }
			case "followed to its end":
				return { ...drawnFeed, follow: true, ends: true }
			case "interrupted while following":
				return { ...drawnFeed, follow: true, ends: false }
			case "data across lines":
				return {
					...drawnFeed,
					before: [{ type: "upsert", tokens: tokensOf("upsert") }, ...drawnFeed.before],
					gaps: ["\n", ...Arr.drop(drawnFeed.gaps, 1)]
				}
			case "a comment":
				return { ...drawnFeed, comments: true }
			case "a write that splits an event":
				return { ...drawnFeed, writes: int(2, 3)(source) }
		}
	}

export const FEED_FEATURES: Arr.NonEmptyReadonlyArray<FeedFeature> = [
	"stopped at ready",
	"followed to its end",
	"interrupted while following",
	"data across lines",
	"a comment",
	"a write that splits an event"
]

/** A focus, or none, each half the time: none draws any feed. */
const FEED_FOCUS: Gen<Option.Option<FeedFeature>> = weighted([
	[1, constant(Option.none())],
	[1, map(element(FEED_FEATURES), Option.some)]
])

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
export const bodyOf = (sent: Feed): string =>
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
export const writesOf = (body: string, writes: number): ReadonlyArray<string> => {
	const size = Math.ceil(body.length / writes)
	return Array.from({ length: writes }, (_, index) =>
		Str.slice(index * size, (index + 1) * size)(body)
	)
}

const quoted = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

/** One event's line, as the contract states it: its JSON data compacted, then its type. */
export const lineOf = (type: string, tokens: ReadonlyArray<string>) =>
	Effect.map(quoted(type), (name) => `{"data":${Arr.join(tokens, "")},"event":${name}}\n`)

/** The lines a run prints: the items, `ready`; under `--follow` the live items and `end`. */
export const expectedOf = (sent: Feed) =>
	Effect.gen(function* () {
		const before = yield* Effect.forEach(sent.before, (event) => lineOf(event.type, event.tokens))
		const ready = yield* lineOf("ready", readyEvent.tokens)
		const after = yield* Effect.forEach(sent.after, (event) => lineOf(event.type, event.tokens))
		const end = sent.ends ? [yield* lineOf("end", ["{", "}"])] : []
		return Arr.join([...before, ready, ...(sent.follow ? [...after, ...end] : [])], "")
	})

/** The features a feed reaches. */
export type FeedFeature =
	| "stopped at ready"
	| "followed to its end"
	| "interrupted while following"
	| "data across lines"
	| "a comment"
	| "a write that splits an event"

export const feedFeatures = (sent: Feed): ReadonlyArray<FeedFeature> => {
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
export const readBody = '{"params":{"id":"6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90"},"facts":{}}'

/** A write's request body: one comment inserted. */
export const writeBody =
	'{"params":{},"facts":{"insert":{"Comment":[{"author":"user_a","body":"hi","id":"0d1e2f3a-4b5c-4d6e-8f70-112233445566","post":"6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90"}]}}}'

/** The arguments of one read call, with `--follow` when the case follows. */
export const readArgs = (origin: string, follow: boolean): ReadonlyArray<string> => [
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
export type FailureFeature =
	`${FailureCase["verdict"]} ${"with" | "without"} a budget on ${FailureCase["command"]}`

export const failureFeature = (failure: FailureCase): FailureFeature =>
	`${failure.verdict} ${Option.isSome(failure.retries) ? "with" : "without"} a budget on ${failure.command}`

/** The CallError kind the fixture's error schema pairs with a verdict: `transient` is safe, `stale` never. */
export const kindOf = (verdict: string): string => (verdict === "safe" ? "transient" : "stale")

/** The error event's text for a verdict. */
export const errorText = (verdict: string): string =>
	`event: error\ndata: {"error":{"kind":"${kindOf(verdict)}","retry":"${verdict}","message":"try again"}}\n\n`

/** The first item each failing call sends before its error: a read's reset, a write's outcome. */
export const firstItem = (command: FailureCase["command"]): readonly [string, string] =>
	command === "post-page"
		? ["reset", 'event: reset\ndata: {"key":[]}\n\n']
		: ["outcome", 'event: outcome\ndata: {"outcome":{"kind":"unchanged","reads":{}}}\n\n']

export const ErrorLine = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Struct({ kind: Schema.String, data: Schema.optionalKey(Schema.Json) })
	})
)

/** The error event's data as a JSON value, which `--error-format json` prints as `data`. */
export const errorData = (verdict: string): Schema.Json => ({
	error: { kind: kindOf(verdict), retry: verdict, message: "try again" }
})

/**
 * An event whose data its `contentSchema` in the fixture refuses, one of each type a read sends: a reset with a member
 * its closed object does not declare, an upsert without its row's members, a remove of a key of one column, a ready
 * with a member, and an error whose kind the schema pairs with the other retry. (The reset's `const` key is not one the
 * CLI asserts, SCH-28, so its fault is the excess member.)
 */
export type RefusedData = "reset" | "upsert" | "remove" | "ready" | "error"

export const refusedText: Readonly<Record<RefusedData, string>> = {
	reset: 'event: reset\ndata: {"key":[],"fields":["id"]}\n\n',
	upsert: 'event: upsert\ndata: {"row":{"id":"6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b7c1a90"}}\n\n',
	remove: 'event: remove\ndata: {"key":[1]}\n\n',
	ready: 'event: ready\ndata: {"more":true}\n\n',
	error: 'event: error\ndata: {"error":{"kind":"stale","retry":"safe","message":"m"}}\n\n'
}

/** A cut case: the command whose stream is cut, and the caller's `--retries`. */
type CutCase = Readonly<{ command: FailureCase["command"]; retries: Option.Option<number> }>

const cutCase: Gen<CutCase> = (source) => ({
	command: element<CutCase["command"]>(["post-page", "comment"])(source),
	retries: element([Option.none(), Option.some(1)])(source)
})

export type CutFeature = `a cut ${"read" | "write"} ${"with" | "without"} a budget`

export const cutFeature = (cut: CutCase): CutFeature =>
	`a cut ${cut.command === "post-page" ? "read" : "write"} ${Option.isSome(cut.retries) ? "with" : "without"} a budget`

/** The read's reset, ready and end, and the write's outcome, as the server writes them and the CLI prints them. */
export const resetText = 'event: reset\ndata: {"key":[]}\n\n'

export const outcomeText = 'event: outcome\ndata: {"outcome":{"kind":"unchanged","reads":{}}}\n\n'

/**
 * The suite's fixture, once per worker: the generated package (Site) and the local server (Server) on Node's test HTTP
 * server, as the services each case's check reads.
 */
export const streamFixture = workerFixture(
	"test/generated/event-stream.fixtures.ts streamFixture",
	Layer.build(
		Layer.mergeAll(siteLayer, serverLayer).pipe(
			Layer.provideMerge(
				Layer.mergeAll(NodeChildProcessSpawner.layer, NodeCrypto.layerDigest).pipe(
					Layer.provideMerge(NodeHttpServer.layerTest)
				)
			)
		)
	)
)

/**
 * The streams a search draws: the floor's and the rotating stream's from FEED_FOCUS, a feature's stream or any stream,
 * each half the time; a case aimed at a required feature still pending, from the stream made to reach it (feedFor).
 */
export const feeds = aimed(
	(source) =>
		Option.match(source.draw(FEED_FOCUS), { onNone: () => feed, onSome: feedFor })(source),
	Arr.map(FEED_FEATURES, (feature) => [feature, feedFor(feature)] as const)
)

/** Every pairing of the error event's verdict, a --retries budget or none, and the read or the write. */
export const failureCases: FiniteSpace<FailureCase> = finite(failureCase)

/** One event of each type a read sends whose data its contentSchema refuses. */
export const refusedCases: FiniteSpace<RefusedData> = finite(
	word(dictionary<RefusedData>(["reset", "upsert", "remove", "ready", "error"]))
)

/** The read and the write, each cut before its terminal event, with a --retries budget or none. */
export const cutCases: FiniteSpace<CutCase> = finite(cutCase)
