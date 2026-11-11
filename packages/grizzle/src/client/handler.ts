import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"

/**
 * The body of a request the client sends, as a web Request takes it: none, or its bytes. The client sends nothing else
 * (call.ts sends its input as text), so any other body is refused before the handler is called.
 */
const bodyOf = (
	request: HttpClientRequest.HttpClientRequest
): Effect.Effect<Option.Option<Uint8Array<ArrayBuffer>>, HttpClientError.HttpClientError> => {
	const body = request.body
	switch (body._tag) {
		case "Empty":
			return Effect.succeedNone
		case "Uint8Array":
			return Effect.succeedSome(new Uint8Array(body.body))
		case "Raw":
		case "FormData":
		case "Stream":
			return Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.EncodeError({
						request,
						description: `the in-process client sends an empty body or bytes, not a ${body._tag} body`
					})
				})
			)
	}
}

/**
 * handlerClient(handler): an HttpClient that answers each request by calling a web handler in the same process, as
 * @bjornpagen/grizzle's HTTP handler is (`(request: Request) => Promise<Response>`), with no socket between them.
 * Each request is built as the web Request a fetch would send, its AbortSignal the client's, so interrupting a call
 * aborts the handler's request and cancels its answer's body. Provide it as the HttpClient a client's calls require,
 * for a test or a server rendering through its own handler.
 */
export const handlerClient = (
	handler: (request: Request) => Promise<Response>
): HttpClient.HttpClient =>
	HttpClient.make((request, url, signal) =>
		bodyOf(request).pipe(
			Effect.map((body): RequestInit =>
				Option.match(body, {
					onNone: () => ({ method: request.method, headers: request.headers, signal }),
					onSome: (bytes) => ({
						method: request.method,
						headers: request.headers,
						signal,
						body: bytes
					})
				})
			),
			Effect.flatMap((init) =>
				Effect.tryPromise({
					try: () => handler(new Request(url, init)),
					catch: (cause) =>
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({ request, cause })
						})
				})
			),
			Effect.map((response) => HttpClientResponse.fromWeb(request, response))
		)
	)
