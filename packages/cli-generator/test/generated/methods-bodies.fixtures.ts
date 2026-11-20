/** What the property of methods-bodies.test.ts reads: its space, the package it runs, and the request each case must send. */

import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { type Aimed, aimed, bytes, constant, element, type Gen, map } from "@bjornpagen/testing/gen"
import { Array as Arr, Duration, Effect, Record as Rec, String as Str } from "effect"
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
const TOKEN_SYMBOLS: Arr.NonEmptyReadonlyArray<string> = [
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
const ADDITIONAL: Arr.NonEmptyReadonlyArray<string> = Arr.appendAll(
	Arr.map(TOKEN_SYMBOLS, (symbol) => `M${symbol}9`),
	["purge", "MkCol"]
)

/** A JSON Pointer reference token for a member name (RFC 6901). */
const segmentOf = (name: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(name))

/** One operation of the box: where the document declares it and the method it sends. */
type Operation = Readonly<{ pointer: string; method: string }>

/** A method member's operation: it sends the member's name upper-cased. */
const memberOperation = (member: string): Operation => ({
	pointer: `/paths/~1m/${member}`,
	method: Str.toUpperCase(member)
})

/** An additional operation's: it sends its key as the document spells it. */
const additionalOperation = (key: string): Operation => ({
	pointer: `/paths/~1m/additionalOperations/${segmentOf(key)}`,
	method: key
})

/** Every operation the document declares. */
const OPERATIONS: Arr.NonEmptyReadonlyArray<Operation> = Arr.appendAll(
	Arr.map(MEMBERS, memberOperation),
	Arr.map(ADDITIONAL, additionalOperation)
)

/** An operation with an optional binary body and a body-less answer. */
const operationOf = (index: number) => ({
	operationId: `op-${String(index)}`,
	requestBody: { required: false, content: { "application/octet-stream": {} } },
	responses: { "200": { description: "Done." } }
})

/** The document: one path, every method member and every additional operation of the box. */
const spec = jsonText({
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
	jsonText({
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

/** A run of a drawn operation of `operations` with a body drawn from `bodies`. */
const sendOf =
	(operations: Gen<Operation>, bodies: Gen<Body>): Gen<Send> =>
	(source) => ({ operation: operations(source), body: bodies(source) })

/** A body of `kind` holding `bytes`. */
const bodyOf = (kind: "file" | "stdin", drawnBytes: Gen<Uint8Array>): Gen<Body> =>
	map(drawnBytes, (held): Body => ({ kind, bytes: held }))

/**
 * Every operation of the box with a body drawn from every source; aimed, while a situation is pending, at a run made to
 * reach it, since the lower- and mixed-case keys are one operation each among the box's and an empty body one length
 * among sixty-five.
 */
export const send: Aimed<Send, MethodFeature> = aimed(sendOf(element(OPERATIONS), body), [
	["a method member", sendOf(map(element(MEMBERS), memberOperation), body)],
	["an additional operation", sendOf(map(element(ADDITIONAL), additionalOperation), body)],
	["a lower-case additional method", sendOf(constant(additionalOperation("purge")), body)],
	["a mixed-case additional method", sendOf(constant(additionalOperation("MkCol")), body)],
	[
		"a method holding a token symbol",
		sendOf(
			map(element(TOKEN_SYMBOLS), (symbol) => additionalOperation(`M${symbol}9`)),
			body
		)
	],
	["no body", sendOf(element(OPERATIONS), constant<Body>({ kind: "none" }))],
	["a file body", sendOf(element(OPERATIONS), bodyOf("file", bytes({ min: 0, max: 64 })))],
	["a stdin body", sendOf(element(OPERATIONS), bodyOf("stdin", bytes({ min: 0, max: 64 })))],
	[
		"an empty body",
		sendOf(element(OPERATIONS), (source) =>
			bodyOf(element(["file", "stdin"] as const)(source), constant(new Uint8Array(0)))(source)
		)
	]
])

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
export const canonical = (sent: Sent): Sent =>
	sent.body.length === 0 &&
	Arr.every(sent.contentLength, (value) => value === "0") &&
	Arr.every(sent.transferEncoding, (value) => value === "chunked")
		? { ...sent, contentLength: [], transferEncoding: [] }
		: sent

/** The request the contract sends: the method as spelled, the path, the body's bytes and the framing its source implies. */
export const expectedOf = (s: Send): Sent => {
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
export const sentOf = (request: WireRequest): Sent => ({
	method: request.method,
	target: request.target,
	contentLength: valuesOf(request.headers, "content-length"),
	transferEncoding: valuesOf(request.headers, "transfer-encoding"),
	body: request.body
})

/** An empty `200`. */
export const done: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** The suite's fixture: the capture server, the package built against it, and each operation's command. */

/**
 * The suite's fixture, once per worker: the capture server, the package built against it, and each operation's
 * command.
 */
export const methodsFixture = workerFixture(
	"test/generated/methods-bodies.fixtures.ts methodsFixture",
	Effect.gen(function* () {
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commands: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
			Arr.map(generated.result.report.commandNames, (name) => [name.pointer, name.path])
		)
		const opened: Readonly<{
			server: CaptureServer
			built: BuiltPackage
			commands: ReadonlyMap<string, ReadonlyArray<string>>
		}> = { server, built, commands }
		return opened
	})
)

export type MethodFeature =
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
export const spellingOf = (method: string): ReadonlyArray<MethodFeature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<MethodFeature>>>([
		Str.toLowerCase(method) === method ? ["a lower-case additional method"] : [],
		Str.toLowerCase(method) !== method && Str.toUpperCase(method) !== method
			? ["a mixed-case additional method"]
			: [],
		Arr.some(TOKEN_SYMBOLS, (symbol) => Str.includes(symbol)(method))
			? ["a method holding a token symbol"]
			: []
	])
