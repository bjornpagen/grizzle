import { createServer, type Socket as NetSocket } from "node:net"
import { createServer as createTlsServer, type TLSSocket } from "node:tls"
import { NodeSocket } from "@effect/platform-node"
import { Array as Arr, type Duration, Effect, MutableHashMap, Option, String as Str } from "effect"
import type { Scope } from "effect"
import { Socket } from "effect/socket"
import { type Certificates, makeCertificates, type TlsOrigin } from "#test/support/certificates.ts"
import {
	closedOf,
	type ListenFailed,
	listen,
	makeSessions,
	tracked
} from "#test/support/connection.ts"
import {
	closesConnection,
	type Header,
	type HeaderList,
	parseRequest,
	type WireRequest
} from "#test/support/http.ts"

/**
 * One request as the server read it off the wire: the origin it reached, the index of its connection in the
 * observation's connections, its request line's method and target as sent, its header lines, and its body's bytes once
 * any chunked framing is removed.
 */
export type RecordedRequest<O extends string> = WireRequest &
	Readonly<{ origin: O; connection: number }>

/** A chunk of a chunked body: written once its delay after the previous write has passed. A chunk of no bytes writes nothing. */
export type PacedChunk = Readonly<{ delay: Duration.Duration; bytes: Uint8Array }>

/**
 * A response body and how it travels. `complete` is every byte under its Content-Length. `stalled` promises every
 * byte in its Content-Length, sends the first `sent` and then holds the connection open. `chunked` sends each chunk
 * after its delay under `Transfer-Encoding: chunked`, then either the last chunk (`terminated`) or nothing more while
 * the connection stays open (`held`).
 */
export type ResponseBody =
	| Readonly<{ kind: "complete"; bytes: Uint8Array }>
	| Readonly<{ kind: "stalled"; bytes: Uint8Array; sent: number }>
	| Readonly<{ kind: "chunked"; chunks: ReadonlyArray<PacedChunk>; last: "terminated" | "held" }>

/**
 * A scripted response: its status, its header lines as written (the framing header follows them), how long the server
 * waits before writing the status line, and its body. A response to `HEAD` carries no body bytes.
 */
export type ScriptedResponse = Readonly<{
	status: number
	headers: HeaderList
	delay: Duration.Duration
	body: ResponseBody
}>

/**
 * How the server answers during an observation: a function of the request and of how many earlier requests in the
 * observation named the same path (the target before any `?`), so a path can answer a sequence.
 */
export type Script<O extends string> = (
	request: RecordedRequest<O>,
	attempt: number
) => ScriptedResponse

/** One connection the server accepted: the origin it reached. */
type PlainConnection<O extends string> = Readonly<{ origin: O }>

/** One TLS connection the server accepted: the origin it reached and the subject of the client certificate it presented. */
type TlsConnection = Readonly<{ origin: TlsOrigin; certificate: Option.Option<string> }>

/**
 * What a run did to the server: the run's result, every request the server read during it in the order it read them,
 * and every connection it accepted, in the order it accepted them; a request's `connection` indexes this list.
 */
type Observed<A, O extends string, C> = Readonly<{
	result: A
	requests: ReadonlyArray<RecordedRequest<O>>
	connections: ReadonlyArray<C>
}>

/**
 * A server that records what reaches it while it runs an effect. `observe` answers by the script, runs the effect, then
 * waits until every connection the run opened has closed, so the observation is complete; observations never overlap,
 * and a connection that arrives outside one is closed unanswered and unrecorded.
 */
type Observer<O extends string, C> = Readonly<{
	observe: <A, E, R>(
		script: Script<O>,
		run: Effect.Effect<A, E, R>
	) => Effect.Effect<Observed<A, O, C>, E, R>
}>

/** The plain capture server's origins: two listeners on 127.0.0.1, one named by its address and one by `localhost`. */
export type PlainOrigin = "127.0.0.1" | "localhost"

/** The plain capture server: each origin's URL (`http://<name>:<port>`) and its observer. */
export type CaptureServer = Observer<PlainOrigin, PlainConnection<PlainOrigin>> &
	Readonly<{ origins: Readonly<Record<PlainOrigin, string>> }>

