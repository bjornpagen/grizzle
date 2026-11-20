import { regex } from "arkregex"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { Schema } from "effect"
import { diagnosticOf } from "#model/diagnostic.ts"
import { foldJson } from "#model/json-tree.ts"
import type { JsonFold } from "#model/json-tree.ts"
import { formatPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"
import type { Refusal, Where } from "#validate/disagreements.ts"

/**
 * A high surrogate not followed by a low one, or a low surrogate not preceded by a high one.
 */
const loneSurrogate = regex(
	"[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
	"u"
)

/**
 * The uppercase hexadecimal digits of a one-code-point string.
 */
const hexOf = (codePoint: string): string =>
	Str.toUpperCase(Option.getOrElse(Str.codePointAt(0)(codePoint), () => 0).toString(16))

/**
 * One code point as a pointer shows it: a lone surrogate as `\uXXXX`, anything else as itself.
 */
const printableCodePoint = (codePoint: string): string =>
	loneSurrogate.test(codePoint) ? `\\u${Str.padStart(4, "0")(hexOf(codePoint))}` : codePoint

const printable = (text: string): string =>
	Arr.join(Arr.map(Arr.fromIterable(text), printableCodePoint), "")

const pointerOf = (tokens: readonly string[]): string => formatPointer(Arr.map(tokens, printable))

const sites: JsonFold<readonly string[]> = {
	array: (items) => Arr.flatten(items),
	leaf: () => [],
	object: (members, tokens) =>
		Arr.flatMap(members, ({ folded, key }) => [
			...(loneSurrogate.test(key) ? [pointerOf([...tokens, key])] : []),
			...folded
		])
}

/**
 * The pointers of every property name in a document that holds a lone surrogate, in document
 * order, with the surrogate shown as `\uXXXX`. The validator library percent-encodes names, which
 * throws on one.
 */
export const surrogateSites = (document: Json): readonly string[] => foldJson(document, sites, [])

/**
 * A document refusal for one property name that is not well-formed Unicode.
 */
export const surrogateRefusal = (
	where: Where,
	pointer: string
): Effect.Effect<Refusal, Schema.SchemaError> =>
	diagnosticOf({
		code: "DOC-14/invalid-encoding",
		document: where.document,
		element: "document",
		message: `A property name at ${pointer} holds a lone UTF-16 surrogate, which is not valid Unicode text.`,
		openapi: where.openapi,
		pointer,
		scope: "document",
		severity: "refusal",
		specSection: "https://spec.openapis.org/oas/v3.1.2.html#format"
	}).pipe(Effect.map((diagnostic) => ({ context: [], diagnostic, keywordLocation: "" })))
