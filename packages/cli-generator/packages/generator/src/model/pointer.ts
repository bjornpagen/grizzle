import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	JsonPointer,
	Option,
	Predicate,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"

/**
 * A JSON value.
 */
export type Json =
	| null
	| boolean
	| number
	| string
	| readonly Json[]
	| { readonly [key: string]: Json }

/**
 * The pointer or fragment text is not valid RFC 6901 syntax.
 */
export class PointerSyntaxError extends Schema.TaggedError<
	PointerSyntaxError,
	{ readonly brand: unique symbol }
>()("PointerSyntaxError", {
	pointer: Schema.String,
	reason: Schema.Literals([
		"missing-leading-slash",
		"invalid-escape",
		"invalid-percent-escape",
		"missing-hash"
	])
}) {}

/**
 * An object has no own member for a pointer token.
 */
export class PointerMemberNotFound extends Schema.TaggedError<
	PointerMemberNotFound,
	{ readonly brand: unique symbol }
>()("PointerMemberNotFound", { pointer: Schema.String, token: Schema.String }) {}

/**
 * An array index token is not a valid index into the array.
 */
export class PointerIndexOutOfRange extends Schema.TaggedError<
	PointerIndexOutOfRange,
	{ readonly brand: unique symbol }
>()("PointerIndexOutOfRange", { pointer: Schema.String, token: Schema.String }) {}

/**
 * A token tried to descend into a scalar.
 */
export class PointerNotContainer extends Schema.TaggedError<
	PointerNotContainer,
	{ readonly brand: unique symbol }
>()("PointerNotContainer", { pointer: Schema.String, token: Schema.String }) {}

export type PointerEvalError = PointerMemberNotFound | PointerIndexOutOfRange | PointerNotContainer

/**
 * Escapes one reference token (`~` to `~0`, `/` to `~1`).
 */
export const escapeToken = (token: string): string => JsonPointer.escapeToken(token)

/**
 * What `parsePointer` accepts: the empty pointer or `/`-led reference tokens, each token any
 * characters but `/` and `~`, or the escapes `~0` and `~1`.
 */
export const pointerPattern = regex("^(?:/(?:[^/~]|~[01])*)*$", "u")

/**
 * What `parsePointer` accepts, less the empty pointer.
 */
export const nonEmptyPointerPattern = regex("^(?:/(?:[^/~]|~[01])*)+$", "u")

const invalidEscape = regex("~(?![01])", "u")

/**
 * Unescapes one reference token; a `~` not followed by `0` or `1` fails.
 */
export const unescapeTokenResult = (token: string): Result.Result<string, PointerSyntaxError> =>
	invalidEscape.test(token)
		? Result.fail(PointerSyntaxError.make({ pointer: token, reason: "invalid-escape" }))
		: Result.succeed(JsonPointer.unescapeToken(token))

/**
 * Unescapes one reference token; a `~` not followed by `0` or `1` fails.
 */
export const unescapeToken = (token: string): Effect.Effect<string, PointerSyntaxError> =>
	Effect.suspend(() => Effect.fromResult(unescapeTokenResult(token)))

const tokensAfterSlash = (pointer: string): Result.Result<readonly string[], PointerSyntaxError> =>
	Result.mapError(
		Result.all(Arr.map(Str.split(Str.slice(1)(pointer), "/"), unescapeTokenResult)),
		() => PointerSyntaxError.make({ pointer, reason: "invalid-escape" })
	)

/**
 * Parses a pointer string into unescaped tokens.
 */
export const parsePointerResult = (
	pointer: string
): Result.Result<readonly string[], PointerSyntaxError> => {
	if (Str.isEmpty(pointer)) {
		return Result.succeed([])
	}

	return Str.startsWith("/")(pointer)
		? tokensAfterSlash(pointer)
		: Result.fail(PointerSyntaxError.make({ pointer, reason: "missing-leading-slash" }))
}

/**
 * Parses a pointer string into unescaped tokens.
 */
export const parsePointer = (
	pointer: string
): Effect.Effect<readonly string[], PointerSyntaxError> =>
	Effect.suspend(() => Effect.fromResult(parsePointerResult(pointer)))

/**
 * The pointer to member or index `token` of the node at `pointer`.
 */
export const childPointer = (pointer: string, token: string): string =>
	`${pointer}/${escapeToken(token)}`