/**
 * The TLS capture server: each origin's URL (`https://127.0.0.1:<port>`), the certificates its origins present and a
 * client may present, and its observer.
 */
export type TlsCaptureServer = Observer<TlsOrigin, TlsConnection> &
	Readonly<{ origins: Readonly<Record<TlsOrigin, string>>; certificates: Certificates }>

/** The path a target names: everything before its query. */
const pathOf = (target: string): string => Arr.headNonEmpty(Str.split("?")(target))

/** The status line and header lines of a response, with the framing header its body needs. */
const headOf = (response: ScriptedResponse): Buffer => {
	const framing: Header =
		response.body.kind === "chunked"
			? ["Transfer-Encoding", "chunked"]
			: ["Content-Length", String(response.body.bytes.length)]
	const lines = Arr.map(
		Arr.append(response.headers, framing),
		([name, value]) => `${name}: ${value}`
	)
	return Buffer.from(
		`${Arr.join(Arr.prepend(lines, `HTTP/1.1 ${String(response.status)} Scripted`), "\r\n")}\r\n\r\n`,
		"latin1"
	)
}

const CRLF = Buffer.from("\r\n", "latin1")

/** One chunk's frame: its size in hexadecimal, its bytes and the CRLF after them. */
const chunkFrame = (bytes: Uint8Array): Buffer =>
	Buffer.concat([Buffer.from(`${bytes.length.toString(16)}\r\n`, "latin1"), bytes, CRLF])

/** Writes a scripted response; it returns once the body is sent, and never for a body that holds the connection. */
const writeResponse = (
	writer: Socket.Writer,
	response: ScriptedResponse,
	bodyless: boolean
): Effect.Effect<void, Socket.SocketError> =>
	Effect.gen(function* () {
		yield* Effect.sleep(response.delay)
		const head = headOf(response)
		if (bodyless) {
			return yield* writer.write(head)
		}
		switch (response.body.kind) {
			case "complete":
				return yield* writer.write(Buffer.concat([head, response.body.bytes]))
			case "stalled":
				yield* writer.write(
					Buffer.concat([head, response.body.bytes.subarray(0, response.body.sent)])
				)
				return yield* Effect.never
			case "chunked": {
				yield* writer.write(head)
				yield* Effect.forEach(
					response.body.chunks,
					(chunk) =>
						Effect.sleep(chunk.delay).pipe(
							Effect.andThen(
								chunk.bytes.length === 0 ? Effect.void : writer.write(chunkFrame(chunk.bytes))
							)
						),
					{ discard: true }
				)
				return yield* response.body.last === "terminated"
					? writer.write(Buffer.from("0\r\n\r\n", "latin1"))
					: Effect.never
			}
		}
	})

/** One observation in progress: its script, what it recorded, and how often each path was asked. */
type Session<O extends string, C> = Readonly<{
	script: Script<O>
	requests: Array<RecordedRequest<O>>
	connections: Array<C>
	attempts: MutableHashMap.MutableHashMap<string, number>
}>

/**
 * Serves one connection for a session: reads each request, records it, answers it by the script, and ends the
 * connection after a request that asked to close it, or when the client closes it or sends what is not a request.
 */
const serveConnection = <O extends string, C>(
	conn: NetSocket,
	session: Session<O, C>,
	origin: O,
	connection: number
): Effect.Effect<void> =>
	Effect.scoped(
		Effect.gen(function* () {
			const socket = yield* NodeSocket.fromDuplex(
				Effect.acquireRelease(Effect.succeed(conn), (open) =>
					Effect.sync(() => {
						open.destroySoon()
					})
				),
				{ tlsServer: true }
			)
			const pull = yield* Socket.readerBytes(socket)
			const writer = yield* socket.writer
			const next = (buffer: Buffer): Effect.Effect<void, Socket.SocketError> => {
				const parsed = parseRequest(buffer)
				switch (parsed.kind) {
					case "malformed":
						return Effect.void
					case "incomplete":
						return Effect.flatMap(pull, (chunks) =>
							next(Buffer.concat(Arr.prepend(chunks, buffer)))
						)
					case "complete": {
						const request: RecordedRequest<O> = { ...parsed.value, origin, connection }
						const path = pathOf(request.target)
						const attempt = Option.getOrElse(MutableHashMap.get(session.attempts, path), () => 0)
						MutableHashMap.set(session.attempts, path, attempt + 1)
						session.requests.push(request)
						return writeResponse(
							writer,
							session.script(request, attempt),
							request.method === "HEAD"
						).pipe(
							Effect.andThen(closesConnection(request.headers) ? Effect.void : next(parsed.rest))
						)
					}
				}
			}
			yield* next(Buffer.alloc(0))
		})
	).pipe(
		Effect.catchTag("SocketError", () => Effect.void),
		Effect.raceFirst(closedOf(conn))
	)

