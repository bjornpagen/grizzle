import { nominal } from "#compiler/core/brand.ts"
import { CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { ConstantDigest, DomainDigest } from "#compiler/core/fingerprint.ts"
import type { Identifier, IdentityKind } from "#compiler/core/ids.ts"
import { derived, type Limit, namedatalen } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Comparator, compareStrings, type Direction } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex, utf8Length } from "#compiler/core/sha256.ts"

/**
 * The naming door: every PostgreSQL identifier grizzle installs, declared or derived, is minted here from the object's
 * structured identity, its kind and the parts that define it, and nowhere else.
 *
 * Each kind renders by one rule: readable exactly when its identity maps one-to-one into PostgreSQL's
 * maxIdentifierBytes inside the namespace PostgreSQL puts the object in, otherwise hashed, and a name never changes form for its
 * length or a collision.
 *
 * - Readable: a declared name's conversion (its segments, lowercased, joined by single underscores: the schema, tables,
 *   derived relations, rosters' domains, columns, row checks and a role's views), a closed id's decoded
 *   column `<field>_name` beside it in a role's view, a login's or role's
 *   `<schema>__<name>` (a role's schema and policies take its role's), or a name grizzle fixes (`check` for a domain's
 *   CHECK, the per-schema singletons `__ledger` with its key and checks, `__refuse`, `__require_serializable` and
 *   `__snapshot_guard`, the per-table trigger `__isolation`). The declaration rules make each one-to-one in its
 *   namespace: declared names are compared by their conversions (`DeclaredNamespace`, every namespace of declared
 *   names: the schema's relations, rosters and contracts, each relation's or view's columns, each table's row checks,
 *   each role's views), none starts with `_`, and one whose conversion is over maxIdentifierBytes is refused; a schema's
 *   conversion does not start with `pg_`. A readable constructor takes the name parsed (`DeclaredName`, minted by
 *   `parseDeclaredName`; `SchemaName`, by `parseSchemaName`), so no readable identity has a name the rule refuses; a
 *   login's or role's name is refused when it does not fit with its schema's (physical/ddl/names.ts).
 * - Hashed: `__`, a readable stem cut to `stemBudget` bytes at a segment boundary, `_` and a digest of the identity's
 *   canonical encoding, the first `5 * digestChars` bits of its SHA-256 as `digestChars` characters of lowercase RFC
 *   4648 base32: keys, foreign keys, span, norm and law checks, indexes and statistics, sequences, contract and
 *   text-pattern domains, named by their definitions, constants, sets' domains, law and arm tag columns, laws and their functions and triggers, filter functions, key and unique probes
 *   and advance functions, and a migration's temporaries. Every name grizzle derives starts with `__`, so no declared name meets
 *   one; two distinct hashed identities meet only where their stems and their digests do, which the installation's
 *   census refuses as DigestCollision (`censusOf`), and a migration's census (`TemporaryCensus`) where a temporary
 *   meets a name standing while the migration runs or another temporary.
 *
 * Every identifier is quoted wherever it is printed, so a readable one that spells a keyword is still a name.
 *
 * The canonical encoding is injective and built once, at the identity's construction: the kind, then each part, a text
 * as its length and itself, a list bracketed, a nested identity by its own canonical encoding. The stem and the display
 * (what a hashed object's COMMENT holds: the identity spelled out) are read off the same parts, and are presentation
 * only.
 *
 * Identities are ordered by their kinds and parts (`compareIdentities`), never by their identifiers: a digest is no
 * order, and an installation-scoped identifier's digest differs from one installation to the next.
 */

/**
 * The longest identifier PostgreSQL keeps, in bytes: a longer one is truncated, so two names that differ past it are
 * one name.
 */
export const maxIdentifierBytes: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one identifier: an object's, a column's, a role's or a temporary table's name",
	from: [namedatalen],
	derivation:
		'NAMEDATALEN less its terminating zero: "The system uses no more than NAMEDATALEN-1 bytes of an identifier; longer names can be written in commands, but they will be truncated." (https://github.com/postgres/postgres/blob/REL_19_RC1/doc/src/sgml/syntax.sgml#L133-L135)',
	compute: ([n]) => n.value - 1
})

/** A hashed name's lead, `__`, which no declared name has. */
const hashedLead = "__"
/** The separator of a hashed name's stem and its digest. */
const digestSeparator = "_"

/**
 * The width of a hashed name's digest, in base32 characters of five bits each: a format constant of the naming door,
 * whose change renames every hashed object.
 *
 * Collision arithmetic: two distinct hashed identities share an identifier only where their stems agree and the first
 * 5 * digestChars = 50 bits of their canonical encodings' SHA-256 do. Over n hashed identities of one installation
 * the chance of any shared digest is at most n(n - 1) / 2 / 2^50: below 4.5 * 10^-8 for n = 10^4 and 4.5 * 10^-6 for
 * n = 10^5, one half only near n = 2^25. One that happens is detected and refused, never installed: `censusOf` checks
 * every hashed identifier an installation mints, and `TemporaryCensus` every temporary a migration mints, and each
 * refuses two identities of one as DigestCollision, which a rename of either one's declaration resolves.
 *
 * @formatConstant the base32 characters of a hashed name's digest
 */
const digestChars = 10

/**
 * The bytes a hashed name's stem may take: the longest identifier less its lead, its separator and its digest.
 */
const stemBudget: Limit = derived({
	owner: "grizzle's naming door",
	unit: "bytes",
	scope: "the readable stem of one hashed identifier",
	from: [maxIdentifierBytes],
	derivation:
		"maxIdentifierBytes - |__| - |_| - digestChars: the stem takes what the lead, the separator and the digest leave of the longest identifier",
	compute: ([max]) => max.value - hashedLead.length - digestSeparator.length - digestChars
})

