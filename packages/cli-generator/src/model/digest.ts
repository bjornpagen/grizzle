import { regex } from "arkregex"
import { Brand, Effect, Predicate } from "effect"
import { Digest } from "effect/crypto"

const encoder = new TextEncoder()

/** A SHA-256 digest as 64 lowercase hexadecimal digits: what `sha256Hex` answers. */
export type Sha256Hex = string & Brand.Brand<"Sha256Hex">

const sha256HexPattern = regex("^[0-9a-f]{64}$", "u")

/** Whether a text is a Sha256Hex: a digest read back from a file the generator wrote. */
export const isSha256Hex = (text: string): text is Sha256Hex => sha256HexPattern.test(text)

/** The digest's own hexadecimal text, which is a Sha256Hex by construction. */
const digestText = Brand.nominal<Sha256Hex>()

/**
 * The sha256 of `content` as 64 lowercase hex digits, through the `Digest` service. Text is hashed
 * as its UTF-8 bytes, so a lone surrogate counts as U+FFFD.
 */
export const sha256Hex = Effect.fnUntraced(function* sha256Hex(content: string | Uint8Array) {
	const digest = yield* Digest.Digest
	const bytes = Predicate.isString(content) ? encoder.encode(content) : content

	return yield* Effect.map(digest.digestHex(Digest.sha256, bytes), digestText)
})
