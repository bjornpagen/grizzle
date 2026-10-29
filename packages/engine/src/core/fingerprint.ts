import {
	canonicalFormat,
	type EncodeOptions,
	encode,
	ownedText,
	withoutSourceLocs
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"

/**
 * Content fingerprints.
 *
 * A fingerprint is SHA-256 over the canonical text, domain-separated: the bytes hashed are
 * "<canonical format>\n<domain>\n<canonical text>", so a schema and a program with equal content never share a
 * fingerprint, and a change of serializer version changes every fingerprint.
 *
 * SHA-256 over the domain-separated canonical text, as 64 lowercase hex characters.
 */
export const digest = (
	domain: string,
	value: unknown,
	options: EncodeOptions
): Result.Result<string, CompileError> => {
	if (domain.length === 0 || domain.includes("\n")) {
		return Result.err(malformedArtifact("fingerprint", [], "a one-line fingerprint domain"))
	}
	return Result.map(encode(value, options), (text) =>
		sha256Hex(`${canonicalFormat}\n${domain}\n${text}`)
	)
}

/** The domains the compiler digests the values it owns under: one-line names, each a fingerprint domain. */
export type OwnedDomain = "empty-snapshot" | "regex-language"

/**
 * The digest of a value the compiler owns under a domain it names, which digests by construction (canonical.ts
 * ownedText): `digest`'s bytes, its domain one of the compiler's own.
 */
export const ownedDigest = (domain: OwnedDomain, value: unknown, options: EncodeOptions): string =>
	sha256Hex(`${canonicalFormat}\n${domain}\n${ownedText(value, options)}`)

/**
 * The fixed-shape entry points below hash content that carries SourceLocs under "loc" (the descs of ir/desc.ts). A
 * SourceLoc is presentation, excluded from semantic identity, so every one of them omits it.
 */
const identity = withoutSourceLocs

/** A schema's fingerprint: its canonical content. */
export const schemaFingerprint = (input: {
	readonly content: unknown
}): Result.Result<SchemaFingerprint, CompileError> =>
	Result.map(digest("schema", { content: input.content }, identity), SchemaFingerprint)
