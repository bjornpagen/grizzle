import { connect as connectTls } from "node:tls"
/**
 * The capture server records every request exactly as a client sent it and answers exactly as its script says, and the
 * TLS capture server records which connections presented the client certificate.
 *
 * - Recording: connections to either plain origin, each carrying pipelined requests a client writes from generated
 *   sketches (token methods, origin-form targets, header lines with whitespace around their values, bodies under no
 *   framing, a Content-Length or chunks with extensions and trailers). Oracle: the sketches themselves, as the
 *   reference writer in wire.ts frames them: each recorded request's origin, connection, method, target, header lines
 *   and decoded body, in order.
 * - Reading: the same requests cut into arbitrary pieces and fed to the server's parser as a connection's bytes
 *   arrive. Oracle: the sketches, and nothing left over.
 * - Answering: a scripted sequence of responses for one path, asked more times than it holds, by GET, HEAD or another
 *   token. Oracle: wire.ts's response reader: each answer's status, header lines with their framing header, and
 *   body, the sequence's last response repeating once it runs out, and no body for HEAD.
 * - Holding: stalled bodies and held chunked bodies. Oracle: the reader sees exactly the promised prefix and an
 *   incomplete body, and the observation completes once the client closes.
 * - TLS: connections to origin A or B, with or without the fixture's client certificate. Oracle: each connection's
 *   origin and certificate subject, present exactly when the client presented one.
 *
 * Plants (local only, reverted): http.ts trimWhitespace keeping the trailing whitespace; http.ts chunkedBody dropping
 * the last chunk; capture-server.ts headOf writing the framing header before the scripted ones; capture-server.ts
 * writeResponse sending one byte more of a stalled body; capture-server.ts recording `Option.none()` for every TLS
 * certificate.
 */
