import { regex } from "arkregex"
import { Array as Arr, Brand, Schema, String as Str } from "effect"
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
 * An RFC 9110 8.3.1 media type, parameters allowed, no wildcards.
 */
export const MediaType = pattern(mediaTypePattern).pipe(Schema.brand("MediaType"))

/**
 * An OpenAPI 3.2.1 path template: absolute, with balanced non-empty expressions, no dot segments
 * and no empty segment except the last.
 */
export const PathTemplate = pattern(pathPattern).pipe(
	Schema.check(Schema.makeFilter(hasValidSegments)),
	Schema.brand("PathTemplate")
)

/**
 * An RFC 9110 method token a request is sent with, exactly as spelled: any token but `CONNECT`,
 * which asks for a tunnel instead of a response.
 */
export const MethodToken = pattern(tokenPattern).pipe(
	Schema.check(Schema.makeFilter((method: string) => method !== "CONNECT")),
	Schema.brand("MethodToken")
)

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
 * A finite JSON value.
 */
export const JsonLiteral = Schema.Json.pipe(Schema.brand("JsonLiteral"))

/**
 * A SHA-256 digest as 64 lowercase hexadecimal digits.
 */
export const Sha256Hex = pattern(regex("^[0-9a-f]{64}$", "u"))

/**
 * A parameter, property or field name exactly as the specification spells it: no control and no lone surrogate.
 */
export type WireName = string & Brand.Brand<"WireName">

/** Whether a text is a WireName. */
export const isWireName = (text: string): text is WireName => wireNamePattern.test(text)

/** An RFC 9110 header field name: a token. */
export type HeaderName = string & Brand.Brand<"HeaderName">

/** Whether a text is a HeaderName. */
export const isHeaderName = (text: string): text is HeaderName => tokenPattern.test(text)

/** An RFC 6265 cookie name: a token. */
export type CookieName = string & Brand.Brand<"CookieName">

/** Whether a text is a CookieName. */
export const isCookieName = (text: string): text is CookieName => tokenPattern.test(text)

/** An RFC 9110 8.3.1 media type, parameters allowed, no wildcards. */
export type MediaType = string & Brand.Brand<"MediaType">

/** Whether a text is a MediaType. */
export const isMediaType = (text: string): text is MediaType => mediaTypePattern.test(text)

/** An RFC 9110 8.3.1 media range, wildcards allowed. */
export type MediaRange = string & Brand.Brand<"MediaRange">

/** Whether a text is a MediaRange. */
export const isMediaRange = (text: string): text is MediaRange => mediaRangePattern.test(text)

/**
 * A MediaRange the code writes as a literal, such as a part's default content type in the encoding table, unchecked:
 * the literal is the proof. Text from anywhere else goes through isMediaRange.
 */
export const fixedMediaRange: (literal: string) => MediaRange = Brand.nominal<MediaRange>()

/**
 * An OpenAPI 3.2.1 path template: absolute, with balanced non-empty expressions, no dot segments and no empty segment
 * except the last.
 */
export type PathTemplate = string & Brand.Brand<"PathTemplate">

/** Whether a text is a PathTemplate. */
export const isPathTemplate = (text: string): text is PathTemplate =>
	pathPattern.test(text) && hasValidSegments(text)

/** A server URL template with balanced non-empty variables. */
export type ServerTemplate = string & Brand.Brand<"ServerTemplate">

/** Whether a text is a ServerTemplate. */
export const isServerTemplate = (text: string): text is ServerTemplate => serverPattern.test(text)

/**
 * An RFC 9110 method token a request is sent with, exactly as spelled: any token but `CONNECT`, which asks for a tunnel
 * instead of a response.
 */
export type MethodToken = string & Brand.Brand<"MethodToken">

/** Whether a text is a MethodToken. */
export const isMethodToken = (text: string): text is MethodToken =>
	tokenPattern.test(text) && text !== "CONNECT"

/**
 * Help-safe plain text: no controls except LF and TAB, no format, separator or lone surrogate characters.
 */
export type SafeText = string & Brand.Brand<"SafeText">

/** Whether a text is SafeText. */
export const isSafeText = (text: string): text is SafeText => safeTextPattern.test(text)

/**
 * Source text made safe whatever its length: removes exactly the characters of the categories SafeText rejects, so
 * the result is SafeText by construction.
 */
export const stripUnsafeText = (text: string): SafeText =>
	Brand.nominal<SafeText>()(Str.replaceAll(unsafeCharacter, "")(text))

/** An absolute URI with ASCII characters only. */
export type DocumentUri = string & Brand.Brand<"DocumentUri">

/** Whether a text is a DocumentUri. */
export const isDocumentUri = (text: string): text is DocumentUri => uriPattern.test(text)

/** A text with at least one character, where the specification requires one. */
export type NonEmptyText = string & Brand.Brand<"NonEmptyText">

/** Whether a text is NonEmptyText. */
export const isNonEmptyText = (text: string): text is NonEmptyText => !Str.isEmpty(text)

/** The OpenAPI component-name pattern: the key grammar every Components Object map shares. */
export const componentNamePattern = regex("^[a-zA-Z0-9.\\-_]+$", "u")

/** Whether a text is a Components Object key: it matches the component-name pattern. */
export const isComponentName = (text: string): boolean => componentNamePattern.test(text)

/**
 * A DocumentUri the code writes as a literal, unchecked: the literal is the proof. Text from anywhere else goes through
 * isDocumentUri.
 */
export const fixedDocumentUri: (literal: string) => DocumentUri = Brand.nominal<DocumentUri>()
