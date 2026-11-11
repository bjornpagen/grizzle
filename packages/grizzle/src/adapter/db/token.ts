import { Array as Arr, Brand, Result } from "effect"
import { TokenMalformed } from "#adapter/errors/failures.ts"

/**
 * A token as every door reads it: token68 text (RFC 7235 section 2.1, the b64token of RFC 6750 section 2.1), which a
 * JWT is, parsed once where it enters (parseToken), at Db.open's options and at an HTTP call's Authorization header
 * alike, so in process and over HTTP the same tokens are accepted, and each reaches the layer's verify as it was given.
 * Only parseToken makes one.
 */
export type Token = string & Brand.Brand<"Token">

const token = Brand.nominal<Token>()

/** The characters of a token68 before its padding: letters, digits, and - . _ ~ + /. */
const token68: ReadonlySet<string> = new Set(
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/"
)

/** `text` as a Token: one or more token68 characters, then any number of `=`; any other text is TokenMalformed. */
export const parseToken = (text: string): Result.Result<Token, TokenMalformed> => {
	const units = Arr.fromIterable(text)
	const body = Arr.takeWhile(units, (c) => token68.has(c))
	return body.length > 0 && Arr.every(Arr.drop(units, body.length), (c) => c === "=")
		? Result.succeed(token(text))
		: Result.fail(new TokenMalformed())
}