import { describe, it, layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import {
	array,
	boolean,
	bytes,
	constant,
	element,
	type Gen,
	int,
	oneOf
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import {
	captureServer,
	type PacedChunk,
	type PlainOrigin,
	type ResponseBody,
	type ScriptedResponse,
	tlsCaptureServer
} from "#test/support/capture-server.ts"
import { clientSubject, type TlsOrigin } from "#test/support/certificates.ts"
import { harnessLayer } from "#test/support/cli-package.ts"
import { type HeaderList, parseRequest, type WireRequest } from "#test/support/http.ts"
import {
	exchange,
	header,
	latin1Bytes,
	method,
	type ReadResponse,
	readResponse,
	recordedOf,
	request,
	type RequestSketch,
	requestBytes,
	untilClosed
} from "#test/support/wire.ts"

/** The port of an origin's URL. */
const portOf = (origin: string): number => Number(new URL(origin).port)

/** A connection a client opens: the origin it reaches and the requests it pipelines, the last asking to close. */
type ConnectionSketch = Readonly<{
	origin: PlainOrigin
	requests: Arr.NonEmptyReadonlyArray<RequestSketch>
}>

const plainOrigin: Gen<PlainOrigin> = element(["127.0.0.1", "localhost"])

const connectionSketch: Gen<ConnectionSketch> = (source) => ({
	origin: plainOrigin(source),
	requests: Arr.prepend(array(request, { min: 0, max: 2 })(source), request(source))
})

/** The bytes a connection carries: each request in order, the last asking the server to close. */
const connectionBytes = (sketch: ConnectionSketch): Buffer =>
	Buffer.concat(
		Arr.map(sketch.requests, (sent, index) =>
			requestBytes(sent, index === sketch.requests.length - 1)
		)
	)

/** The requests a connection's sketch should leave on the server. */
const recordedOfConnection = (sketch: ConnectionSketch): ReadonlyArray<WireRequest> =>
	Arr.map(sketch.requests, (sent, index) => recordedOf(sent, index === sketch.requests.length - 1))

/** An empty `200` answer. */
const ok: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

type RecordingFeature =
	| "127.0.0.1 origin"
	| "localhost origin"
	| "two connections"
	| "pipelined requests"
	| "no framing"
	| "a Content-Length body"
	| "an empty Content-Length body"
	| "a chunked body"
	| "a chunk extension"
	| "a trailer"
	| "whitespace around a header value"
	| "an empty header value"
	| "a latin1 byte in a header value"
	| "a repeated header name"
	| "a query in the target"

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** Whether a text holds a character past ASCII. */
const beyondAscii = (text: string): boolean =>
	Arr.some(Arr.fromIterable(text), (character) => character > "\u007f")

/** The features one request reaches. */
const requestFeatures = (sent: RequestSketch): ReadonlyArray<RecordingFeature> => {
	const { body } = sent
	return Arr.flatten<ReadonlyArray<ReadonlyArray<RecordingFeature>>>([
		when(body.framing === "none", "no framing"),
		when(body.framing === "length" && body.bytes.length > 0, "a Content-Length body"),
		when(body.framing === "length" && body.bytes.length === 0, "an empty Content-Length body"),
		when(body.framing === "chunked", "a chunked body"),
		when(
			body.framing === "chunked" && Arr.some(body.chunks, (chunk) => chunk.extension),
			"a chunk extension"
		),
		when(body.framing === "chunked" && Option.isSome(body.trailer), "a trailer"),
		when(
			Arr.some(sent.headers, (line) => line.before.length > 0 || line.after.length > 0),
			"whitespace around a header value"
		),
		when(
			Arr.some(sent.headers, (line) => line.value.length === 0),
			"an empty header value"
		),
		when(
			Arr.some(sent.headers, (line) => beyondAscii(line.value)),
			"a latin1 byte in a header value"
		),
		when(
			Arr.dedupe(Arr.map(sent.headers, (line) => Str.toLowerCase(line.name))).length <
				sent.headers.length,
			"a repeated header name"
		),
		when(Str.includes("?")(sent.target), "a query in the target")
	])
}

/** How far a connection's pieces have been read: the bytes not yet a request, the requests read, and any malformed. */
type ReadState = Readonly<{
	buffer: Buffer
	requests: ReadonlyArray<WireRequest>
	malformed: boolean
}>

/** A response a script answers: its status, header lines and body. */
type ResponseSketch = Readonly<{ status: number; headers: HeaderList; body: ResponseBody }>

/** A complete or terminated chunked body. */
const finishedBody: Gen<ResponseBody> = (source) =>
	boolean(source)
		? {
				kind: "chunked",
				chunks: array(
					(chunk): PacedChunk => ({
						delay: Duration.zero,
						bytes: bytes({ min: 0, max: 5 })(chunk)
					}),
					{ min: 0, max: 3 }
				)(source),
				last: "terminated"
			}
		: { kind: "complete", bytes: bytes({ min: 0, max: 10 })(source) }

const responseSketch: Gen<ResponseSketch> = (source) => ({
	status: int(200, 599)(source),
	headers: Arr.map(array(header, { min: 0, max: 2 })(source), (line): readonly [string, string] => [
		line.name,
		line.value
	]),
	body: finishedBody(source)
})

/** A script's sequence for one path, how many times a client asks it, and the method it asks with. */
type AnsweringCase = Readonly<{
	method: string
	responses: Arr.NonEmptyReadonlyArray<ResponseSketch>
	asks: number
}>

const answeringCase: Gen<AnsweringCase> = (source) => ({
	method: oneOf([constant("GET"), constant("HEAD"), method])(source),
	responses: Arr.prepend(array(responseSketch, { min: 0, max: 2 })(source), responseSketch(source)),
	asks: int(1, 4)(source)
})

/** The framing header the server writes after a response's own header lines. */
const framingOf = (body: ResponseBody): readonly [string, string] =>
	body.kind === "chunked"
		? ["Transfer-Encoding", "chunked"]
		: ["Content-Length", String(body.bytes.length)]

/** The bytes a terminated chunked body or a complete body carries. */
const bodyOf = (body: ResponseBody): Uint8Array => {
	switch (body.kind) {
		case "complete":
		case "stalled":
			return Uint8Array.from(body.bytes)
		case "chunked":
			return Uint8Array.from(Buffer.concat(Arr.map(body.chunks, (chunk) => chunk.bytes)))
	}
}

type AnsweringFeature =
	| "a sequence longer than one"
	| "asked past the sequence's end"
	| "a HEAD request"
	| "a chunked response"
	| "an empty chunk"
	| "a complete response"
	| "scripted header lines"

/** A body that holds the connection open: stalled after a prefix, or chunked without its last chunk. */
type HoldingCase = Readonly<{ body: ResponseBody; delay: number }>

const holdingCase: Gen<HoldingCase> = (source) => {
	const held = boolean(source)
	if (held) {
		return {
			body: {
				kind: "chunked",
				chunks: array(
					(chunk): PacedChunk => ({
						delay: Duration.millis(int(0, 1)(chunk)),
						bytes: bytes({ min: 1, max: 5 })(chunk)
					}),
					{ min: 0, max: 3 }
				)(source),
				last: "held"
			},
			delay: int(0, 1)(source)
		}
	}
	const all = bytes({ min: 1, max: 10 })(source)
	return {
		body: { kind: "stalled", bytes: all, sent: int(0, all.length - 1)(source) },
		delay: int(0, 1)(source)
	}
}

/** The body bytes a holding body sends before it holds. */
const prefixOf = (body: ResponseBody): Uint8Array =>
	body.kind === "stalled" ? Uint8Array.from(body.bytes.subarray(0, body.sent)) : bodyOf(body)

type HoldingFeature =
	| "a stalled body"
	| "a stall before any byte"
	| "a held chunked body"
	| "a held body with no chunk"

/** A TLS connection a client opens: the origin it reaches and whether it presents the client certificate. */
type TlsSketch = Readonly<{ origin: TlsOrigin; presents: boolean }>

const tlsSketch: Gen<TlsSketch> = (source) => ({
	origin: element<TlsOrigin>(["A", "B"])(source),
	presents: boolean(source)
})

type TlsFeature =
	| "origin A"
	| "origin B"
	| "a client certificate"
	| "no client certificate"
	| "two connections"

/** A request asking to close its connection, for a path. */
const closingGet = (requestMethod: string, path: string): Uint8Array =>
	latin1Bytes(`${requestMethod} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)

describe("the capture server", () => {
	it.live(
		"records each request as the client sent it, on the origin and connection it used",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const server = yield* captureServer
					return yield* explore(
						{
							suite: "capture server recording",
							draw: drawn((source): Arr.NonEmptyReadonlyArray<ConnectionSketch> =>
								Arr.prepend(
									array(connectionSketch, { min: 0, max: 1 })(source),
									connectionSketch(source)
								)
							),
							literal: Formatter.format,
							coverage: required<RecordingFeature>(
								[
									"127.0.0.1 origin",
									"localhost origin",
									"two connections",
									"pipelined requests",
									"no framing",
									"a Content-Length body",
									"an empty Content-Length body",
									"a chunked body",
									"a chunk extension",
									"a trailer",
									"whitespace around a header value",
									"an empty header value",
									"a latin1 byte in a header value",
									"a repeated header name",
									"a query in the target"
								],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 100,
							shrink: { kind: "bounded", candidates: 200 },
							concurrency: 1,
							steerEvery: 25,
							caseHang: Duration.seconds(10)
						},
						(connections, k) =>
							Effect.gen(function* () {
								Arr.forEach(connections, (sketch) => {
									k.note(sketch.origin === "localhost" ? "localhost origin" : "127.0.0.1 origin")
									if (sketch.requests.length > 1) {
										k.note("pipelined requests")
									}
									Arr.forEach(sketch.requests, (sent) => {
										k.noteAll(requestFeatures(sent))
									})
								})
								if (connections.length > 1) {
									k.note("two connections")
								}
								const observed = yield* server.observe(
									() => ok,
									Effect.forEach(
										connections,
										(sketch) =>
											exchange(
												portOf(server.origins[sketch.origin]),
												connectionBytes(sketch),
												untilClosed
											),
										{ discard: true }
									)
								)
								deepStrictEqual(
									observed.requests,
									Arr.flatMap(connections, (sketch, connection) =>
										Arr.map(recordedOfConnection(sketch), (sent) => ({
											...sent,
											origin: sketch.origin,
											connection
										}))
									),
									"every request is recorded as sent, in order"
								)
								deepStrictEqual(
									observed.connections,
									Arr.map(connections, (sketch) => ({ origin: sketch.origin })),
									"every connection is recorded with its origin, in order"
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)

	it.live("reads the same requests however their bytes are cut", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "capture server reading",
					draw: drawn((source) => ({
						connection: connectionSketch(source),
						cuts: array(int(1, 40), { min: 0, max: 6 })(source)
					})),
					literal: Formatter.format,
					coverage: required<"cut inside a head" | "cut inside a body" | "one piece">(
						["cut inside a head", "cut inside a body", "one piece"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: { kind: "bounded", candidates: 200 },
					concurrency: 1,
					steerEvery: 50,
					caseHang: Duration.seconds(10)
				},
				({ connection, cuts }, k) =>
					Effect.sync(() => {
						const whole = connectionBytes(connection)
						const ends = Arr.dedupe(
							Arr.filter(
								Arr.scan(cuts, 0, (at, size) => at + size),
								(at) => at > 0 && at < whole.length
							)
						)
						const bounds = Arr.appendAll(Arr.prepend(ends, 0), [whole.length])
						const pieces = Arr.map(Arr.zip(bounds, Arr.drop(bounds, 1)), ([from, to]) =>
							whole.subarray(from, to)
						)
						if (pieces.length === 1) {
							k.note("one piece")
						}
						const firstHead = whole.indexOf("\r\n\r\n", 0, "latin1")
						if (Arr.some(ends, (at) => at < firstHead)) {
							k.note("cut inside a head")
						}
						if (Arr.some(ends, (at) => at > firstHead + 4)) {
							k.note("cut inside a body")
						}
						const start: ReadState = { buffer: Buffer.alloc(0), requests: [], malformed: false }
						const read = Arr.reduce(pieces, start, (state, piece): ReadState => {
							const drain = (buffer: Buffer, requests: ReadonlyArray<WireRequest>): ReadState => {
								const parsed = parseRequest(buffer)
								switch (parsed.kind) {
									case "incomplete":
										return { buffer, requests, malformed: false }
									case "malformed":
										return { buffer, requests, malformed: true }
									case "complete":
										return drain(parsed.rest, Arr.append(requests, parsed.value))
								}
							}
							const next = drain(Buffer.concat([state.buffer, piece]), state.requests)
							return { ...next, malformed: state.malformed || next.malformed }
						})
						deepStrictEqual(
							{ requests: read.requests, left: read.buffer.length, malformed: read.malformed },
							{ requests: recordedOfConnection(connection), left: 0, malformed: false },
							"the pieces read as the requests sent, with no byte left over"
						)
					})
			)
		)
	)

	it.live(
		"answers each ask by the script, the sequence's last response repeating, and no body to HEAD",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const server = yield* captureServer
					return yield* explore(
						{
							suite: "capture server answering",
							draw: drawn(answeringCase),
							literal: Formatter.format,
							coverage: required<AnsweringFeature>(
								[
									"a sequence longer than one",
									"asked past the sequence's end",
									"a HEAD request",
									"a chunked response",
									"an empty chunk",
									"a complete response",
									"scripted header lines"
								],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 100,
							shrink: { kind: "bounded", candidates: 200 },
							concurrency: 1,
							steerEvery: 25,
							caseHang: Duration.seconds(10)
						},
						(c, k) =>
							Effect.gen(function* () {
								const answerAt = (attempt: number): ResponseSketch =>
									Arr.getUnsafe(c.responses, Math.min(attempt, c.responses.length - 1))
								if (c.responses.length > 1) {
									k.note("a sequence longer than one")
								}
								if (c.asks > c.responses.length) {
									k.note("asked past the sequence's end")
								}
								if (c.method === "HEAD") {
									k.note("a HEAD request")
								}
								Arr.forEach(c.responses, (response) => {
									k.note(
										response.body.kind === "chunked" ? "a chunked response" : "a complete response"
									)
									if (
										response.body.kind === "chunked" &&
										Arr.some(response.body.chunks, (chunk) => chunk.bytes.length === 0)
									) {
										k.note("an empty chunk")
									}
									if (response.headers.length > 0) {
										k.note("scripted header lines")
									}
								})
								const observed = yield* server.observe(
									(_request, attempt) => ({ ...answerAt(attempt), delay: Duration.zero }),
									Effect.forEach(Arr.range(1, c.asks), () =>
										exchange(
											portOf(server.origins["127.0.0.1"]),
											closingGet(c.method, "/scripted"),
											untilClosed
										)
									)
								)
								deepStrictEqual(
									Arr.map(observed.result, (received) =>
										readResponse(received, c.method === "HEAD")
									),
									Arr.map(Arr.range(0, c.asks - 1), (attempt): Option.Option<ReadResponse> => {
										const answer = answerAt(attempt)
										return Option.some({
											status: answer.status,
											headers: Arr.append(answer.headers, framingOf(answer.body)),
											body: c.method === "HEAD" ? new Uint8Array(0) : bodyOf(answer.body),
											complete: true
										})
									}),
									"each ask reads back as the script's answer for its attempt"
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)

	it.live("sends a holding body's prefix and no more, and sees the client close", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const server = yield* captureServer
				return yield* explore(
					{
						suite: "capture server holding",
						draw: drawn(holdingCase),
						literal: Formatter.format,
						coverage: required<HoldingFeature>(
							[
								"a stalled body",
								"a stall before any byte",
								"a held chunked body",
								"a held body with no chunk"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 50,
						shrink: { kind: "bounded", candidates: 100 },
						concurrency: 1,
						steerEvery: 25,
						caseHang: Duration.seconds(10)
					},
					(c, k) =>
						Effect.gen(function* () {
							if (c.body.kind === "stalled") {
								k.note("a stalled body")
								if (c.body.sent === 0) {
									k.note("a stall before any byte")
								}
							}
							if (c.body.kind === "chunked") {
								k.note("a held chunked body")
								if (c.body.chunks.length === 0) {
									k.note("a held body with no chunk")
								}
							}
							const prefix = prefixOf(c.body)
							const observed = yield* server.observe(
								() => ({ status: 200, headers: [], delay: Duration.millis(c.delay), body: c.body }),
								exchange(
									portOf(server.origins["127.0.0.1"]),
									closingGet("GET", "/held"),
									(received) =>
										Option.exists(
											readResponse(received, false),
											(response) => response.body.length >= prefix.length
										)
								)
							)
							deepStrictEqual(
								readResponse(observed.result, false),
								Option.some({
									status: 200,
									headers: [framingOf(c.body)],
									body: prefix,
									complete: false
								}),
								"the client reads the head and exactly the prefix, and the body stays incomplete"
							)
						})
				)
			}).pipe(Effect.scoped)
		)
	)
})

/** Connects over TLS to the origin's port, trusting the fixture's CA, presenting the client certificate when asked. */
const exchangeTls = (
	port: number,
	trust: Readonly<{ ca: string; cert: string; key: string }>,
	presents: boolean
): Effect.Effect<Uint8Array> =>
	Effect.callback<Uint8Array>((resume) => {
		const received: Array<Buffer> = []
		const socket = connectTls(
			presents
				? {
						host: "127.0.0.1",
						port,
						servername: "localhost",
						ca: trust.ca,
						cert: trust.cert,
						key: trust.key
					}
				: { host: "127.0.0.1", port, servername: "localhost", ca: trust.ca }
		)
		socket.on("data", (chunk: Buffer) => {
			received.push(chunk)
		})
		socket.once("close", () => {
			resume(Effect.succeed(Uint8Array.from(Buffer.concat(received))))
		})
		socket.on("error", () => {
			socket.destroy()
		})
		socket.once("secureConnect", () => {
			socket.write(closingGet("GET", "/tls"))
		})
		return Effect.sync(() => {
			socket.destroy()
		})
	})

layer(harnessLayer, { excludeTestServices: true })("the TLS capture server", (it) => {
	it.effect(
		"records each connection's origin and the client certificate exactly when one was presented",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const server = yield* tlsCaptureServer
					const trust = {
						ca: server.certificates.ca.text,
						cert: server.certificates.client.cert.text,
						key: server.certificates.client.key.text
					}
					return yield* explore(
						{
							suite: "TLS capture server certificates",
							draw: drawn((source): Arr.NonEmptyReadonlyArray<TlsSketch> =>
								Arr.prepend(array(tlsSketch, { min: 0, max: 2 })(source), tlsSketch(source))
							),
							literal: Formatter.format,
							coverage: required<TlsFeature>(
								[
									"origin A",
									"origin B",
									"a client certificate",
									"no client certificate",
									"two connections"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 20,
							shrink: { kind: "bounded", candidates: 60 },
							concurrency: 1,
							steerEvery: 10,
							caseHang: Duration.seconds(10)
						},
						(connections, k) =>
							Effect.gen(function* () {
								Arr.forEach(connections, (sketch) => {
									k.note(sketch.origin === "A" ? "origin A" : "origin B")
									k.note(sketch.presents ? "a client certificate" : "no client certificate")
								})
								if (connections.length > 1) {
									k.note("two connections")
								}
								const observed = yield* server.observe(
									() => ok,
									Effect.forEach(connections, (sketch) =>
										exchangeTls(portOf(server.origins[sketch.origin]), trust, sketch.presents)
									)
								)
								deepStrictEqual(
									{
										connections: observed.connections,
										requests: Arr.map(observed.requests, ({ origin, connection }) => ({
											origin,
											connection
										})),
										statuses: Arr.map(observed.result, (received) =>
											Option.map(readResponse(received, false), (response) => response.status)
										)
									},
									{
										connections: Arr.map(connections, (sketch) => ({
											origin: sketch.origin,
											certificate: sketch.presents ? Option.some(clientSubject) : Option.none()
										})),
										requests: Arr.map(connections, (sketch, connection) => ({
											origin: sketch.origin,
											connection
										})),
										statuses: Arr.map(connections, () => Option.some(200))
									},
									"each connection is recorded with its origin and the certificate it presented"
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
