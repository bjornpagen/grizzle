/**
 * A generated CLI sends each operation's method as the document spells it, to the operation's target, with the body
 * its source holds, framed by what that source knows of its length.
 *
 * - Operations: every method member an OpenAPI 3.2 path item names (uppercased on the wire) and additional operations
 *   whose keys hold every token symbol once, in either case, each with an optional binary body. Bodies:
 *   none, a file's bytes (`--body-file <path>`) or stdin's (`--body-file -`), of any byte values. Oracle: the
 *   document and the invocation: the method as spelled, the path, the body's bytes, and for a body with bytes,
 *   `Content-Length` for a file and `Transfer-Encoding: chunked` for stdin; an empty body's framing is no part of the
 *   contract.
 *
 * Plants (local only, reverted): input.ts stdinBody announcing a length of zero; normalize/operations.ts upper-casing
 * an additional operation's method.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import { bytes, element, type Gen, int } from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
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
import { valuesOf, type WireRequest } from "#test/support/http.ts"

/** The method members of an OpenAPI 3.2 path item, as the document names them. */
const MEMBERS: Arr.NonEmptyReadonlyArray<string> = [
	"get",
	"put",
	"post",
	"delete",
	"options",
	"head",
	"patch",
	"trace",
	"query"
]

/** RFC 9110's token characters other than letters and digits. */
const TOKEN_SYMBOLS: ReadonlyArray<string> = [
	"!",
	"#",
	"$",
	"%",
	"&",
	"'",
	"*",
	"+",
	"-",
	".",
	"^",
	"_",
	"`",
	"|",
	"~"
]

/**
 * Additional operations' keys, the box's bounds: a token around each token symbol, a lower-case one and a mixed-case
 * one, so every character a method may hold is sent once.
 */
const ADDITIONAL: ReadonlyArray<string> = Arr.appendAll(
	Arr.map(TOKEN_SYMBOLS, (symbol) => `M${symbol}9`),
	["purge", "MkCol"]
)

/** A JSON Pointer reference token for a member name (RFC 6901). */
const segmentOf = (name: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(name))

/** One operation of the box: where the document declares it and the method it sends. */
type Operation = Readonly<{ pointer: string; method: string }>

/** Every operation the document declares. */
const OPERATIONS: Arr.NonEmptyReadonlyArray<Operation> = Arr.appendAll(
	Arr.map(MEMBERS, (member): Operation => ({
		pointer: `/paths/~1m/${member}`,
		method: Str.toUpperCase(member)
	})),
	Arr.map(ADDITIONAL, (key): Operation => ({
		pointer: `/paths/~1m/additionalOperations/${segmentOf(key)}`,
		method: key
	}))
)

/** An operation with an optional binary body and a body-less answer. */
const operationOf = (index: number) => ({
	operationId: `op-${String(index)}`,
	requestBody: { required: false, content: { "application/octet-stream": {} } },
	responses: { "200": { description: "Done." } }
})

