import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	isWellFormedText,
	type Utf8Writer,
	type WellFormedText
} from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import {
	type CanonicalContainer,
	type ContainerTokens,
	canonicalFormat,
	canonicalOf,
	catchRefusal,
	type EncodeOptions,
	isCanonicalContainer,
	unwrap,
	writeCanonical,
	writeCanonicalCarrying,
	writeIdentityText,
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
): Result.Result<string, CompileError> =>
	Result.flatMap(fingerprintDomain(domain), (line) => {
		const message = framed(line)
		return Result.map(writeCanonical(message.out, value, options), () => message.hex())
	})

/**
 * `digest`'s digest of `value`, each frozen container `texts` holds written from its text rather than read again
 * (canonical.ts writeCanonicalCarrying): its bytes are `digest`'s exactly where each text is the container's `encode`
 * under `options`, which the caller who holds `texts` writes once for every value that holds the container.
 */
export const digestCarrying = (
	domain: string,
	value: unknown,
	options: EncodeOptions,
	texts: ReadonlyMap<object, WellFormedText>
): Result.Result<string, CompileError> =>
	Result.flatMap(fingerprintDomain(domain), (line) => {
		const message = framed(line)
		return Result.map(writeCanonicalCarrying(message.out, value, options, texts), () =>
			message.hex()
		)
	})

/** A fingerprint's domain, one line of well-formed text, or MalformedArtifact: the one check of a caller's domain. */
export const fingerprintDomain = (domain: string): Result.Result<WellFormedText, CompileError> =>
	domain.length === 0 || domain.includes("\n") || !isWellFormedText(domain)
		? Result.err(malformedArtifact("fingerprint", [], "a one-line fingerprint domain"))
		: Result.ok(domain)

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
): Result.Result<IdentityDigest, CompileError> => new IdentityDigests(options, []).of(value)

/**
 * Identity digests under one EncodeOptions (`identityDigest`), each frozen container's identity kept across every value
 * they digest, as one value's every container is within it: a container two values hold is digested once for both, and
 * a frozen value asked again, or a part of one asked as a value of its own, is its kept identity, never digested again.
 * A frozen container's identity is its content's for as long as it lives, so one set of digests serves every reader of
 * the values it keeps: Descriptions' are one for the process (ir/desc.ts descIdentities), which every ChangeSet's
 * members, every owned schema's levels and statements and every navigation read. One that is not frozen is digested
 * anew in each value that holds it. Every container's text is written into one writer, one after another, each
 * finished before the next is begun (Sha256Messages).
 */
export class IdentityDigests {
	readonly #options: EncodeOptions
	/**
	 * The digests whose kept identities these read before their own and never add to (`scoped`), each under these'
	 * options: none for digests of their own.
	 */
	readonly #outer: ReadonlyArray<IdentityDigests>
	/** Each frozen container's identity digest, its token's payload, by the container. */
	readonly #digests = new WeakMap<object, IdentityDigest>()
	readonly #messages = new Sha256Messages(messageChunk)
	#digested = 0

	constructor(options: EncodeOptions, outer: ReadonlyArray<IdentityDigests>) {
		this.#options = options
		this.#outer = outer
	}

	/**
	 * Digests under these' options that read every identity these keep and keep their own apart, so what they digest
	 * past these is held by them alone and goes with them: a compile's, over the process's (check/session.ts
	 * ResolvedImports), whose parts the process's digests read before it, a ChangeSet's members among them, it reads
	 * again for nothing, and whose own it adds to no table of the process's.
	 */
	scoped(): IdentityDigests {
		return new IdentityDigests(this.#options, [this, ...this.#outer])
	}

	/** The identity a frozen container holds in these digests or in one they read (`#outer`), none where none keeps one. */
	#kept(container: object): IdentityDigest | undefined {
		const own = this.#digests.get(container)
		if (own !== undefined) {
			return own
		}
		for (const outer of this.#outer) {
			const kept = outer.#digests.get(container)
			if (kept !== undefined) {
				return kept
			}
		}
		return undefined
	}

