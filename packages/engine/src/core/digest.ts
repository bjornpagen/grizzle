import * as Result from "@bjornpagen/grizzle-text/base/result"
import { regex } from "arkregex"
import type { ValueFault } from "#compiler/core/errors.ts"

/**
 * A SHA-256 digest's length and its one text, browser-safe: core/sha256.ts computes digests with node:crypto, and every
 * module that only holds, spells or checks one (the served wire, the decoder, a literal) reads them here.
 */

/**
 * The bytes of a SHA-256 digest: FIPS 180-4's message digest of 256 bits, the sha256 carrier's one length, which its
 * domain's CHECK, its host value and every key entry over it read.
 *
 * @formatConstant FIPS 180-4 SHA-256: a 256-bit message digest, 32 bytes
 */
export const sha256Octets = 32

/** What begins a digest's one text: byteain's hex input, `\\x` (PostgreSQL's bytea hex format). */
const hexInput = "\\x"

/**
 * A digest's hex: two lowercase hex digits a byte, as PostgreSQL's `encode(<digest>, 'hex')` and core/sha256.ts
 * sha256Hex spell one, which no other digest shares: the digest's text where something renders it as an outside
 * name, a queue message's key among them (scalar/values/sha256.ts Sha256.toHex, read back by Sha256.fromHex), and the
 * digits of its one text (`sha256Text`).
 */
export const digestHex = (digest: Uint8Array): string => digest.toHex()

/**
 * A digest's one text: `\\x` and its hex (`digestHex`), byteain's hex input, which PostgreSQL reads into the digest's
 * bytes and which no other digest shares: its parameter text, its array element, its fact identity and its literal's
 * value.
 */
export const sha256Text = (digest: Uint8Array): string => `${hexInput}${digestHex(digest)}`

/** The bytes a digest's one text (`sha256Text`) spells, in a fresh array: the inverse of sha256Text. */
export const sha256FromText = (text: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.fromHex(text.slice(hexInput.length))

/** Lowercase hex digits, the digits digestHex writes. */
const lowerHex = regex("^[0-9a-f]*$", "u")

/** The length of every digest's hex (`digestHex`): two digits a byte. */
const digestHexLength = digestHex(new Uint8Array(sha256Octets)).length

/**
 * Whether `text` is a digest's hex (`digestHex`): a lowercase hex digit pair for each of its bytes, and nothing else, so
 * no uppercase digit, no other length and no character but a hex digit.
 */
export const isDigestHex = (text: string): boolean =>
	text.length === digestHexLength && lowerHex.test(text)

/** Whether `text` is a digest's one text (`sha256Text`): `\\x` and a digest's hex. */
export const isSha256Text = (text: string): boolean =>
	text.startsWith(hexInput) && isDigestHex(text.slice(hexInput.length))

/**
 * The admission of a digest a caller passes in: a Uint8Array of exactly sha256Octets bytes, or sha256Value, so a value
 * of another length, which the digest domain's CHECK would refuse, is refused at the door before any statement is sent.
 * A detached buffer's array has no bytes, so it is refused too. The value is the caller's array itself, which its
 * admitting carrier copies (scalar/values/identity.ts).
 */
export const toSha256 = (value: unknown): Result.Result<Uint8Array, ValueFault> =>
	value instanceof Uint8Array && value.length === sha256Octets
		? Result.ok(value)
		: Result.err("sha256Value")