/** The document: one path, every method member and every additional operation of the box. */
const spec = jsonTextOf({
	openapi: "3.2.0",
	info: { title: "Methods and bodies", version: "1.0.0" },
	paths: {
		"/m": {
			...Rec.fromEntries(Arr.map(MEMBERS, (member, index) => [member, operationOf(index)])),
			additionalOperations: Rec.fromEntries(
				Arr.map(ADDITIONAL, (key, index) => [key, operationOf(MEMBERS.length + index)])
			)
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "methods-bodies", version: "1.0.0" },
		binName: "methods",
		envPrefix: "METHODS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** Where a body comes from: none, a file, or stdin. */
type Body =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "file"; bytes: Uint8Array }>
	| Readonly<{ kind: "stdin"; bytes: Uint8Array }>

/** One run: an operation of the box and its body. */
type Send = Readonly<{ operation: Operation; body: Body }>

const body: Gen<Body> = (source) => {
	const kind = element<Body["kind"]>(["none", "file", "stdin"])(source)
	return kind === "none" ? { kind } : { kind, bytes: bytes({ min: 0, max: 64 })(source) }
}

const send: Gen<Send> = (source) => ({
	operation: Arr.getUnsafe(OPERATIONS, int(0, OPERATIONS.length - 1)(source)),
	body: body(source)
})

/** What a request carried, as the oracle compares it. */
type Sent = Readonly<{
	method: string
	target: string
	contentLength: ReadonlyArray<string>
	transferEncoding: ReadonlyArray<string>
	body: Uint8Array
}>

/**
 * A request as the contract tells requests apart: a request with no body bytes has no body however it is framed (no
 * framing, `Content-Length: 0`, or chunked with no chunk), so its framing is not part of the contract.
 */
const canonical = (sent: Sent): Sent =>
	sent.body.length === 0 &&
	Arr.every(sent.contentLength, (value) => value === "0") &&
	Arr.every(sent.transferEncoding, (value) => value === "chunked")
		? { ...sent, contentLength: [], transferEncoding: [] }
		: sent

/** The request the contract sends: the method as spelled, the path, the body's bytes and the framing its source implies. */
const expectedOf = (s: Send): Sent => {
	const base = { method: s.operation.method, target: "/m" }
	switch (s.body.kind) {
		case "none":
			return { ...base, contentLength: [], transferEncoding: [], body: new Uint8Array(0) }
		case "file":
			return {
				...base,
				contentLength: [String(s.body.bytes.length)],
				transferEncoding: [],
				body: s.body.bytes
			}
		case "stdin":
			return { ...base, contentLength: [], transferEncoding: ["chunked"], body: s.body.bytes }
	}
}

/** What a recorded request carried. */
const sentOf = (request: WireRequest): Sent => ({
	method: request.method,
	target: request.target,
	contentLength: valuesOf(request.headers, "content-length"),
	transferEncoding: valuesOf(request.headers, "transfer-encoding"),
	body: request.body
})

/** An empty `200`. */
const done: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** The suite's fixture: the capture server, the package built against it, and each operation's command. */
class MethodsFixture extends Context.Service<
	MethodsFixture,
	Readonly<{
		server: CaptureServer
		built: BuiltPackage
		commands: ReadonlyMap<string, ReadonlyArray<string>>
	}>
>()("effect-openapi-cli-generator/test/generated/methods-bodies.test/MethodsFixture") {}

const fixture = Layer.effect(
	MethodsFixture,
	Effect.gen(function* () {
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commands = new Map(
			Arr.map(generated.result.report.commandNames, (name) => [name.pointer, name.path])
		)
		return { server, built, commands }
	})
).pipe(Layer.provideMerge(harnessLayer))

type MethodFeature =
	| "a method member"
	| "an additional operation"
	| "a lower-case additional method"
	| "a mixed-case additional method"
	| "a method holding a token symbol"
	| "no body"
	| "a file body"
	| "a stdin body"
	| "an empty body"

/** How an additional operation's method is spelled: in lower case, in mixed case, or holding a token symbol. */
const spellingOf = (method: string): ReadonlyArray<MethodFeature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<MethodFeature>>>([
		Str.toLowerCase(method) === method ? ["a lower-case additional method"] : [],
		Str.toLowerCase(method) !== method && Str.toUpperCase(method) !== method
			? ["a mixed-case additional method"]
			: [],
		Arr.some(TOKEN_SYMBOLS, (symbol) => Str.includes(symbol)(method))
			? ["a method holding a token symbol"]
			: []
	])

layer(fixture, { excludeTestServices: true })("a generated CLI's requests", (it) => {
	it.effect("carry the method as spelled and the body framed by its source", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { server, built, commands } = yield* MethodsFixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "methods-bodies-" })
				return yield* explore(
					{
						suite: "methods and bodies",
						draw: drawn(send),
						literal: Formatter.format,
						coverage: required<MethodFeature>(
							[
								"a method member",
								"an additional operation",
								"a lower-case additional method",
								"a mixed-case additional method",
								"a method holding a token symbol",
								"no body",
								"a file body",
								"a stdin body",
								"an empty body"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 30,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 10,
						caseHang: Duration.seconds(60)
					},
					(s, k) =>
						Effect.gen(function* () {
							if (Str.includes("additionalOperations")(s.operation.pointer)) {
								k.note("an additional operation")
								k.noteAll(spellingOf(s.operation.method))
							} else {
								k.note("a method member")
							}
							k.note(
								s.body.kind === "none"
									? "no body"
									: s.body.kind === "file"
										? "a file body"
										: "a stdin body"
							)
							if (s.body.kind !== "none" && s.body.bytes.length === 0) {
								k.note("an empty body")
							}
							const command = yield* Effect.fromOption(
								Option.fromNullishOr(commands.get(s.operation.pointer))
							)
							const file = path.join(scratch, "body.bin")
							const bodyArgs =
								s.body.kind === "none"
									? []
									: s.body.kind === "file"
										? ["--body-file", file]
										: ["--body-file", "-"]
							if (s.body.kind === "file") {
								yield* fs.writeFile(file, s.body.bytes)
							}
							const observed = yield* server.observe(
								() => done,
								runBin(built, {
									args: [...command, "--base-url", server.origins["127.0.0.1"], ...bodyArgs],
									env: {},
									stdin: s.body.kind === "stdin" ? s.body.bytes : new Uint8Array(0)
								})
							)
							deepStrictEqual(
								{
									exitCode: observed.result.exitCode,
									sent: Arr.map(observed.requests, (request) => canonical(sentOf(request)))
								},
								{ exitCode: 0, sent: [canonical(expectedOf(s))] },
								"the request carries the method as spelled and the body framed by its source"
							)
						})
				)
			}).pipe(Effect.scoped)
		)
	)
})
