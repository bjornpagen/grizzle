import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isWellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { sha256Digest } from "#compiler/core/sha256.ts"

declare const sha256Brand: unique symbol

/**
 * A SHA-256 digest as the host holds it: its 32 bytes (core/digest.ts sha256Octets), a Uint8Array over a buffer of its
 * own, the sha256 carrier's host type (ir/scalar.ts DigestType). It is minted by the digest of a message
 * (`Sha256.ofBytes`, `Sha256.ofText`), as Crypto.sha256 computes it in PostgreSQL, and by a read of a digest column,
 * whose column states it (scalar/sha256.ts); the brand says which bytes are a digest, so a digest is never written
 * where other bytes belong. Every value grizzle hands back is a fresh array, which its caller may keep or change; a
 * digest a caller passes in is copied at its admission (core/digest.ts toSha256, scalar/values/identity.ts).
 */
export type Sha256 = Uint8Array<ArrayBuffer> & { readonly [sha256Brand]: true }

/** A message's digest as the Sha256 it is. */
const mintSha256 = nominal<Uint8Array<ArrayBuffer>, Sha256>()

/** The digest of `bytes`: their SHA-256, as PostgreSQL's `sha256(bytes)` and Crypto.sha256 of bytes compute it. */
const ofBytes = (bytes: Uint8Array): Sha256 => mintSha256(sha256Digest(bytes))

/**
 * The digest of a text: the SHA-256 of its UTF-8, as Crypto.sha256 of a text computes it in PostgreSQL; or textSurrogate
 * for a text with an unpaired surrogate, which no PostgreSQL text holds, so no column's digest is its digest.
 */
const ofText = (text: string): Result.Result<Sha256, ValueFault> =>
	isWellFormedText(text) ? Result.ok(mintSha256(sha256Digest(text))) : Result.err("textSurrogate")

/** The digest operations, beside the Sha256 type of the same name: the digest of bytes, and of a text's UTF-8. */
export const Sha256 = Object.freeze({ ofBytes, ofText })