/** One part of an identity: a text, a list of parts, or a nested identity. */
export type Part = string | ReadonlyArray<Part> | Identity<IdentityKind>

/** How a kind spells its identifier: readable, or hashed (`__<stem>_<digest>`). */
export type Form = "readable" | "hashed"

/** An identity, minted by its kind's constructor below: the parts that define it, its canonical encoding, stem, display,
 * the form its kind renders in, and its identifier. */
export interface Identity<K extends IdentityKind> {
	readonly kind: K
	readonly parts: ReadonlyArray<Part>
	readonly canonical: string
	readonly stem: string
	readonly display: string
	readonly form: Form
	readonly identifier: Identifier<K>
}

/** A kind's rendering: readable as `text`, or hashed. */
type Rendering = { readonly form: "readable"; readonly text: string } | { readonly form: "hashed" }

const readable = (text: string): Rendering => ({ form: "readable", text })
const hashed: Rendering = { form: "hashed" }

const isIdentity = (part: Part): part is Identity<IdentityKind> =>
	typeof part !== "string" && !Array.isArray(part) && Object.hasOwn(part, "canonical")

const encodePart = (part: Part): string => {
	if (typeof part === "string") {
		return `${part.length}:${part}`
	}
	if (isIdentity(part)) {
		return `{${part.canonical}}`
	}
	return `[${part.map(encodePart).join("")}]`
}

const base32 = "abcdefghijklmnopqrstuvwxyz234567"

/** The bits of a digest: five per base32 character. */
const digestBits = 5 * digestChars
/** The hex digits of SHA-256 that hold them, four bits each, and the bits past them the digest drops. */
const digestHexChars = Math.ceil(digestBits / 4)
const digestDropped = BigInt(4 * digestHexChars - digestBits)

/** The first digestBits bits of the canonical encoding's SHA-256, digestChars characters of lowercase base32. */
const digestOf = (canonical: string): string => {
	let bits = BigInt(`0x${sha256Hex(canonical).slice(0, digestHexChars)}`) >> digestDropped
	let out = ""
	for (let i = 0; i < digestChars; i++) {
		out = base32.charAt(Number(bits & 31n)) + out
		bits >>= 5n
	}
	return out
}

const isUpper = (ch: string): boolean => ch >= "A" && ch <= "Z"
const isLower = (ch: string): boolean => ch >= "a" && ch <= "z"
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9"

/**
 * The segments of a name: split at case boundaries (a lowercase letter or digit before an uppercase one, and the last
 * capital of a run before a lowercase letter, so HTTPRoute is HTTP|Route), at the edges of digit runs, and at every
 * character outside ASCII letters and digits.
 */
const nameSegments = (name: string): ReadonlyArray<string> => {
	const chars = Array.from(name)
	const segments: Array<string> = []
	let current = ""
	const flush = () => {
		if (current !== "") {
			segments.push(current)
		}
		current = ""
	}
	for (const [i, ch] of chars.entries()) {
		if (!(isUpper(ch) || isLower(ch) || isDigit(ch))) {
			flush()
			continue
		}
		const prev = chars[i - 1] ?? ""
		const next = chars[i + 1] ?? ""
		const boundary =
			current !== "" &&
			((isDigit(ch) && !isDigit(prev)) ||
				(!isDigit(ch) && isDigit(prev)) ||
				(isUpper(ch) && isLower(prev)) ||
				(isUpper(ch) && isUpper(prev) && isLower(next)))
		if (boundary) {
			flush()
		}
		current += ch
	}
	flush()
	return segments.map((s) => s.toLowerCase())
}

/** The conversion of a name: its segments, lowercased, joined by single underscores. A declared name's is its readable
 * identifier. */
export const conversionOf = (name: string): string => nameSegments(name).join("_")

declare const declaredNameBrand: unique symbol
declare const schemaNameBrand: unique symbol

/** A name as declared that keeps the declared-name rule, minted only by `parseDeclaredName`: what every readable
 * identity's constructor takes. */
export type DeclaredName = string & { readonly [declaredNameBrand]: true }

/** A schema's declared name that keeps the schema's rule besides, minted only by `parseSchemaName`. */
export type SchemaName = DeclaredName & { readonly [schemaNameBrand]: true }

const declaredNameOf = nominal<string, DeclaredName>()
const schemaName = nominal<DeclaredName, SchemaName>()

/**
 * The characters a declared name is written in: ASCII letters, digits and underscores, a letter first (`__` belongs to
 * grizzle's own names). A scope's name keeps them alone, since it names a rule's variables and never a PostgreSQL
 * identifier, as its type does (types/core/phantom.ts DeclaredName); a declared name keeps them and the rest of
 * parseDeclaredName's rule. The name, or the reason it breaks the rule.
 */
export const parseNameCharacters = (name: string): Result.Result<string, string> => {
	for (const ch of name) {
		if (!(isUpper(ch) || isLower(ch) || isDigit(ch) || ch === "_")) {
			return Result.err(
				`a name of ASCII letters, digits and underscores; ${JSON.stringify(ch)} is outside them`
			)
		}
	}
	if (name.startsWith("_")) {
		return Result.err(
			"a name not starting with an underscore, which grizzle keeps for its own names"
		)
	}
	if (name === "") {
		return Result.err("a name with at least one letter or digit")
	}
	if (isDigit(name.charAt(0))) {
		return Result.err("a name not starting with a digit")
	}
	return Result.ok(name)
}

