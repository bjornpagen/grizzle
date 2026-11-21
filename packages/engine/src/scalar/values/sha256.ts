import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isWellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import { digestHex, isDigestHex } from "#compiler/core/digest.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { sha256Digest } from "#compiler/core/sha256.ts"
import { sameBytes } from "#compiler/scalar/values/bytes.ts"

declare const sha256Brand: unique symbol

/**
 * A SHA-256 digest as the host holds it: its 32 bytes (core/digest.ts sha256Octets), a Uint8Array over a buffer of its
 * own, the sha256 carrier's host type (ir/scalar.ts DigestType). It is minted by the digest of a message
 * (`Sha256.ofBytes`, `Sha256.ofText`), as Crypto.sha256 computes it in PostgreSQL, by a read of a digest column, whose
 * column states it (scalar/sha256.ts), and by its hex (`Sha256.fromHex`), the one door a digest enters by from a text
 * something rendered it to as an outside name (`Sha256.toHex`), a queue message's key among them; the brand says which
 * bytes are a digest, so a digest is never written where other bytes belong. Every value grizzle hands back is a fresh
 * array, which its caller may keep or change; a digest a caller passes in is copied at its admission (core/digest.ts
 * toSha256, scalar/values/identity.ts).
 *
 * A digest is an array, so `===`, `!==`, a Set's member, a Map's key and a dedupe by identity compare which array holds
 * it, never its bytes: two reads of one digest are two arrays, each unequal to the other, and code comparing them so
 * fails silently. Two digests are compared by `Sha256.equals` alone, and a digest keys a Map or a Set by its hex
 * (`Sha256.toHex`). No lint can hold this: the toolchain's own lint rules see syntax alone (oxlint's JS plugins), and its
 * type-aware rules are the fixed set its type checker's lint runs, so no rule tells a Sha256 operand of `===` from
 * another.
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

/**
 * A digest's hex: two lowercase hex digits a byte, 64 in all, as PostgreSQL's `encode(<digest>, 'hex')` spells it
 * (core/digest.ts digestHex): the digest's text where something renders it as an outside name, which fromHex reads back.
 */
const toHex = (digest: Sha256): string => digestHex(digest)

/**
 * The digest a hex spells, the inverse of toHex: a text of exactly a lowercase hex digit pair for each of a digest's
 * bytes, read into a fresh array of them; or sha256Syntax for any other text, an uppercase digit, another length or a
 * character no hex digit, so each digest has one hex and each hex one digest.
 */
const fromHex = (text: string): Result.Result<Sha256, ValueFault> =>
	isDigestHex(text) ? Result.ok(mintSha256(Uint8Array.fromHex(text))) : Result.err("sha256Syntax")

/**
 * Whether two digests are one: the same bytes, as the digest domain's equality (bytea's) says. It is the one comparison of
 * two digests, never `===`, which compares arrays (Sha256); it is an Equivalence of Effect over Sha256 as it stands, so
 * `Array.dedupeWith(xs, (a, b) => Sha256.equals(a.digest, b.digest))` and `Equivalence.mapInput` take it.
 */
const equals = (a: Sha256, b: Sha256): boolean => sameBytes(a, b)

/**
 * The digest operations, beside the Sha256 type of the same name: the digest of bytes, and of a text's UTF-8; a digest's
 * hex, and the digest a hex spells; and whether two digests are one.
 */
export const Sha256 = Object.freeze({ ofBytes, ofText, toHex, fromHex, equals })
