import { nominal } from "#compiler/core/brand.ts"
import {
	canonicalFormat,
	type EncodeOptions,
	encode,
	encodeOver,
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

/**
 * The domains the compiler digests the values it owns under: one-line names, each a fingerprint domain. A constant's
 * domain digests the content its function is named by (ConstantDomain).
 */
export type OwnedDomain = "empty-snapshot" | "regex-language" | "domain-definition" | ConstantDomain

/**
 * The domains of an installed constant's content: a closed relation's or side's string of cells, and a roster's names
 * in code order.
 */
export type ConstantDomain = "closed-constant" | "roster-names"

declare const constantDigestBrand: unique symbol

/**
 * The digest of a constant's content under its domain, minted only by constantDigest: what the naming door names the
 * constant's function by (core/identity.ts), so equal contents share one function and changed contents are a new one.
 */
export type ConstantDigest<D extends ConstantDomain = ConstantDomain> = string & {
	readonly [constantDigestBrand]: D
}

/**
 * The digest of a value the compiler owns under a domain it names, which digests by construction (canonical.ts
 * ownedText): `digest`'s bytes, its domain one of the compiler's own.
 */
export const ownedDigest = (domain: OwnedDomain, value: unknown, options: EncodeOptions): string =>
	sha256Hex(`${canonicalFormat}\n${domain}\n${ownedText(value, options)}`)

declare const rosterDigestBrand: unique symbol

/**
 * The digest of a roster's handles in order, minted only by rosterDigest: what a roster's canonical form carries beside
 * its name (ir/scalar.ts Roster), so two rosters of one name with other handles, or with its handles in another order,
 * never share an identity, and the form holds the same characters whatever the roster's size.
 */
export type RosterDigest = string & { readonly [rosterDigestBrand]: true }

/**
 * SHA-256 over the domain-separated text of a roster's handles in order, each written as its length in UTF-16 code
 * units, a colon, and the handle, so one text frames exactly one list of handles. The canonical encoder would frame
 * them too, at three times the cost of this one pass over each handle's characters.
 */
export const rosterDigest = (handles: ReadonlyArray<string>): RosterDigest => {
	let framed = ""
	for (const handle of handles) {
		framed += `${handle.length}:${handle}`
	}
	return nominal<string, RosterDigest>()(sha256Hex(`${canonicalFormat}\nroster-handles\n${framed}`))
}

declare const domainDigestBrand: unique symbol

/**
 * The digest of a domain's physical definition, its base type and its checks, minted only by domainDigest: what the
 * naming door names a contract's or a text refinement's domain by (core/identity.ts), so two contracts, or two
 * refinements, of one definition share one domain, and nominal distinctness stays the contract's type-level brand.
 */
export type DomainDigest = string & { readonly [domainDigestBrand]: true }

/** The digest of a domain's physical definition: ownedDigest's under "domain-definition", branded. */
export const domainDigest = (definition: unknown, options: EncodeOptions): DomainDigest =>
	nominal<string, DomainDigest>()(ownedDigest("domain-definition", definition, options))

/** The digest of a constant's content under its domain: ownedDigest's, branded by the domain. */
export const constantDigest = <D extends ConstantDomain>(
	domain: D,
	value: unknown,
	options: EncodeOptions
): ConstantDigest<D> => nominal<string, ConstantDigest<D>>()(ownedDigest(domain, value, options))

declare const levelTextBrand: unique symbol

/**
 * The canonical text of one level of a schema description, without its SourceLocs, minted only by schemaLevel: what the
 * level's fingerprint hashes, and what the text of the level above holds as its `extends` member.
 */
export type LevelText = string & { readonly [levelTextBrand]: true }

const mintLevelText = nominal<string, LevelText>()

/** A schema level's canonical text and its fingerprint (schemaLevel). */
export interface SchemaLevel {
	readonly text: LevelText
	readonly fingerprint: SchemaFingerprint
}

/**
 * A schema level's canonical text and fingerprint, over the level `below` it, none for the root. The fingerprint is
 * SHA-256 over the domain-separated canonical text of `{ content: level }`, without the SourceLocs its descs carry under
 * "loc" (ir/desc.ts), which are presentation, excluded from semantic identity. A level above the root holds the level
 * below under `extends`, whose text the level below's fingerprint hashed, so that member is written from that text
 * (core/canonical.ts encodeOver) and the level below is never encoded again.
 */
export const schemaLevel = (
	level: unknown,
	below: SchemaLevel | undefined
): Result.Result<SchemaLevel, CompileError> =>
	Result.flatMap(
		below === undefined
			? encode(level, withoutSourceLocs)
			: encodeOver(level, withoutSourceLocs, new Map([["extends", below.text]])),
		(text) =>
			Result.map(
				encodeOver({ content: level }, withoutSourceLocs, new Map([["content", text]])),
				(content) => ({
					text: mintLevelText(text),
					fingerprint: SchemaFingerprint(sha256Hex(`${canonicalFormat}\nschema\n${content}`))
				})
			)
	)
