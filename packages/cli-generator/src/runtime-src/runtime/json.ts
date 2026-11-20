import { Data, Result } from "effect"
import type { Schema } from "effect"

/**
 * Text that is not one JSON text (RFC 8259), as JSON.parse refuses it, or text whose reviver
 * threw. It carries nothing of the text, which may hold a secret, nor JSON.parse's message, which
 * quotes the text.
 */
export class InvalidJsonText extends Data.TaggedError("InvalidJsonText") {}

/**
 * A JSON.parse reviver (ECMAScript's JSON.parse source text access): each value with its key,
 * innermost first, and for a primitive the source text it was read from.
 */
export type JsonReviver = (
	key: string,
	value: unknown,
	context: { readonly source?: string }
) => unknown

/**
 * One JSON text's value, `unknown` until its caller narrows it with a reader of its own, or
 * `InvalidJsonText`. This module is the one door to JSON text, for the generated runtime and the
 * generator alike, and the only module the root tsconfig lets call JSON.parse and JSON.stringify
 * (Effect's globalJson diagnostics are off here alone): Effect's only other reader of JSON text is
 * Schema, which grizzle's standard never runs.
 */
export const parseJson = (text: string): Result.Result<unknown, InvalidJsonText> =>
	Result.try({ try: (): unknown => JSON.parse(text), catch: () => new InvalidJsonText() })

/**
 * One JSON text's value as `reviver` rebuilds it, or `InvalidJsonText`, which a reviver that
 * throws also answers.
 */
export const parseRevivedJson = (
	text: string,
	reviver: JsonReviver
): Result.Result<unknown, InvalidJsonText> =>
	Result.try({
		try: (): unknown => JSON.parse(text, reviver),
		catch: () => new InvalidJsonText()
	})

/**
 * Whether text is one JSON text, which JSON.parse judges; the value it builds is dropped.
 */
export const isJsonText = (text: string): boolean => Result.isSuccess(parseJson(text))

/**
 * A JSON value's text, JSON.stringify's: no whitespace between its tokens.
 */
export const jsonText = (value: Schema.Json): string => JSON.stringify(value)

/**
 * A JSON value's text indented by two spaces, a member or an item a line, as a document a person
 * reads is printed (`--describe`).
 */
export const indentedJsonText = (value: Schema.Json): string => JSON.stringify(value, undefined, 2)