/**
 * Whether `pointer` is `ancestor` or lies below it, by string prefix at a `/` boundary.
 */
export const isPointerWithin = (ancestor: string, pointer: string): boolean =>
	pointer === ancestor || Str.startsWith(`${ancestor}/`)(pointer)

/**
 * Formats tokens as a pointer string.
 */
export const formatPointer = (tokens: readonly string[]): string =>
	Arr.join(
		Arr.map(tokens, (token) => `/${escapeToken(token)}`),
		""
	)

/**
 * Parses a URI-fragment pointer (`#/a%25b`) into unescaped tokens.
 */
export const parseFragmentResult = (
	fragment: string
): Result.Result<readonly string[], PointerSyntaxError> => {
	if (!Str.startsWith("#")(fragment)) {
		return Result.fail(PointerSyntaxError.make({ pointer: fragment, reason: "missing-hash" }))
	}

	return Result.try({
		catch: () => PointerSyntaxError.make({ pointer: fragment, reason: "invalid-percent-escape" }),
		try: () => decodeURIComponent(Str.slice(1)(fragment))
	}).pipe(
		Result.flatMap((decoded) =>
			Result.mapError(parsePointerResult(decoded), (failure) =>
				PointerSyntaxError.make({ pointer: fragment, reason: failure.reason })
			)
		)
	)
}

/**
 * Parses a URI-fragment pointer (`#/a%25b`) into unescaped tokens.
 */
export const parseFragment = (
	fragment: string
): Effect.Effect<readonly string[], PointerSyntaxError> =>
	Effect.suspend(() => Effect.fromResult(parseFragmentResult(fragment)))

const arrayIndex = regex("^(?:0|[1-9][0-9]*)$", "u")

/**
 * The member `token` names in `current`, the node at `pointer`'s parent: an array item by its
 * canonical decimal index, an object's own member, and nothing inside a scalar.
 */
const stepResult = (
	current: Json,
	token: string,
	pointer: string
): Result.Result<Json, PointerEvalError> => {
	if (Arr.isArray<Json>(current)) {
		return Result.fromOption(
			arrayIndex.test(token) ? Arr.get(current, Number(token)) : Option.none(),
			() => PointerIndexOutOfRange.make({ pointer, token })
		)
	}

	return Predicate.isObject(current)
		? Result.fromOption(Record.get(current, token), () =>
				PointerMemberNotFound.make({ pointer, token })
			)
		: Result.fail(PointerNotContainer.make({ pointer, token }))
}

/**
 * Evaluates tokens against a JSON value through own members only.
 */
export const evaluateTokensResult = (
	value: Json,
	tokens: readonly string[]
): Result.Result<Json, PointerEvalError> =>
	Arr.reduce(
		tokens,
		Result.succeed<Json>(value),
		(reached: Result.Result<Json, PointerEvalError>, token, index) =>
			Result.flatMap(reached, (current) =>
				stepResult(current, token, formatPointer(Arr.take(tokens, index + 1)))
			)
	)

/**
 * Evaluates tokens against a JSON value through own members only.
 */
export const evaluateTokens = (
	value: Json,
	tokens: readonly string[]
): Effect.Effect<Json, PointerEvalError> =>
	Effect.suspend(() => Effect.fromResult(evaluateTokensResult(value, tokens)))

/**
 * Evaluates a pointer string against a JSON value.
 */
export const evaluatePointerResult = (
	value: Json,
	pointer: string
): Result.Result<Json, PointerSyntaxError | PointerEvalError> =>
	Result.flatMap(parsePointerResult(pointer), (tokens) => evaluateTokensResult(value, tokens))

/**
 * Evaluates a pointer string against a JSON value.
 */
export const evaluatePointer = (
	value: Json,
	pointer: string
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
	Effect.suspend(() => Effect.fromResult(evaluatePointerResult(value, pointer)))

/**
 * Evaluates a URI-fragment pointer against a JSON value.
 */
export const evaluateFragmentResult = (
	value: Json,
	fragment: string
): Result.Result<Json, PointerSyntaxError | PointerEvalError> =>
	Result.flatMap(parseFragmentResult(fragment), (tokens) => evaluateTokensResult(value, tokens))

/**
 * Evaluates a URI-fragment pointer against a JSON value.
 */
export const evaluateFragment = (
	value: Json,
	fragment: string
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
	Effect.suspend(() => Effect.fromResult(evaluateFragmentResult(value, fragment)))