/**
 * The rule a declared name keeps: its characters' (parseNameCharacters), and a conversion (its segments, lowercased,
 * joined by single underscores) within maxIdentifierBytes. Two declared names of one namespace whose conversions agree are one
 * name, which the declaring passes refuse (`DeclaredNamespace`). The name, parsed, or the reason it breaks the rule.
 */
export const parseDeclaredName = (name: string): Result.Result<DeclaredName, string> =>
	Result.flatMap(parseNameCharacters(name), (named): Result.Result<DeclaredName, string> => {
		const conversion = conversionOf(named)
		return utf8Length(conversion) > maxIdentifierBytes.value
			? Result.err(`a name whose conversion ${conversion} fits ${maxIdentifierBytes.value} bytes`)
			: Result.ok(declaredNameOf(named))
	})

/**
 * The rule a schema's declared name keeps: `parseDeclaredName`'s, and a conversion not starting with `pg_`, which
 * PostgreSQL reserves in the two namespaces the conversion leads in, its schemas' (the installed schema, each role's
 * schema) and its roles' (each login's and role's `<schema>__<name>`). The name, parsed, or the reason it breaks the
 * rule.
 */
export const parseSchemaName = (name: string): Result.Result<SchemaName, string> =>
	Result.flatMap(parseDeclaredName(name), (declared): Result.Result<SchemaName, string> => {
		const conversion = conversionOf(declared)
		return conversion.startsWith("pg_")
			? Result.err(
					`a name whose conversion ${conversion} does not start with pg_, which PostgreSQL reserves`
				)
			: Result.ok(schemaName(declared))
	})

/** Whether two declared names are one name: their segments agree, so the door renders both as one conversion
 * (TaskNote, Task_Note and task_note). */
export const declaredAlike = (a: DeclaredName, b: DeclaredName): boolean =>
	conversionOf(a) === conversionOf(b)

/**
 * One PostgreSQL namespace of declared names: the schema's relations, rosters and contracts; a table's, closed
 * relation's, derived relation's or role view's columns; a table's row checks; a role's views. It holds each conversion
 * taken, with the declaration that took it and where. The door renders a declared name as its conversion, so two
 * declarations of one conversion would be one identifier: they are one name declared twice.
 */
export class DeclaredNamespace {
	readonly #what: string
	readonly #taken = new Map<string, { readonly declaration: string; readonly loc: SourceLoc }>()

	/** `what` names the namespace in a refusal: "relation Task's field". */
	constructor(what: string) {
		this.#what = what
	}

	/**
	 * Declares `name`, a `kind` (relation, field, check...) at `loc`: the name, parsed, or its refusal,
	 * MalformedDescription for a name `parseDeclaredName` refuses and IdentifierCollision, with both places, for a name
	 * whose conversion an earlier declaration took, the same name declared twice included.
	 */
	declare(name: string, kind: string, loc: SourceLoc): Result.Result<DeclaredName, CompileError> {
		const declared = parseDeclaredName(name)
		if (!declared.ok) {
			return Result.err(
				malformedDescription(
					loc,
					`the declared ${kind} name ${JSON.stringify(name)} as ${declared.error}`
				)
			)
		}
		const conversion = conversionOf(declared.value)
		const declaration = `${kind} ${name}`
		const prior = this.#taken.get(conversion)
		if (prior !== undefined) {
			return Result.err(
				CompileError.make({
					_tag: "IdentifierCollision",
					at: loc,
					other: prior.loc,
					identifier: conversion,
					what: this.#what,
					declaration,
					otherDeclaration: prior.declaration
				})
			)
		}
		this.#taken.set(conversion, { declaration, loc })
		return declared
	}
}

/** The stem of an identity: its texts' segments joined by single underscores, cut at the last segment boundary within
 * the budget (at the budget itself when one segment is longer), led by the kind's word unless a letter leads. */
const stemOf = (kind: IdentityKind, texts: ReadonlyArray<string>): string => {
	const segments = texts.flatMap(nameSegments)
	const led = isLower(segments[0]?.charAt(0) ?? "")
		? segments
		: [...nameSegments(kind), ...segments]
	let stem = ""
	for (const segment of led) {
		const next = stem === "" ? segment : `${stem}_${segment}`
		if (utf8Length(next) > stemBudget.value) {
			return stem === "" ? segment.slice(0, stemBudget.value) : stem
		}
		stem = next
	}
	return stem
}

const brand = <K extends IdentityKind>(text: string): Identifier<K> =>
	nominal<string, Identifier<K>>()(text)

/** The one minter of an identifier: an identity of `kind` over `parts`, stemmed from `stem`, shown as `display`, and
 * spelled as its kind renders. */
const mint = <K extends IdentityKind>(
	kind: K,
	parts: ReadonlyArray<Part>,
	stem: ReadonlyArray<string>,
	display: string,
	rendering: Rendering
): Identity<K> => {
	const canonical = `${kind}(${parts.map(encodePart).join("")})`
	const stemText = stemOf(kind, stem)
	return Object.freeze({
		kind,
		parts,
		canonical,
		stem: stemText,
		display,
		form: rendering.form,
		identifier: brand<K>(
			rendering.form === "readable"
				? rendering.text
				: `${hashedLead}${stemText}${digestSeparator}${digestOf(canonical)}`
		)
	})
}

export const identifierOf = <K extends IdentityKind>(identity: Identity<K>): Identifier<K> =>
	identity.identifier

/** What a hashed object's COMMENT holds: its identity spelled out. */
export const displayOf = (identity: Identity<IdentityKind>): string => identity.display

/**
 * An installed identifier a decode boundary reads back (the snapshot, a server's ErrorResponse, the test catalog
 * reader), unchecked as every brand is.
 */
export const admittedIdentifier = <K extends IdentityKind>(text: string): Identifier<K> =>
	brand<K>(text)

