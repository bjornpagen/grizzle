import { Array as Arr, Data, Effect, Option, Record as Rec, Stream, String as Str } from "effect"
import type { HttpHandler } from "#http/handler.ts"

/**
 * nodeListener(handler): a fetch-style handler mounted on Node's servers, `http.createServer(nodeListener(handler))`,
 * `https.createServer(options, ...)`, or node:http2's `createServer` or `createSecureServer` through their
 * compatibility API. It reads only what the two APIs' requests and responses share (NodeRequest, NodeResponse), so it
 * imports no Node module.
 */

/** What nodeListener reads of a request of node:http or node:http2's compatibility API. */
export interface NodeRequest extends AsyncIterable<Uint8Array> {
	readonly method?: string | undefined
	readonly url?: string | undefined
	/** The request's headers as received, name then value; node:http2's pseudo-headers (`:path`) among them. */
	readonly rawHeaders: ReadonlyArray<string>
}

/** What nodeListener writes of a response of node:http or node:http2's compatibility API. */
export interface NodeResponse {
	writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown
	/** Writes a chunk: false when the connection's buffer is full, until it drains. */
	write(chunk: Uint8Array): boolean
	end(): unknown
	/** Ends the response's connection, or its HTTP/2 stream, at once: the answer cannot be finished. */
	destroy(): unknown
	once(event: "close" | "drain", listener: () => void): unknown
}

/** An answer that failed as it was made or read: it cannot be finished. */
class Unanswered extends Data.TaggedError("Unanswered")<{ readonly cause: unknown }> {}

/**
 * The origin a request's target is read against. A Node request holds its target alone (`/web/member/posts`), and the
 * handler routes by path and query alone (request.ts requestLine), so the origin is a name no host holds (RFC 2606).
 */
const origin = "http://grizzle.invalid"

/** The methods whose requests Fetch builds with no body, whatever the request held. */
const bodiless: ReadonlySet<string> = new Set(["GET", "HEAD"])

/**
 * The headers of a Node request as Fetch holds them: each name and value as received, but node:http2's
 * pseudo-headers, which Fetch's request holds as its method and URL.
 */
const fetchHeaders = (raw: ReadonlyArray<string>): Headers => {
	const headers = new Headers()
	for (const [name, value] of Arr.chunksOf(raw, 2)) {
		if (value !== undefined && !Str.startsWith(":")(name)) {
			headers.append(name, value)
		}
	}
	return headers
}

/**
 * A Node request as Fetch's, aborted by `signal`: its method, its target against the origin, its headers, and its
 * body, a stream of its chunks, for a method that holds one. A request without a method or a target, which a server's
 * never is, and one Fetch refuses (a method it forbids, such as TRACE) are none.
 */
const fetchRequest = (request: NodeRequest, signal: AbortSignal): Option.Option<Request> =>
	Option.flatMap(
		Option.all({
			method: Option.fromNullishOr(request.method),
			target: Option.fromNullishOr(request.url)
		}),
		({ method, target }) =>
			Option.liftThrowable(
				() =>
					new Request(new URL(target, origin), {
						method,
						headers: fetchHeaders(request.rawHeaders),
						...(bodiless.has(method)
							? {}
							: {
									body: ReadableStream.from(request),
									duplex: "half"
								}),
						signal
					})
			)()
	)

/** Writes `chunk`, then waits for the connection to drain when its buffer is full: the answer's backpressure. */
const written = (response: NodeResponse, chunk: Uint8Array): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		if (response.write(chunk)) {
			resume(Effect.void)
		} else {
			response.once("drain", () => resume(Effect.void))
		}
	})

/**
 * `answer` written to `response`: its status and headers, then its body's chunks as the connection takes them, then
 * its end. A body that fails ends the connection instead, so the client never reads a cut answer as a whole one.
 */
const writeAnswer = (answer: Response, response: NodeResponse): Effect.Effect<void> =>
	Effect.gen(function* () {
		response.writeHead(answer.status, Rec.fromEntries(answer.headers.entries()))
		const body: ReadableStream<Uint8Array> | null = answer.body
		if (body !== null) {
			yield* Stream.runForEach(
				Stream.fromReadableStream({
					evaluate: () => body,
					onError: (cause) => new Unanswered({ cause })
				}),
				(chunk) => written(response, chunk)
			)
		}
		response.end()
	}).pipe(Effect.catch(() => Effect.sync(() => response.destroy())))

/**
 * The listener of `handler` (see the header): each request built as Fetch's (fetchRequest), its signal aborted and its
 * answer's writing interrupted when the response closes, so a client that goes away ends its call; and its answer
 * written as the connection takes it (writeAnswer). A request Fetch cannot hold, or a handler that fails, ends the
 * connection.
 */
export const nodeListener =
	(handler: HttpHandler) =>
	(request: NodeRequest, response: NodeResponse): void => {
		const closed = new AbortController()
		const answering = Effect.runFork(
			Option.match(fetchRequest(request, closed.signal), {
				onNone: () => Effect.sync(() => response.destroy()),
				onSome: (built) =>
					Effect.flatMap(
						Effect.tryPromise({
							try: () => handler(built),
							catch: (cause) => new Unanswered({ cause })
						}),
						(answer) => writeAnswer(answer, response)
					).pipe(Effect.catch(() => Effect.sync(() => response.destroy())))
			})
		)
		response.once("close", () => {
			closed.abort()
			answering.interruptUnsafe()
		})
	}
