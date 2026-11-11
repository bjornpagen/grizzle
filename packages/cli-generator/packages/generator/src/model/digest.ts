import { Effect, Predicate } from "effect"
import { Digest } from "effect/crypto"

const encoder = new TextEncoder()

/**
 * The sha256 of `content` as 64 lowercase hex digits, through the `Digest` service. Text is hashed
 * as its UTF-8 bytes, so a lone surrogate counts as U+FFFD.
 */
export const sha256Hex = Effect.fnUntraced(function* sha256Hex(content: string | Uint8Array) {
	const digest = yield* Digest.Digest
	const bytes = Predicate.isString(content) ? encoder.encode(content) : content

	return yield* digest.digestHex(Digest.sha256, bytes)
})