/**
 * The order of two parts at one position: texts by code unit, lists element by element (a prefix first), nested
 * identities by `compareIdentities`; where the identities of one kind hold parts of different shapes at one position
 * (a span check's), a text comes first, then a list, then an identity.
 */
const compareParts = (a: Part, b: Part): number => {
	if (typeof a === "string") {
		return typeof b === "string" ? compareStrings(a, b) : -1
	}
	if (typeof b === "string") {
		return 1
	}
	if (isIdentity(a)) {
		return isIdentity(b) ? compareIdentities(a, b) : 1
	}
	return isIdentity(b) ? -1 : compareLists(a, b)
}

const compareLists = (a: ReadonlyArray<Part>, b: ReadonlyArray<Part>): number => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			return 1
		}
		const order = compareParts(x, y)
		if (order !== 0) {
			return order
		}
	}
	return a.length === b.length ? 0 : -1
}

/**
 * The order of identities: by kind, then part by part (`compareParts`), so two of them tie exactly when their canonical
 * encodings are equal. An installation's identity is a part of every installation-scoped identity, at one position per
 * kind, so it orders no two objects of one installation: two installations of one schema order their objects alike.
 */
export const compareIdentities: Comparator<Identity<IdentityKind>> = (a, b) => {
	const kind = compareStrings(a.kind, b.kind)
	return kind === 0 ? compareLists(a.parts, b.parts) : kind
}

/** The refusal of two distinct objects, `display` and `otherDisplay`, whose hashed names are both `identifier`. */
const digestCollision = (identifier: string, display: string, otherDisplay: string): CompileError =>
	CompileError.make({
		_tag: "DigestCollision",
		at: SourceLoc("the naming door", []),
		identifier,
		display,
		otherDisplay
	})

/**
 * The first two distinct identities of one identifier among `identities`, in their order, when there are two: what a
 * digest collision is, since every hashed identifier is its identity's stem and digest.
 */
const firstCollision = (
	identities: Iterable<Identity<IdentityKind>>
): readonly [Identity<IdentityKind>, Identity<IdentityKind>] | undefined => {
	const seen = new Map<string, Identity<IdentityKind>>()
	for (const i of identities) {
		const prior = seen.get(i.identifier)
		if (prior !== undefined && prior.canonical !== i.canonical) {
			return [prior, i]
		}
		seen.set(i.identifier, i)
	}
	return undefined
}

/**
 * The census of one installation: each hashed identifier it minted, to the identity it minted it from, and every
 * readable identifier it minted. A readable identifier spells its identity and names an object only within its
 * namespace, so one text may name many (a column of each table, every domain's `check`); a hashed one names one object
 * in the whole installation.
 */
export interface Census {
	readonly hashed: ReadonlyMap<string, Identity<IdentityKind>>
	readonly readable: ReadonlySet<string>
}

/**
 * The census of every identity an installation minted, or its refusal. The one site of the fact that distinct hashed
 * identities have distinct identifiers: two of one identifier share a stem and a digest of digestChars characters
 * (`firstCollision`), which no type rules out and the digest's width makes rare, never impossible, so it is refused as
 * DigestCollision, naming both, before anything is installed.
 */
export const censusOf = (
	identities: ReadonlyArray<Identity<IdentityKind>>
): Result.Result<Census, CompileError> => {
	const hashedOnes = identities.filter((i) => i.form === "hashed")
	const collision = firstCollision(hashedOnes)
	if (collision !== undefined) {
		const [first, second] = collision
		return Result.err(digestCollision(first.identifier, first.display, second.display))
	}
	return Result.ok({
		hashed: new Map(hashedOnes.map((i) => [i.identifier, i] as const)),
		readable: new Set(identities.filter((i) => i.form === "readable").map((i) => i.identifier))
	})
}

/** What an identifier the installation minted is: a hashed one with the identity it was minted from, or a readable one,
 * which spells its identity. */
export type Censused =
	| { readonly form: "hashed"; readonly identity: Identity<IdentityKind> }
	| { readonly form: "readable" }

/** What `identifier` is in the census, or undefined when the installation minted no such identifier. */
export const censused = (census: Census, identifier: string): Censused | undefined => {
	const named = census.hashed.get(identifier)
	if (named !== undefined) {
		return { form: "hashed", identity: named }
	}
	return census.readable.has(identifier) ? { form: "readable" } : undefined
}

/** The kinds of identity only a migration mints: the temporary names a holder is set aside under, and an index is built
 * under before it is swapped in. */
export type TemporaryKind = Extract<IdentityKind, "aside" | "swap">

/**
 * A hashed name that stands while a migration runs: one the previous installation or the target installs, by its
 * identifier and the identity its COMMENT spells out (physical/install/comments.ts hashedNames).
 */
export interface StandingName {
	readonly identifier: string
	readonly display: string
}

/**
 * The census of one migration's temporaries: every hashed name standing while it runs, the previous installation's and
 * the target's, and each temporary minted so far. The one site of the fact that a temporary names no object but its
 * own: no installation mints a temporary's kind, so a temporary whose identifier a standing name has, or another
 * temporary of another identity, shares its stem and its digest, which no type rules out and the digest's width makes
 * rare, never impossible. It is refused as DigestCollision where the temporary is minted, before any statement drafts
 * it, so no statement of a migration creates, renames into or drops under a temporary name an object that stands.
 *
 * A readable name never meets a temporary: a declared name does not start with `_`, and no name grizzle fixes ends, as
 * a hashed one does, in `_` and digestChars characters of base32.
 */
export class TemporaryCensus {
	readonly #standing: ReadonlyMap<string, string>
	readonly #minted = new Map<string, Identity<TemporaryKind>>()

