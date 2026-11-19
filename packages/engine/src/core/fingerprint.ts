import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	isWellFormedText,
	joinWellFormed,
	type WellFormedText
} from "@bjornpagen/grizzle-text/utf8"
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
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"

/**
 * Content fingerprints.
 *
 * A fingerprint is SHA-256 over the canonical text, domain-separated: the bytes hashed are
 * "<canonical format>\n<domain>\n<canonical text>", so a schema and a program with equal content never share a
 * fingerprint, and a change of serializer version changes every fingerprint.
 *
 * SHA-256 over the domain-separated canonical text, as 64 lowercase hex characters. The frame's lines are proved
 * well-formed once, as the module loads (core/text.ts wellFormed), a caller's domain where it is read, and the canonical
 * text is the canonical writer's (core/canonical.ts), so the hashed text is joined of well-formed texts and never
 * checked whole.
 */
export const digest = (
	domain: string,
	value: unknown,
	options: EncodeOptions
): Result.Result<string, CompileError> => {
	if (domain.length === 0 || domain.includes("\n") || !isWellFormedText(domain)) {
		return Result.err(malformedArtifact("fingerprint", [], "a one-line fingerprint domain"))
	}
	return Result.map(encode(value, options), (text) => framedDigest(domain, text))
}

/** The first line of every digest's frame, the canonical format's, and the newline that ends a domain's. */
const formatLine = wellFormed(`${canonicalFormat}\n`)
const newline = wellFormed("\n")

/** SHA-256 of a canonical text framed by its domain (`digest`). */
const framedDigest = (domain: WellFormedText, text: WellFormedText): string =>
	sha256Hex(joinWellFormed(formatLine, domain, newline, text))

/**
 * The domains the compiler digests the values it owns under: one-line names, each a fingerprint domain. A constant's
 * domain digests the content its function is named by (ConstantDomain).
 */
export type OwnedDomain =
	| "empty-snapshot"
	| "regex-language"
	| "domain-definition"
	| "drift-proof"
	| "row-type-definition"
	| "function-definition"
	| ConstantDomain

/**
 * The domains of an installed constant's content: a closed relation's or side's string of cells, a roster's names in
 * code order, and a library function's definition (physical/ddl/library.ts).
 */
export type ConstantDomain = "closed-constant" | "roster-names" | "library-function"

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
	framedDigest(ownedDomains[domain], ownedText(value, options))

/** Each owned domain's text, proved well-formed once, as the module loads: TypeScript holds a domain as a literal. */
const ownedDomains: { readonly [D in OwnedDomain]: WellFormedText } = {
	"empty-snapshot": wellFormed("empty-snapshot"),
	"regex-language": wellFormed("regex-language"),
	"domain-definition": wellFormed("domain-definition"),
	"drift-proof": wellFormed("drift-proof"),
	"row-type-definition": wellFormed("row-type-definition"),
	"function-definition": wellFormed("function-definition"),
	"closed-constant": wellFormed("closed-constant"),
	"roster-names": wellFormed("roster-names"),
	"library-function": wellFormed("library-function")
}

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
	return nominal<string, RosterDigest>()(framedDigest(rosterDomain, wellFormed(framed)))
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
export type LevelText = WellFormedText & { readonly [levelTextBrand]: true }

const mintLevelText = nominal<WellFormedText, LevelText>()

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
					fingerprint: SchemaFingerprint(framedDigest(schemaDomain, content))
				})
			)
	)

/** A schema level's digest domain and a roster's handles', proved well-formed once, as the module loads. */
const schemaDomain = wellFormed("schema")
const rosterDomain = wellFormed("roster-handles")

declare const rowTypeDigestBrand: unique symbol

/**
 * The digest of a row type's physical definition, its attributes' names, types and collations in order, minted only by
 * rowTypeDigest: what the naming door names a declared function's row type by (core/identity.ts identity.rowType), so
 * two headings of one definition share one type and a changed heading is another.
 */
export type RowTypeDigest = string & { readonly [rowTypeDigestBrand]: true }

/** The digest of a row type's physical definition: ownedDigest's under "row-type-definition", branded. */
export const rowTypeDigest = (definition: unknown, options: EncodeOptions): RowTypeDigest =>
	nominal<string, RowTypeDigest>()(ownedDigest("row-type-definition", definition, options))

declare const functionDigestBrand: unique symbol

/**
 * The digest of a declared function's Description, its name, calls, signature, volatility, language and body, minted
 * only by functionDigest: what a call of it carries (ir/rel.ts CalledFunction), so a call's meaning, and the identity of
 * every law and program that reads it, changes with any part of the function, its body included.
 */
export type FunctionDigest = string & { readonly [functionDigestBrand]: true }

const mintFunctionDigest = nominal<string, FunctionDigest>()

/** The digest of a declared function's Description: ownedDigest's under "function-definition", branded. */
export const functionDigest = (definition: unknown, options: EncodeOptions): FunctionDigest =>
	mintFunctionDigest(ownedDigest("function-definition", definition, options))

/** A function digest an outside form reads back (ir/scalar-shape.ts calledFunctionShape), unchecked as every brand is. */
export const admittedFunctionDigest = (text: string): FunctionDigest => mintFunctionDigest(text)
