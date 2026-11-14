import { Array as Arr, Effect, Option, Result, String as Str } from "effect"
import { parseToken, type Token } from "#adapter/db/token.ts"
import { doorRefusal } from "#adapter/live/call-error.ts"
import type { CallErrorOf, FailureOf } from "#compiler/live/index.ts"
import { trustedJson, wireHeader } from "#compiler/plan/runtime.ts"

/**
 * What the handler reads of a request, each read once at the boundary into what its call takes: the request line it
 * is routed by, the bearer token it opens its Db with, and its body's JSON value, which the member's wire admits as the
 * call's input (live/wire.ts admitInput).
 */

/**
 * The request line a request is routed by (routes.ts routeLine): its method and its target, the URL's path and query
 * as the request holds them, so a route is found by one lookup and another method or any query finds none.
 */
export const requestLine = (request: Request): string => {
	const url = new URL(request.url)
	return `${request.method} ${url.pathname}${url.search}`
}

/** The Authorization scheme of a bearer token and the space that ends it, in lower case. */
const bearerScheme = "bearer "

/**
 * The bearer token of a request's Authorization header (RFC 6750 section 2.1): none without the header; the text after
 * `Bearer` and one or more spaces, the scheme in any case, parsed as every door parses a token (db/token.ts parseToken,
 * as Db.open's options are), so in process and over HTTP the same tokens are accepted; any other header is a refused
 * token.
 */
export const authorizationToken = (
	request: Request
): Result.Result<Option.Option<Token>, CallErrorOf<"tokenRefused">> =>
	Option.match(Option.fromNullishOr(request.headers.get("authorization")), {
		onNone: () => Result.succeed(Option.none()),
		onSome: (header) => {
			const text = Arr.join(
				Arr.dropWhile(Arr.fromIterable(Str.slice(bearerScheme.length)(header)), (c) => c === " "),
				""
			)
			const refused = doorRefusal(
				"TokenUnreadable",
				"the Authorization header holds no bearer token68"
			)
			return Str.toLowerCase(Str.slice(0, bearerScheme.length)(header)) === bearerScheme
				? Result.mapBoth(parseToken(text), { onFailure: () => refused, onSuccess: Option.some })
				: Result.fail(refused)
		}
	})

/**
 * That a request names the wire of the member it calls, by the digest generate computed of the member's form
 * (live/wire.ts MemberWire digest), which a client holding the login's OpenAPI document sends as `grizzle-wire`: a
 * request naming none is a refused input, and one naming another form is stale, so a client never decodes an answer
 * by a form the server no longer serves. Both are answered before the Db opens.
 */
export const wireNamed = (
	request: Request,
	digest: string
): Result.Result<void, FailureOf<"door">> =>
	Option.match(Option.fromNullishOr(request.headers.get(wireHeader)), {
		onNone: () => Result.fail(doorRefusal("WireAbsent", `the call names no ${wireHeader} digest`)),
		onSome: (named) =>
			named === digest
				? Result.void
				: Result.fail(
						doorRefusal(
							"WireOther",
							`the call's ${wireHeader} digest names a form of its program the server no longer serves`
						)
					)
	})

/** UTF-8, every malformed sequence refused: a body is JSON text, which RFC 8259 requires in UTF-8. */
const utf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * A request's body, read whole and parsed as JSON once: a body that cannot be read, is not UTF-8 or is not JSON text
 * is a refused input. Its value is admitted against the member's input by its wire, never here.
 */
export const bodyJson = (request: Request): Effect.Effect<unknown, FailureOf<"door">> =>
	Effect.flatMap(
		Effect.tryPromise({
			try: () => request.arrayBuffer(),
			catch: () => doorRefusal("BodyUnreadable", "the body could not be read")
		}),
		(bytes) =>
			Effect.try({
				try: () => trustedJson<unknown>(utf8.decode(bytes)),
				catch: () => doorRefusal("BodyNoJson", "the body is no JSON text in UTF-8")
			})
	)