	constructor(standing: Iterable<StandingName>) {
		this.#standing = new Map(Array.from(standing, (n) => [n.identifier, n.display] as const))
	}

	/**
	 * `temporary` admitted to the census, as its identifier, or its refusal: DigestCollision naming it and the standing
	 * name or the other temporary that has its identifier. A temporary minted again is the same name.
	 */
	admit<K extends TemporaryKind>(
		temporary: Identity<K>
	): Result.Result<Identifier<K>, CompileError> {
		const { identifier } = temporary
		const standing = this.#standing.get(identifier)
		if (standing !== undefined) {
			return Result.err(digestCollision(identifier, standing, temporary.display))
		}
		const prior = this.#minted.get(identifier)
		if (prior !== undefined && prior.canonical !== temporary.canonical) {
			return Result.err(digestCollision(identifier, prior.display, temporary.display))
		}
		this.#minted.set(identifier, temporary)
		return Result.ok(identifier)
	}
}

/**
 * A literal as an identity takes it: its canonical text, the one part two literals share exactly when they are one
 * value, its stem and its display (ir/expr.ts identityValueOf).
 */
export interface IdentityValue {
	readonly part: string
	readonly stem: string
	readonly display: string
}

/**
 * A column a key or a foreign key names: a field by its name, or a law column by its identity, whose stem and display
 * the naming key's read, never its digest.
 */
export type KeyColumnName = string | Identity<"lawColumn">

/** A side of a foreign key: its relation and its columns in order. */
export interface KeySide {
	readonly relation: string
	readonly fields: ReadonlyArray<KeyColumnName>
}

/** The access methods of an index grizzle installs: B-tree, GiST, pgvector's HNSW and hash. */
export type IndexMethod = "btree" | "gist" | "hnsw" | "hash"

/** One key of an access index: its field, direction and operator class. */
interface IndexKey {
	readonly field: string
	readonly dir: Direction
	readonly opclass: "default" | "vectorCosine"
}

/** Which of a span column's CHECKs: its shape, its width, or the contract of its endpoint. */
export type SpanCheck =
	| { readonly kind: "shape" }
	| { readonly kind: "width" }
	| { readonly kind: "endpoint"; readonly contract: string }

/** A law as the theory states it (analysis/theory/theory.ts lawIdentityOf): its parts, stem and display. */
export interface LawStatement {
	readonly parts: ReadonlyArray<Part>
	readonly stem: ReadonlyArray<string>
	readonly display: string
}

/** A key column's stem: a field's name, or a law column's own stem. */
const columnStem = (c: KeyColumnName): string => (typeof c === "string" ? c : c.stem)

/** A key column's display: a field's name, or a law column's own display. */
const columnDisplay = (c: KeyColumnName): string => (typeof c === "string" ? c : c.display)

const sideDisplay = (side: KeySide): string => fieldsOf(side.relation, side.fields)

const fieldsOf = (relation: string, fields: ReadonlyArray<KeyColumnName>): string =>
	`${relation}(${fields.map(columnDisplay).join(", ")})`

/**
 * What a law column is, as the law model states it: a constant a selected target fixes on its source, by the target
 * relation, the field the constant meets and its value; a side's term, a field or pred of one, under the side's
 * selection, its conjuncts by their canonical texts, none for every row; a column the host draws for the family whose
 * law is `family`, its owner relation and count field named for its stem and display: ‹n›, the owner's count on a
 * member (copy), a counted family's index, a tree's parent start, or a fold's hidden accumulator before or after plane
 * `plane` of the fold whose law is `fold`, so removing another fold renames none of its columns; or a counted family's
 * predecessor, pred of its drawn index, which PostgreSQL generates from the row. A drawn column is named by the laws
 * that say what it holds, so a family or fold that changes what it holds names a new column, which the migration draws
 * again, and one a declared rename only renames keeps its name under the previous snapshot's spelling. Its relation is
 * the table the column is added to, whose namespace holds it.
 */
export type LawColumnStatement =
	| {
			readonly kind: "constant"
			readonly target: string
			readonly field: string
			readonly value: IdentityValue
	  }
	| {
			readonly kind: "term"
			readonly term: { readonly kind: "field" | "pred"; readonly field: string }
			readonly selection: ReadonlyArray<string>
	  }
	| {
			readonly kind: "copy" | "index" | "parentStart" | "predecessor"
			readonly owner: string
			readonly count: string
			/** The family's own law. */
			readonly family: Identifier<"law">
	  }
	| {
			readonly kind: "before" | "after"
			readonly owner: string
			readonly count: string
			/** The family's own law. */
			readonly family: Identifier<"law">
			/** The fold's own law, whose identity is no position among its family's folds. */
			readonly fold: Identifier<"law">
			readonly plane: 0 | 1
	  }

/** What each drawn law column of a family is, in its display. */
const drawnWords = {
	copy: "the owner's count",
	index: "the index",
	parentStart: "the parent's start",
	predecessor: "the predecessor of the index"
} as const

/** The suffix of a decoded column's name after its field's conversion. */
const decodedSuffix = "_name"

/**
 * Whether a closed-id field's decoded column fits maxIdentifierBytes: its field's conversion and the suffix, which a
 * field whose conversion fills the identifier leaves no room for.
 */
export const decodedColumnFits = (field: DeclaredName): boolean =>
	utf8Length(`${conversionOf(field)}${decodedSuffix}`) <= maxIdentifierBytes.value

