import { regex } from "arkregex"
import { Array as Arr, Schema, String as Str } from "effect"
import { pointerPattern } from "#model/pointer.ts"

const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"

const concrete = "[!#$%&'+.^_`|~0-9A-Za-z-]+"

const quoted = '"(?:[\\t !#-\\[\\]-~]|\\\\[\\t -~])*"'

const parameters = `(?:[ \\t]*;[ \\t]*${token}=(?:${token}|${quoted}))*`

const pathSegment =
	"(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2}|\\{[^{}/?#\\s\\p{Cc}\\p{Cs}]+\\})*"

const serverChar = "(?:[A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2}|\\{[^{}/?#\\s]+\\})"

const uriChar = "(?:[A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})"

const tokenPattern = regex(`^${token}$`, "u")

const mediaTypePattern = regex(`^${concrete}/${concrete}${parameters}$`, "u")

const mediaRangePattern = regex(
	`^(?:\\*/\\*|${concrete}/\\*|${concrete}/${concrete})${parameters}$`,
	"u"
)

const pathPattern = regex(`^(?:/${pathSegment})+$`, "u")

const encodedDot = regex("%2e", "giu")

const isDotSegment = (segment: string): boolean => {
	const decoded = Str.replaceAll(encodedDot, ".")(segment)

	return decoded === "." || decoded === ".."
}

const hasValidSegments = (value: string): boolean => {
	const segments = Arr.drop(Str.split(value, "/"), 1)
	const last = segments.length - 1

	return Arr.every(
		segments,
		(segment, index) => (!Str.isEmpty(segment) || index === last) && !isDotSegment(segment)
	)
}

const serverPattern = regex(`^${serverChar}+$`, "u")

const uriPattern = regex(`^[A-Za-z][A-Za-z0-9+.-]*:${uriChar}*$`, "u")

const wireNamePattern = regex("^[^\\p{Cc}\\p{Cs}]+$", "u")

/**
 * The Unicode categories that safe text excludes, as a regular expression class body.
 *
 * Controls, format characters, line and paragraph separators and lone surrogates; LF and TAB are
 * re-admitted by each pattern built from it.
 */
const safeTextCategories = "\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}"

const safeTextPattern = regex(`^(?:[^${safeTextCategories}]|[\\n\\t])*$`, "u")

const unsafeCharacter = regex(`(?![\\n\\t])[${safeTextCategories}]`, "gu")

const pattern = (regExp: RegExp) => Schema.String.pipe(Schema.check(Schema.isPattern(regExp)))

/**
 * A parameter, property or field name exactly as the specification spells it.
 */
export const WireName = pattern(wireNamePattern).pipe(Schema.brand("WireName"))

/**
 * An RFC 9110 header field name.
 */
export const HeaderName = pattern(tokenPattern).pipe(Schema.brand("HeaderName"))

/**
 * An RFC 6265 cookie name.
 */
export const CookieName = pattern(tokenPattern).pipe(Schema.brand("CookieName"))

/**
 * An RFC 9110 8.3.1 media type, parameters allowed, no wildcards.
 */
export const MediaType = pattern(mediaTypePattern).pipe(Schema.brand("MediaType"))

/**
 * An RFC 9110 8.3.1 media range, wildcards allowed.
 */
export const MediaRange = pattern(mediaRangePattern).pipe(Schema.brand("MediaRange"))

/**
 * An OpenAPI 3.2.1 path template: absolute, with balanced non-empty expressions, no dot segments
 * and no empty segment except the last.
 */
export const PathTemplate = pattern(pathPattern).pipe(
	Schema.check(Schema.makeFilter(hasValidSegments)),
	Schema.brand("PathTemplate")
)

/**
 * A server URL template with balanced non-empty variables.
 */
export const ServerTemplate = pattern(serverPattern).pipe(Schema.brand("ServerTemplate"))

/**
 * An RFC 9110 method token a request is sent with, exactly as spelled: any token but `CONNECT`,
 * which asks for a tunnel instead of a response.
 */
export const MethodToken = pattern(tokenPattern).pipe(
	Schema.check(Schema.makeFilter((method: string) => method !== "CONNECT")),
	Schema.brand("MethodToken")
)

/**
 * Help-safe plain text: no controls except LF and TAB, no format, separator or lone surrogate
 * characters.
 */
export const SafeText = pattern(safeTextPattern).pipe(Schema.brand("SafeText"))

/**
 * Source text made safe whatever its length: removes exactly the characters of the categories
 * `SafeText` rejects, so the result is always `SafeText`.
 */
export const stripUnsafeText = (text: string): typeof SafeText.Type =>
	SafeText.make(Str.replaceAll(unsafeCharacter, "")(text))

/**
 * The most code points one piece of source prose keeps in help and the report.
 */
const maxProseLength = 2000

/**
 * Source prose made help-safe: `stripUnsafeText`, then the first `maxProseLength` code points.
 */
export const sanitizeProse = (text: string): typeof SafeText.Type =>
	SafeText.make(Arr.join(Arr.take(Arr.fromIterable(stripUnsafeText(text)), maxProseLength), ""))

/**
 * An absolute URI with ASCII characters only.
 */
export const DocumentUri = pattern(uriPattern).pipe(Schema.brand("DocumentUri"))

/**
 * An RFC 6901 JSON Pointer.
 */
export const JsonPointer = Schema.String.pipe(
	Schema.check(Schema.isPattern(pointerPattern)),
	Schema.brand("JsonPointer")
)

/**
 * A finite JSON value. Resource bounds belong to the stage budgets, not the brand.
 */
export const JsonLiteral = Schema.Json.pipe(Schema.brand("JsonLiteral"))

/**
 * A SHA-256 digest as 64 lowercase hexadecimal digits.
 */
export const Sha256Hex = pattern(regex("^[0-9a-f]{64}$", "u"))

/**
 * The OpenAPI component-name pattern: the key grammar every Components Object map shares.
 */
export const componentNamePattern = regex("^[a-zA-Z0-9.\\-_]+$", "u")

/**
 * A Components Object key that matches the component-name pattern.
 */
export const ComponentName = pattern(componentNamePattern)
