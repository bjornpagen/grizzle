import { Option, Result, String as Str } from "effect"
import { Url } from "effect/http"

/**
 * Resolves a URI reference against a base (RFC 3986 section 5.2 through WHATWG `URL`). `None` when
 * the result is not a URI, for example a relative path against a `urn:` base.
 */
export const resolveUri = (reference: string, base: string): Option.Option<string> =>
	Option.map(Result.getSuccess(Url.fromString(reference, base)), (url) => url.href)

/**
 * Splits a URI reference at its first `#` into the resource part and the fragment, `None` when the
 * reference has no `#`. A `#` inside the fragment stays in the fragment.
 */
export const splitFragment = (
	uri: string
): readonly [resource: string, fragment: Option.Option<string>] =>
	Option.match(Str.indexOf("#")(uri), {
		onNone: () => [uri, Option.none()],
		onSome: (hash) => [Str.slice(0, hash)(uri), Option.some(Str.slice(hash + 1)(uri))]
	})

/**
 * Drops the fragment, so the result names a resource (RFC 3986 section 5.2.1).
 */
export const stripFragment = (uri: string): string => splitFragment(uri)[0]

/**
 * A retrieval URI in normal form with its fragment stripped: the resource a document is in the set
 * as.
 */
export const retrievalBase = (retrieval: string): string =>
	stripFragment(Option.getOrElse(resolveUri(retrieval, retrieval), () => retrieval))