/** One constructor per kind: nothing else mints an identity. */
export const identity = Object.freeze({
	/** A schema, by its declared name, or the unique name a test installs a schema under, either parsed. */
	schema: (name: SchemaName): Identity<"schema"> =>
		mint("schema", [name], [name], `schema ${name}`, readable(conversionOf(name))),
	/** A stored relation's table. */
	table: (relation: DeclaredName): Identity<"table"> =>
		mint("table", [relation], [relation], `relation ${relation}`, readable(conversionOf(relation))),
	/**
	 * A roster's domain over smallint, its codes' range proof: its one CHECK admits exactly the roster's live codes, so
	 * every closed id it types is one, and every digit a closed relation's constant is indexed by is in range.
	 */
	rosterDomain: (roster: DeclaredName): Identity<"rosterDomain"> =>
		mint("rosterDomain", [roster], [roster], `roster ${roster}`, readable(conversionOf(roster))),
	/**
	 * A roster's names constant, named by its roster and the digest of its names in code order: a changed constant is a
	 * new function, never one replaced in place.
	 */
	rosterConstant: (
		roster: DeclaredName,
		digest: ConstantDigest<"roster-names">
	): Identity<"rosterConstant"> =>
		mint(
			"rosterConstant",
			[roster, digest],
			[roster, "names"],
			`names of roster ${roster} (${digest})`,
			hashed
		),
	/**
	 * A roster's live codes as a bit string at a set's width, one bit per code, set where its names constant names a
	 * handle, its padding 0: a function of the names, so it is named by that constant's digest, and a removal is a new
	 * function.
	 */
	rosterLive: (
		roster: DeclaredName,
		digest: ConstantDigest<"roster-names">
	): Identity<"rosterLive"> =>
		mint(
			"rosterLive",
			[roster, digest],
			[roster, "live"],
			`live codes of roster ${roster} (${digest})`,
			hashed
		),
	/**
	 * The domain of a set over a roster, bit(width) with width every code the roster has minted rounded up to whole hex
	 * digits, whose one CHECK admits only its live codes' bits: one per roster and width, so a growth past a whole digit
	 * is a new domain and a column moves to it.
	 */
	bitsDomain: (roster: DeclaredName, width: number): Identity<"bitsDomain"> =>
		mint(
			"bitsDomain",
			[roster, `${width}`],
			[roster, "bits", `${width}`],
			`sets over roster ${roster} of ${width} bits`,
			hashed
		),
	/**
	 * A closed relation's or a side's constant, named by the digest of its content alone: two of equal content are one
	 * function, and a changed one is a new function.
	 */
	closedConstant: (digest: ConstantDigest<"closed-constant">): Identity<"closedConstant"> =>
		mint("closedConstant", [digest], ["constant"], `closed constant ${digest}`, hashed),
	/** A derived relation's materialized view. */
	view: (relation: DeclaredName): Identity<"view"> =>
		mint(
			"view",
			[relation],
			[relation],
			`derived relation ${relation}`,
			readable(conversionOf(relation))
		),
	/** A field's column, in whatever table or view holds it: its name alone, so renaming a relation renames no column. */
	column: (field: DeclaredName): Identity<"column"> =>
		mint("column", [field], [field], `field ${field}`, readable(conversionOf(field))),
	/**
	 * A role view's decoded column beside a closed-id field's, `<field>_name`, the handle its code names. It is readable
	 * in its view's column namespace exactly when no other field of the relation converts to it, which ownership
	 * refuses, and fits maxIdentifierBytes exactly when the field's conversion leaves room for its suffix.
	 */
	decodedColumn: (field: DeclaredName): Identity<"decodedColumn"> =>
		mint(
			"decodedColumn",
			[field],
			[field, "name"],
			`decoded name of field ${field}`,
			readable(`${conversionOf(field)}${decodedSuffix}`)
		),
	/** A law column (`LawColumnStatement`). */
	lawColumn: (column: LawColumnStatement): Identity<"lawColumn"> => {
		switch (column.kind) {
			case "constant":
				return mint(
					"lawColumn",
					["constant", column.target, column.field, column.value.part],
					["tag", column.field, column.value.stem],
					`tag ${column.target}.${column.field} = ${column.value.display}`,
					hashed
				)
			case "term": {
				const { term, selection } = column
				const spelled = term.kind === "pred" ? `pred(${term.field})` : term.field
				return mint(
					"lawColumn",
					["term", [term.kind, term.field], selection],
					term.kind === "pred" ? ["pred", term.field] : [term.field],
					`${spelled}${selection.length === 0 ? "" : ` where ${selection.join(" and ")}`}`,
					hashed
				)
			}
			case "copy":
			case "index":
			case "parentStart":
			case "predecessor":
				return mint(
					"lawColumn",
					[column.kind, column.family],
					[column.kind === "parentStart" ? "parent_start" : column.kind, column.count],
					`${drawnWords[column.kind]} of the family ${column.owner}.${column.count}`,
					hashed
				)
			case "before":
			case "after":
				return mint(
					"lawColumn",
					[column.kind, column.family, column.fold, `${column.plane}`],
					[column.kind, column.count, `${column.plane}`],
					`the accumulator ${column.kind} plane ${column.plane} of the fold ${column.fold} over the family ${column.owner}.${column.count}`,
					hashed
				)
		}
	},
	/**
	 * A contract's domain, by the digest of its physical definition alone: two contracts of one definition are one
	 * domain, and the contract a column is of stays its type's brand.
	 */
	contractDomain: (definition: DomainDigest): Identity<"contractDomain"> =>
		mint("contractDomain", [definition], ["domain"], `domain of definition ${definition}`, hashed),
	/** A structural text domain, by the digest of its physical definition alone: equal definitions share it. */
	textDomain: (definition: DomainDigest): Identity<"textDomain"> =>
		mint("textDomain", [definition], ["text"], `text domain of definition ${definition}`, hashed),
	sequence: (relation: string, field: string): Identity<"sequence"> =>
		mint(
			"sequence",
			[relation, field],
			[relation, field, "seq"],
			`identity sequence of ${relation}.${field}`,
			hashed
		),
	advance: (relation: string, field: string): Identity<"advance"> =>
		mint(
			"advance",
			[relation, field],
			["advance", relation, field],
			`advance function of ${relation}.${field}`,
			hashed
		),
	/**
	 * A stored relation's primary key, by its relation alone: a relation has exactly one, so a migration that moves it
	 * to other fields replaces it under its name, the one order PostgreSQL admits (a table holds at most one: 42P16).
	 */
	primaryKey: (relation: string): Identity<"primaryKey"> =>
		mint("primaryKey", [relation], [relation, "pk"], `primary key of ${relation}`, hashed),
	/** A candidate key or a generated unique, a span key's span field among its fields. */
	key: (relation: string, fields: ReadonlyArray<KeyColumnName>): Identity<"key"> =>
		mint(
			"key",
			[relation, fields],
			[relation, "key", ...fields.map(columnStem)],
			`key ${fieldsOf(relation, fields)}`,
			hashed
		),
	/** A declared row check, by its declared name, in its table's constraint namespace. */
	check: (relation: string, name: DeclaredName): Identity<"check"> =>
		mint(
			"check",
			[relation, name],
			[relation, "check", name],
			`check ${name} of ${relation}`,
			readable(conversionOf(name))
		),
	/** The CHECK a law lowers to on a table: a closed law's, or a family's. */
	generatedCheck: (relation: string, law: Identity<"law">): Identity<"generatedCheck"> =>
		mint(
			"generatedCheck",
			[relation, law],
			[relation, "check", law.stem],
			`check of ${relation} for law ${law.display}`,
			hashed
		),
	spanCheck: (relation: string, field: string, check: SpanCheck): Identity<"spanCheck"> =>
		mint(
			"spanCheck",
			[relation, field, check.kind === "endpoint" ? ["endpoint", check.contract] : check.kind],
			[
				relation,
				field,
				check.kind === "endpoint" ? check.contract : check.kind === "shape" ? "span" : "width"
			],
			`span ${check.kind === "endpoint" ? `endpoint ${check.contract}` : check.kind} check of ${relation}.${field}`,
			hashed
		),
	normCheck: (relation: string, field: string): Identity<"normCheck"> =>
		mint(
			"normCheck",
			[relation, field],
			[relation, "norm", field],
			`cosine norm check of ${relation}.${field}`,
			hashed
		),
	/** A date column's range CHECK: the days a CalendarDate spells. */
	dateCheck: (relation: string, field: string): Identity<"dateCheck"> =>
		mint(
			"dateCheck",
			[relation, field],
			[relation, "range", field],
			`date range check of ${relation}.${field}`,
			hashed
		),
	/** A contract's, text domain's, roster's or set's domain's CHECK, `check` in its domain's constraint namespace. */
	domainCheck: (
		domain: Identity<"contractDomain" | "textDomain" | "rosterDomain" | "bitsDomain">
	): Identity<"domainCheck"> =>
		mint(
			"domainCheck",
			[domain],
			[domain.stem, "check"],
			`check of ${domain.display}`,
			readable("check")
		),
	foreignKey: (from: KeySide, to: KeySide, period: boolean): Identity<"foreignKey"> =>
		mint(
			"foreignKey",
			[from.relation, from.fields, to.relation, to.fields, period ? "period" : "scalar"],
			[from.relation, "fk", ...from.fields.map(columnStem)],
			`${period ? "PERIOD " : ""}foreign key ${sideDisplay(from)} to ${sideDisplay(to)}`,
			hashed
		),
	/**
	 * An access index over every row of its relation, by its method and keys. Its parts close with an empty list, which
	 * every installed access index's name digests.
	 */
	accessIndex: (
		relation: string,
		method: IndexMethod,
		keys: ReadonlyArray<IndexKey>
	): Identity<"accessIndex"> =>
		mint(
			"accessIndex",
			[relation, method, keys.map((k) => [k.field, k.dir, k.opclass]), []],
			[relation, "ix", ...keys.map((k) => k.field)],
			`${method} index ${relation}(${keys.map((k) => `${k.field}${k.dir === "desc" ? " desc" : ""}${k.opclass === "default" ? "" : ` ${k.opclass}`}`).join(", ")})`,
			hashed
		),
	statistics: (relation: string, fields: ReadonlyArray<string>): Identity<"statistics"> =>
		mint(
			"statistics",
			[relation, fields],
			[relation, "stats", ...fields],
			`statistics ${fieldsOf(relation, fields)}`,
			hashed
		),
	/** A derived relation's unique index on a key its definition proves. */
	derivedKey: (view: string, fields: ReadonlyArray<string>): Identity<"derivedKey"> =>
		mint(
			"derivedKey",
			[view, fields],
			[view, "key", ...fields],
			`key ${fieldsOf(view, fields)}`,
			hashed
		),
	/** A law of the theory, as analysis/theory/theory.ts states it. */
	law: (law: LawStatement): Identity<"law"> =>
		mint("law", law.parts, law.stem, law.display, hashed),
	/** The law of one stored field's text refinement, checked by its structural text domain's CHECK, which every field
	 * of one pattern shares: one law per field, so the field names it. */
	patternLaw: (
		domain: Identity<"textDomain">,
		relation: string,
		field: string
	): Identity<"patternLaw"> =>
		mint(
			"patternLaw",
			[domain, relation, field],
			[relation, "pattern", field],
			`pattern law of ${relation}.${field} under ${domain.display}`,
			hashed
		),
	/** A login's PostgreSQL role, `<schema>__<login>`: roles are cluster-wide, so its installation is part of it. */
	login: (installation: Identity<"schema">, name: DeclaredName): Identity<"login"> =>
		mint(
			"login",
			[installation, name],
			[installation.stem, name],
			`login ${name} of ${installation.display}`,
			readable(`${installation.identifier}__${conversionOf(name)}`)
		),
	/** A role's PostgreSQL role, its theory role, `<schema>__<role>`. */
	role: (installation: Identity<"schema">, name: DeclaredName): Identity<"role"> =>
		mint(
			"role",
			[installation, name],
			[installation.stem, name],
			`role ${name} of ${installation.display}`,
			readable(`${installation.identifier}__${conversionOf(name)}`)
		),
	/** A role's own schema of views, its role's name. */
	roleSchema: (role: Identity<"role">): Identity<"roleSchema"> =>
		mint("roleSchema", [role], [role.stem], `schema of ${role.display}`, readable(role.identifier)),
	/** A role relation's view in its role's schema, by the relation's declared name. */
	roleView: (role: Identity<"role">, entry: DeclaredName): Identity<"roleView"> =>
		mint(
			"roleView",
			[role, entry],
			[entry],
			`view ${entry} of ${role.display}`,
			readable(conversionOf(entry))
		),
	/** A writable entry's filter function. */
	filter: (role: Identity<"role">, entry: string): Identity<"filter"> =>
		mint(
			"filter",
			[role, entry],
			[role.stem, entry, "filter"],
			`filter function of ${entry} of ${role.display}`,
			hashed
		),
	/** A writable query entry's key probe over one key of the relation it writes. */
	keyProbe: (
		role: Identity<"role">,
		entry: string,
		key: ReadonlyArray<string>
	): Identity<"keyProbe"> =>
		mint(
			"keyProbe",
			[role, entry, key],
			[role.stem, entry, "key", ...key],
			`key probe (${key.join(", ")}) of ${entry} of ${role.display}`,
			hashed
		),
	/** A writable query entry's unique probe over one unique object of the relation it writes that no key subsumes, by
	 * the object's installed name. */
	uniqueProbe: (role: Identity<"role">, entry: string, object: string): Identity<"uniqueProbe"> =>
		mint(
			"uniqueProbe",
			[role, entry, object],
			[role.stem, entry, "unique"],
			`unique probe of ${object} of ${entry} of ${role.display}`,
			hashed
		),
	/** A role's row security policy on a table it writes, its role's name: a role writes a table through at most one
	 * entry. */
	policy: (role: Identity<"role">, relation: string): Identity<"policy"> =>
		mint(
			"policy",
			[role, relation],
			[role.stem],
			`policy of ${role.display} on ${relation}`,
			readable(role.identifier)
		),
	/** The migrations ledger. */
	ledger: (): Identity<"ledger"> =>
		mint("ledger", [], ["ledger"], "the migrations ledger", readable("__ledger")),
	/** The migrations ledger's primary key. */
	ledgerKey: (): Identity<"ledgerKey"> =>
		mint("ledgerKey", [], ["ledger", "pk"], "the migrations ledger's key", readable("__ledger_pk")),
	/** One of the migrations ledger's CHECKs, by the column it bounds. */
	ledgerCheck: (column: string): Identity<"ledgerCheck"> =>
		mint(
			"ledgerCheck",
			[column],
			["ledger", column, "check"],
			`the migrations ledger's check of ${column}`,
			readable(`__ledger_${conversionOf(column)}_check`)
		),
	isolationGuard: (): Identity<"isolationGuard"> =>
		mint(
			"isolationGuard",
			[],
			["require", "serializable"],
			"the SERIALIZABLE write guard",
			readable("__require_serializable")
		),
	isolationTrigger: (): Identity<"isolationTrigger"> =>
		mint(
			"isolationTrigger",
			[],
			["isolation"],
			"the SERIALIZABLE write guard trigger",
			readable("__isolation")
		),
	refusal: (): Identity<"refusal"> =>
		mint("refusal", [], ["refuse"], "the refusal function", readable("__refuse")),
	snapshotGuard: (): Identity<"snapshotGuard"> =>
		mint(
			"snapshotGuard",
			[],
			["snapshot", "guard"],
			"the snapshot guard function",
			readable("__snapshot_guard")
		),
	/**
	 * The deferred constraint trigger a rule over a query is held by on every table it reads: one name for the rule,
	 * which PostgreSQL scopes to each table's triggers and constraints.
	 */
	lawTrigger: (law: Identity<"law">): Identity<"lawTrigger"> =>
		mint("lawTrigger", [law], ["rule", law.stem], `trigger of rule ${law.display}`, hashed),
	/**
	 * The function a rule over a query's trigger on `relation`'s table runs, which reads the relations `reads`: its body
	 * names their tables in PL/pgSQL text, which a rename of a table never reaches, so a rename of one of them names
	 * another function, created in its place.
	 */
	lawFunction: (
		relation: string,
		law: Identity<"law">,
		reads: ReadonlyArray<string>
	): Identity<"lawFunction"> =>
		mint(
			"lawFunction",
			[relation, law, ...reads],
			["rule", relation, law.stem],
			`function of rule ${law.display} on ${relation}`,
			hashed
		),
	/** The name a migration sets a held object aside under. */
	aside: (of: string): Identity<"aside"> =>
		mint("aside", [of], ["aside", of], `${of} set aside`, hashed),
	/** The name an index is built under before it is swapped in for `of`. */
	swap: (of: string): Identity<"swap"> => mint("swap", [of], ["next", of], `the next ${of}`, hashed)
})
