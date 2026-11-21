import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isWellFormedText, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import {
	arrayText,
	type CanonicalObject,
	canonicalFormat,
	canonicalOf,
	catchRefusal,
	type EncodeOptions,
	encode,
	encodeOver,
	unwrap,
	withoutSourceLocs,
	writeCanonical,
	writeCanonicalOver,
	writeOwned
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { messageChunk, Sha256Messages } from "#compiler/core/sha256.ts"
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
 * text's UTF-8 is the canonical writer's (core/canonical.ts writeCanonical), written after the frame into the message
 * and passed to the hash as it is written (framed), so no text of it is built.
 */
export const digest = (
	domain: string,
	value: unknown,
	options: EncodeOptions
): Result.Result<string, CompileError> => {
	if (domain.length === 0 || domain.includes("\n") || !isWellFormedText(domain)) {
		return Result.err(malformedArtifact("fingerprint", [], "a one-line fingerprint domain"))
	}
	const message = framed(domain)
	return Result.map(writeCanonical(message.out, value, options), () => message.hex())
}

declare const identityDigestBrand: unique symbol

/** A value's identity digest (`identityDigest`), 64 lowercase hex characters. */
export type IdentityDigest = string & { readonly [identityDigestBrand]: true }

const mintIdentityDigest = nominal<string, IdentityDigest>()

/**
 * A value's identity digest under `options`, built Merkle-style: SHA-256 of its canonical text (`encode`) in which each
 * array and plain record it holds is written as that container's own identity digest, a tagged string no plain string
 * writes as (canonical.ts escapes a plain string's leading "~"). Two values have one identity digest exactly when their
 * canonical texts are one, SHA-256 colliding aside, and each container is digested once however many times the value
 * holds it: a Description shares the queries it imports by reference, and its identity is linear in its distinct
 * parts, where its canonical text is the size of the tree that sharing expands into.
 */
export const identityDigest = (
	value: unknown,
	options: EncodeOptions
): Result.Result<IdentityDigest, CompileError> => new IdentityDigests(options).of(value)

/**
 * Identity digests under one EncodeOptions (`identityDigest`), each frozen container's token kept across every value
 * they digest, as one value's every container is within it: a container two values hold is digested once for both.
 * Owned by the caller whose values share parts, a ChangeSet's chain of members, each of which may import what an
 * earlier one does (write/changeset/value.ts), never by a module. A frozen container's token is its content's for as
 * long as it lives; one that is not frozen is digested anew in each value that holds it. Every container's text is
 * written into one writer, one after another, each finished before the next is begun (Sha256Messages).
 */
export class IdentityDigests {
	readonly #options: EncodeOptions
	/** Each frozen container's text as a member of another, its digest tagged, by the container. */
	readonly #tokens = new WeakMap<object, WellFormedText>()
	readonly #messages = new Sha256Messages(messageChunk)
	#digested = 0

	constructor(options: EncodeOptions) {
		this.#options = options
	}

	/** The identity digest of `value` (`identityDigest`); a refused value leaves no message half written. */
	of(value: unknown): Result.Result<IdentityDigest, CompileError> {
		const identity = catchRefusal(() => {
			/** Each open container's token within this value. */
			const open = new Map<object, WellFormedText>()
			const read = containerOf(value)
			if (read !== undefined) {
				return mintIdentityDigest(this.#containerDigest(read, open))
			}
			unwrap(writeCanonical(this.#messages.out, value, this.#options))
			return mintIdentityDigest(this.#messages.hex())
		})
		if (!identity.ok) {
			this.#messages.discard()
		}
		return identity
	}

	/** How many containers these digests have digested, each its text hashed once: their work. */
	get digested(): number {
		return this.#digested
	}

	/** A container's text as a member of another: its digest tagged, digested on its first read. */
	#tokenOf(read: Container, open: Map<object, WellFormedText>): WellFormedText {
		const container = read.kind === "array" ? read.items : read.record
		const tokens = Object.isFrozen(container) ? this.#tokens : open
		const known = tokens.get(container)
		if (known !== undefined) {
			return known
		}
		const token = wellFormed(`"~${identityTag}:${this.#containerDigest(read, open)}"`)
		this.#digested += 1
		tokens.set(container, token)
		return token
	}

	/**
	 * The digest of a container's own text: its scalars as `encode` writes them, its containers as their tokens, each
	 * container's digested before the text is begun, and each member refused in order where `encode` refuses it.
	 */
	#containerDigest(read: Container, open: Map<object, WellFormedText>): string {
		const out = this.#messages.out
		if (read.kind === "array") {
			const members = read.items.map((item): Member => {
				const at = containerOf(item)
				if (at !== undefined) {
					return { kind: "token", token: this.#tokenOf(at, open) }
				}
				refuseOutside(item, this.#options)
				return { kind: "scalar", item }
			})
			out.ascii("[")
			for (const [i, member] of members.entries()) {
				if (i > 0) {
					out.ascii(",")
				}
				if (member.kind === "token") {
					out.text(member.token)
				} else {
					unwrap(writeCanonical(out, member.item, this.#options))
				}
			}
			out.ascii("]")
			return this.#messages.hex()
		}
		const written = new Map<string, WellFormedText>()
		for (const key of Object.keys(read.record)) {
			const member = read.record[key]
			const at = containerOf(member)
			if (at !== undefined && !this.#options.omit(key, member, [])) {
				written.set(key, this.#tokenOf(at, open))
			}
		}
		unwrap(writeCanonicalOver(out, read.record, this.#options, written))
		return this.#messages.hex()
	}
}

/** An array's member as its container's identity text holds it: a container's token, or a scalar written as it is. */
type Member =
	| { readonly kind: "token"; readonly token: WellFormedText }
	| { readonly kind: "scalar"; readonly item: unknown }

/**
 * A value no container holds refused as `encode` refuses it, where it is outside the canonical model; any other is a
 * scalar of the model, which encodes.
 */
const refuseOutside = (value: unknown, options: EncodeOptions): void => {
	const read = canonicalOf(value)
	if (typeof read === "object" && read.kind === "outside") {
		unwrap(encode(value, options))
	}
}

/** A canonical object that is a container, an array or a plain record (identityDigest). */
type Container = Extract<CanonicalObject, { readonly kind: "array" | "record" }>

/** A value read as a container by the canonical model; undefined for a scalar and a value outside it. */
const containerOf = (value: unknown): Container | undefined => {
	const read = canonicalOf(value)
	return typeof read === "object" && (read.kind === "array" || read.kind === "record")
		? read
		: undefined
}

/** The tag of a container's identity digest in its container's text (`identityDigest`). */
const identityTag = "identity"

/** The first line of every digest's frame, the canonical format's, and the newline that ends a domain's. */
const formatLine = wellFormed(`${canonicalFormat}\n`)
const newline = wellFormed("\n")

/** A message framed by its domain (`digest`): its frame written, the canonical text to follow. */
const framed = (domain: WellFormedText): Sha256Messages => {
	const message = new Sha256Messages(messageChunk)
	message.out.text(formatLine)
	message.out.text(domain)
	message.out.text(newline)
	return message
}

/** SHA-256 of a canonical text framed by its domain (`digest`). */
const framedDigest = (domain: WellFormedText, text: WellFormedText): string => {
	const message = framed(domain)
	message.out.text(text)
	return message.hex()
}

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
 * code order, a library function's definition (physical/ddl/library.ts) and a row function's
 * (physical/ddl/row-functions.ts).
 */
export type ConstantDomain =
	| "closed-constant"
	| "roster-names"
	| "library-function"
	| "row-function"

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
export const ownedDigest = (
	domain: OwnedDomain,
	value: unknown,
	options: EncodeOptions
): string => {
	const message = framed(ownedDomains[domain])
	writeOwned(message.out, value, options)
	return message.hex()
}

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
	"library-function": wellFormed("library-function"),
	"row-function": wellFormed("row-function")
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
	let lengthFramed = ""
	for (const handle of handles) {
		lengthFramed += `${handle.length}:${handle}`
	}
	return nominal<string, RosterDigest>()(framedDigest(rosterDomain, wellFormed(lengthFramed)))
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
 * level's fingerprint hashes, and what the text of each level above it holds among its `bases`.
 */
export type LevelText = WellFormedText & { readonly [levelTextBrand]: true }

const mintLevelText = nominal<WellFormedText, LevelText>()

/** A schema level's canonical text and its fingerprint (schemaLevel). */
export interface SchemaLevel {
	readonly text: LevelText
	readonly fingerprint: SchemaFingerprint
}

/**
 * A schema level's canonical text and fingerprint, over the levels `bases` it extends, in its own order, none for the
 * root. The fingerprint is SHA-256 over the domain-separated canonical text of `{ content: level }`, without the
 * SourceLocs its descs carry under "loc" (ir/desc.ts), which are presentation, excluded from semantic identity. A level
 * holds its bases under `bases`, each base's text the one its own fingerprint hashed, so that member is written from
 * those texts (core/canonical.ts encodeOver, arrayText) and no base is ever encoded again.
 */
export const schemaLevel = (
	level: unknown,
	bases: ReadonlyArray<SchemaLevel>
): Result.Result<SchemaLevel, CompileError> =>
	Result.flatMap(
		encodeOver(level, withoutSourceLocs, new Map([["bases", arrayText(bases.map((b) => b.text))]])),
		(text) => {
			const message = framed(schemaDomain)
			return Result.map(
				writeCanonicalOver(
					message.out,
					{ content: level },
					withoutSourceLocs,
					new Map([["content", text]])
				),
				() => ({ text: mintLevelText(text), fingerprint: SchemaFingerprint(message.hex()) })
			)
		}
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