/** A capture server's observer over its listeners' sessions. */
const makeObserver = <O extends string, C>() =>
	Effect.map(makeSessions<Session<O, C>>(), (sessions) => ({
		accept: (conn: NetSocket, origin: O, describe: C) => {
			sessions.accept(conn, (session) => {
				const connection = session.connections.length
				session.connections.push(describe)
				return serveConnection(conn, session, origin, connection)
			})
		},
		observe: <A, E, R>(
			script: Script<O>,
			run: Effect.Effect<A, E, R>
		): Effect.Effect<Observed<A, O, C>, E, R> =>
			Effect.suspend(() => {
				const session: Session<O, C> = {
					script,
					requests: [],
					connections: [],
					attempts: MutableHashMap.empty()
				}
				return Effect.map(sessions.observe(session, run), (result) => ({
					result,
					requests: session.requests,
					connections: session.connections
				}))
			})
	}))

/**
 * Starts the plain capture server: origins `127.0.0.1` and `localhost`, each its own listener on 127.0.0.1, so a run
 * can tell which origin a request reached. The scope stops both.
 */
export const captureServer: Effect.Effect<CaptureServer, ListenFailed, Scope.Scope> = Effect.gen(
	function* () {
		const observer = yield* makeObserver<PlainOrigin, PlainConnection<PlainOrigin>>()
		const start = Effect.fn("captureServer.origin")(function* (origin: PlainOrigin) {
			const server = yield* tracked(createServer())
			server.on("connection", (conn: NetSocket) => {
				observer.accept(conn, origin, { origin })
			})
			const port = yield* listen(server)
			return `http://${origin}:${String(port)}`
		})
		const server: CaptureServer = {
			origins: { "127.0.0.1": yield* start("127.0.0.1"), localhost: yield* start("localhost") },
			observe: observer.observe
		}
		return server
	}
)

/**
 * Starts the TLS capture server: origins A and B, each its own TLS listener on 127.0.0.1 presenting its certificate.
 * Each asks every connection for a client certificate and accepts any or none, recording the subject it got. The
 * certificates are made with openssl in a temporary directory; the scope stops both listeners and removes it. Trust
 * `certificates.ca` (`NODE_EXTRA_CA_CERTS` for a child process) to verify the origins.
 */
export const tlsCaptureServer = Effect.gen(function* () {
	const certificates = yield* makeCertificates()
	const observer = yield* makeObserver<TlsOrigin, TlsConnection>()
	const start = Effect.fn("tlsCaptureServer.origin")(function* (origin: TlsOrigin) {
		const server = yield* tracked(
			createTlsServer({
				cert: certificates.servers[origin].cert.text,
				key: certificates.servers[origin].key.text,
				requestCert: true,
				rejectUnauthorized: false
			})
		)
		server.on("tlsClientError", (_error: Error, socket: TLSSocket) => {
			socket.destroy()
		})
		server.on("secureConnection", (conn: TLSSocket) => {
			observer.accept(conn, origin, {
				origin,
				certificate: Option.map(
					Option.fromNullishOr(conn.getPeerX509Certificate()),
					(certificate) => certificate.subject
				)
			})
		})
		const port = yield* listen(server)
		return `https://127.0.0.1:${String(port)}`
	})
	const server: TlsCaptureServer = {
		origins: { A: yield* start("A"), B: yield* start("B") },
		certificates,
		observe: observer.observe
	}
	return server
})