	/**
	 * The identity digest of `value` (`identityDigest`), a frozen container's the one these digests keep for it, taken
	 * once however often it is asked; a refused value leaves no message half written.
	 */
	of(value: unknown): Result.Result<IdentityDigest, CompileError> {
		const identity = catchRefusal(() => {
			const read = containerOf(value)
			if (read !== undefined) {
				const tokens = this.#within()
				const known = tokens.known(read)
				if (known !== undefined) {
					return known
				}
				writeIdentityText(this.#messages.out, read, this.#options, tokens, unframed)
				return tokens.written(read)
			}
			unwrap(writeCanonical(this.#messages.out, value, this.#options))
			return mintIdentityDigest(this.#messages.hex())
		})
		if (!identity.ok) {
			this.#messages.discard()
		}
		return identity
	}

	/**
	 * The digest of `value` framed by `line`, a fingerprint's domain (`digest`'s frame): SHA-256 of the frame, then
	 * `value`'s identity text, each container it holds written as its token, as `of` writes it.
	 */
	framed(line: WellFormedText, value: unknown): Result.Result<string, CompileError> {
		const hashed = catchRefusal(() => {
			const read = containerOf(value)
			if (read !== undefined) {
				writeIdentityText(this.#messages.out, read, this.#options, this.#within(), (out) =>
					writeFrame(out, line)
				)
				return this.#messages.hex()
			}
			writeFrame(this.#messages.out, line)
			unwrap(writeCanonical(this.#messages.out, value, this.#options))
			return this.#messages.hex()
		})
		if (!hashed.ok) {
			this.#messages.discard()
		}
		return hashed
	}

	/** How many containers these digests have digested, each its text hashed once: their work. */
	get digested(): number {
		return this.#digested
	}

	/** How many bytes these digests have hashed, every container's text and every frame: their work, as bytes. */
	get written(): number {
		return this.#messages.out.length
	}

	/**
	 * The tokens of one value's containers: each a container's identity digest, a frozen one's kept across every value
	 * these digests read, one that is not frozen within this value alone; a container's taken from its identity text,
	 * just written whole into the message (canonical.ts writeIdentityText), on its first read.
	 */
	#within(): ContainerTokens<IdentityDigest> {
		const open = new Map<object, IdentityDigest>()
		const held = (read: CanonicalContainer): object =>
			read.kind === "array" ? read.items : read.record
		const tableOf = (container: object) => (Object.isFrozen(container) ? this.#digests : open)
		return {
			known: (read) => {
				const container = held(read)
				return Object.isFrozen(container) ? this.#kept(container) : open.get(container)
			},
			written: (read) => {
				const container = held(read)
				const identity = mintIdentityDigest(this.#messages.hex())
				this.#digested += 1
				tableOf(container).set(container, identity)
				return identity
			},
			write: writeToken
		}
	}
}

/** What a message holds before a container's own identity text where no frame is: nothing. */
const unframed = (_out: Utf8Writer): void => undefined

/**
 * A container's text as a member of another's identity text, its token: the JSON literal of its identity digest tagged
 * (`identityDigest`), "~identity:<digest>", each piece ASCII, written as it is with no string built of it.
 */
const writeToken = (out: Utf8Writer, identity: IdentityDigest): void => {
	out.ascii(tokenOpen)
	out.ascii(identity)
	out.ascii(tokenClose)
}

/** The tag of a container's identity digest in its container's text (`identityDigest`). */
const identityTag = "identity"

/** What a token holds before its digest, its opening quote and its tag (`writeToken`), and after it, its closing quote. */
const tokenOpen = `"~${identityTag}:`
const tokenClose = '"'

/** A value read as a container by the canonical model; undefined for a scalar and a value outside it. */
const containerOf = (value: unknown): CanonicalContainer | undefined => {
	const read = canonicalOf(value)
	return isCanonicalContainer(read) ? read : undefined
}

/** The first line of every digest's frame, the canonical format's, and the newline that ends a domain's. */
const formatLine = wellFormed(`${canonicalFormat}\n`)
const newline = wellFormed("\n")

/** A message framed by its domain (`digest`): its frame written, the canonical text to follow. */
const framed = (domain: WellFormedText): Sha256Messages => {
	const message = new Sha256Messages(messageChunk)
	writeFrame(message.out, domain)
	return message
}

/** A digest's frame written into `out`: the canonical format's line and its domain's (`digest`). */
export const writeFrame = (out: Utf8Writer, domain: WellFormedText): void => {
	out.text(formatLine)
	out.text(domain)
	out.text(newline)
}

/** SHA-256 of a canonical text framed by its domain (`digest`). */
const framedDigest = (domain: WellFormedText, text: WellFormedText): string => {
	const message = framed(domain)
	message.out.text(text)
	return message.hex()
}

/**
 * The domains the compiler digests the values it owns under: one-line names, each a fingerprint domain. A constant's
 * domain digests the content its function is named by (ConstantDomain); `read-back-lowering`, what decides a read-back's
 * lowering, the key its program is kept under (write/readback/lower.ts readBackKey).
 */
export type OwnedDomain =
	| "empty-snapshot"
	| "regex-language"
	| "domain-definition"
	| "drift-proof"
	| "row-type-definition"
	| "function-definition"
	| "read-back-lowering"
	| ConstantDomain

/**
 * The domains of an installed constant's content: a closed relation's or side's string of cells, a roster's names in
 * code order, a roster's live codes (ir/codes.ts liveHex), a library function's definition (physical/ddl/library.ts)
 * and a row function's (physical/ddl/row-functions.ts).
 */
export type ConstantDomain =
	| "closed-constant"
	| "roster-names"
	| "roster-live"
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
	"read-back-lowering": wellFormed("read-back-lowering"),
	"closed-constant": wellFormed("closed-constant"),
	"roster-names": wellFormed("roster-names"),
	"roster-live": wellFormed("roster-live"),
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

/**
 * A schema level's fingerprint: SHA-256 over the domain-separated identity text of `{ content: level }` without the
 * SourceLocs its descs carry under "loc" (ir/desc.ts), which are presentation, excluded from semantic identity. The text
 * is built Merkle-style (IdentityDigests): every array and record the level holds, its bases among them, written as its
 * own identity digest's token, so a query its relations read by many paths is digested once, and the levels of one
 * owned schema, read by the Descriptions' one IdentityDigests (ir/desc.ts descIdentities), digest each part they share
 * once (schema/own.ts hashedLevels): a level's text is linear in its distinct parts, where its canonical text, a union
 * chain's, doubles with each level.
 */
export const schemaFingerprint = (
	identities: IdentityDigests,
	level: unknown
): Result.Result<SchemaFingerprint, CompileError> =>
	Result.map(identities.framed(schemaDomain, { content: level }), SchemaFingerprint)

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
