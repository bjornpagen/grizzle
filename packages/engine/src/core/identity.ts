import { nominal } from "#compiler/core/brand.ts"
import { CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { Identifier, IdentityKind } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { type Comparator, compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex, utf8Length } from "#compiler/core/sha256.ts"

/**
 * The naming door: every PostgreSQL identifier grizzle installs, declared or derived, is minted here from the object's
 * structured identity, its kind and the parts that define it, and nowhere else.
 *
 * Each kind renders by one rule: readable exactly when its identity maps one-to-one into PostgreSQL's 63
 * bytes inside the namespace PostgreSQL puts the object in, otherwise hashed, and a name never changes form for its
 * length or a collision.
 *
 * - Readable: a declared name's conversion (its segments, lowercased, joined by single underscores: the schema, tables,
 *   derived relations, rosters and contracts, columns, row checks and a role's views), a login's or role's
 *   `<schema>__<name>` (a role's schema and policies take its role's), or a name grizzle fixes (`check` for a domain's
 *   CHECK, the per-schema singletons `__ledger` with its key and checks, `__refuse`, `__require_serializable` and
 *   `__snapshot_guard`, the per-table trigger `__isolation`). The declaration rules make each one-to-one in its
 *   namespace: declared names are compared by their conversions (`DeclaredNamespace`, every namespace of declared
 *   names: the schema's relations, rosters and contracts, each relation's or view's columns, each table's row checks,
 *   each role's views), none starts with `_`, and one whose conversion is over 63 bytes is refused; a schema's
 *   conversion does not start with `pg_`. A readable constructor takes the name parsed (`DeclaredName`, minted by
 *   `parseDeclaredName`; `SchemaName`, by `parseSchemaName`), so no readable identity has a name the rule refuses; a
 *   login's or role's name is refused when it does not fit with its schema's (physical/ddl/names.ts).
 * - Hashed: `__`, a readable stem cut to `stemBudget` bytes at a segment boundary, `_` and a digest of the identity's
 *   canonical encoding, 50 bits of SHA-256 as 10 characters of lowercase RFC 4648 base32: keys, foreign keys, span,
 *   norm and law checks, indexes and statistics, sequences, text-pattern domains, tag columns, laws and their functions
 *   and triggers, filter functions, key and unique probes and advance functions, and a migration's temporaries. Every
 *   name grizzle derives starts with `__`, so no declared name meets one; two distinct hashed identities meet only where
 *   50 bits of two digests do, which the installation's census treats as a compiler defect, never as a refusal.
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

/** The bytes a hashed name's stem may take between its leading `__` and its `_` and digest: 63 less the 13 those take. */
const stemBudget = 50
const digestChars = 10
export const maxIdentifierBytes = 63

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

/** The first 50 bits of the canonical encoding's SHA-256, ten characters of lowercase base32. */
const digestOf = (canonical: string): string => {
	let bits = BigInt(`0x${sha256Hex(canonical).slice(0, 13)}`) >> 2n
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
const schemaNameOf = nominal<DeclaredName, SchemaName>()

/**
 * The rule a declared name keeps: letters, digits and underscores only, at least one
 * letter or digit, no digit first, no underscore first (`__` belongs to grizzle's own names), and a conversion (its
 * segments, lowercased, joined by single underscores) within 63 bytes. Two declared names of one namespace whose
 * conversions agree are one name, which the declaring passes refuse (`DeclaredNamespace`). The name, parsed, or the
 * reason it breaks the rule.
 */
export const parseDeclaredName = (name: string): Result.Result<DeclaredName, string> => {
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
	const segments = nameSegments(name)
	const first = segments[0]
	if (first === undefined) {
		return Result.err("a name with at least one letter or digit")
	}
	if (isDigit(first.charAt(0))) {
		return Result.err("a name not starting with a digit")
	}
	const conversion = segments.join("_")
	if (utf8Length(conversion) > maxIdentifierBytes) {
		return Result.err(`a name whose conversion ${conversion} fits ${maxIdentifierBytes} bytes`)
	}
	return Result.ok(declaredNameOf(name))
}

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
			: Result.ok(schemaNameOf(declared))
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
		if (utf8Length(next) > stemBudget) {
			return stem === "" ? segment.slice(0, stemBudget) : stem
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
			rendering.form === "readable" ? rendering.text : `__${stemText}_${digestOf(canonical)}`
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

/**
 * The census of one installation: every two distinct identities have distinct identifiers. A digest collision is a
 * compiler defect, never a refusal. Returns the first collision's two canonical encodings, when there is one.
 */
export const firstCollision = (
	identities: Iterable<Identity<IdentityKind>>
): readonly [string, string] | undefined => {
	const seen = new Map<string, string>()
	for (const i of identities) {
		const prior = seen.get(i.identifier)
		if (prior !== undefined && prior !== i.canonical) {
			return [prior, i.canonical]
		}
		seen.set(i.identifier, i.canonical)
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
 * The census of every identity an installation minted. The one site of the fact that distinct hashed identities have
 * distinct identifiers: two of one identifier would be a SHA-256 collision of their canonical texts (`firstCollision`),
 * which no type can rule out, so it is a compiler defect, never a refusal.
 */
export const censusOf = (identities: ReadonlyArray<Identity<IdentityKind>>): Census => {
	const hashedOnes = identities.filter((i) => i.form === "hashed")
	const collision = firstCollision(hashedOnes)
	if (collision !== undefined) {
		throw defect(`distinct identifiers for distinct identities: ${collision.join(" and ")}`)
	}
	return {
		hashed: new Map(hashedOnes.map((i) => [i.identifier, i] as const)),
		readable: new Set(identities.filter((i) => i.form === "readable").map((i) => i.identifier))
	}
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

/**
 * A literal as an identity takes it: its canonical text, the one part two literals share exactly when they are one
 * value, its stem and its display (ir/expr.ts identityValueOf).
 */
export interface IdentityValue {
	readonly part: string
	readonly stem: string
	readonly display: string
}

/** A field a selection fixes, and the literal it equals. */
export interface Selector {
	readonly field: string
	readonly value: IdentityValue
}

/** A side of a foreign key: its relation, its fields in order, and the selection it holds to. */
export interface KeySide {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly selection: ReadonlyArray<Selector>
}

/** One key of an access index: its field, direction and operator class. */
export interface IndexKey {
	readonly field: string
	readonly dir: "asc" | "desc"
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

const selectionPart = (selection: ReadonlyArray<Selector>): Part =>
	selection.map((s) => [s.field, s.value.part])

const selectionStem = (selection: ReadonlyArray<Selector>): ReadonlyArray<string> =>
	selection.flatMap((s) => [s.field, s.value.stem])

const selectionDisplay = (selection: ReadonlyArray<Selector>): string =>
	selection.length === 0
		? ""
		: ` where ${selection.map((s) => `${s.field} = ${s.value.display}`).join(", ")}`

const sideDisplay = (side: KeySide): string =>
	`${side.relation}(${side.fields.join(", ")})${selectionDisplay(side.selection)}`

const fieldsOf = (relation: string, fields: ReadonlyArray<string>): string =>
	`${relation}(${fields.join(", ")})`

/** One constructor per kind: nothing else mints an identity. */
export const identity = Object.freeze({
	/** A schema, by its declared name, or the unique name a test installs a schema under, either parsed. */
	schema: (name: SchemaName): Identity<"schema"> =>
		mint("schema", [name], [name], `schema ${name}`, readable(conversionOf(name))),
	/** A stored relation's table. */
	table: (relation: DeclaredName): Identity<"table"> =>
		mint("table", [relation], [relation], `relation ${relation}`, readable(conversionOf(relation))),
	/** A closed relation's enum type. */
	enumType: (relation: DeclaredName): Identity<"enum"> =>
		mint(
			"enum",
			[relation],
			[relation],
			`closed relation ${relation}`,
			readable(conversionOf(relation))
		),
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
	/** The stored tag of a selected target: its target relation, selector field and value. */
	tag: (target: string, field: string, value: IdentityValue): Identity<"tag"> =>
		mint(
			"tag",
			[target, field, value.part],
			["tag", field, value.stem],
			`tag ${target}.${field} = ${value.display}`,
			hashed
		),
	contractDomain: (contract: DeclaredName): Identity<"contractDomain"> =>
		mint(
			"contractDomain",
			[contract],
			[contract],
			`contract ${contract}`,
			readable(conversionOf(contract))
		),
	/** A structural text domain, by the digest of its canonical pattern key: equal patterns share it. */
	textDomain: (patternDigest: string): Identity<"textDomain"> =>
		mint("textDomain", [patternDigest], ["text"], `text pattern ${patternDigest}`, hashed),
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
	/** A candidate key, a generated unique or a temporal unique, its span field among its fields. */
	key: (relation: string, fields: ReadonlyArray<string>): Identity<"key"> =>
		mint(
			"key",
			[relation, fields],
			[relation, "key", ...fields],
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
	/** The CHECK a law lowers to on a table: a finite membership or a capacity's row check. */
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
	/** A contract's or text domain's CHECK, `check` in its domain's constraint namespace. */
	domainCheck: (domain: Identity<"contractDomain" | "textDomain">): Identity<"domainCheck"> =>
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
			[
				from.relation,
				from.fields,
				selectionPart(from.selection),
				to.relation,
				to.fields,
				selectionPart(to.selection),
				period ? "period" : "scalar"
			],
			[from.relation, "fk", ...from.fields, ...selectionStem(from.selection)],
			`${period ? "PERIOD " : ""}foreign key ${sideDisplay(from)} to ${sideDisplay(to)}`,
			hashed
		),
	partialUnique: (
		relation: string,
		fields: ReadonlyArray<string>,
		where: ReadonlyArray<Selector>
	): Identity<"partialUnique"> =>
		mint(
			"partialUnique",
			[relation, fields, selectionPart(where)],
			[relation, "key", ...fields, ...selectionStem(where)],
			`unique index ${fieldsOf(relation, fields)}${selectionDisplay(where)}`,
			hashed
		),
	accessIndex: (
		relation: string,
		method: "btree" | "gist" | "hnsw",
		keys: ReadonlyArray<IndexKey>,
		predicate: ReadonlyArray<Selector>
	): Identity<"accessIndex"> =>
		mint(
			"accessIndex",
			[relation, method, keys.map((k) => [k.field, k.dir, k.opclass]), selectionPart(predicate)],
			[relation, "ix", ...keys.map((k) => k.field), ...selectionStem(predicate)],
			`${method} index ${relation}(${keys.map((k) => `${k.field}${k.dir === "desc" ? " desc" : ""}${k.opclass === "default" ? "" : ` ${k.opclass}`}`).join(", ")})${selectionDisplay(predicate)}`,
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
	/** The law of a structural text domain's CHECK. */
	patternLaw: (domain: Identity<"textDomain">): Identity<"patternLaw"> =>
		mint("patternLaw", [domain], [domain.stem], `law of ${domain.display}`, hashed),
	lawFunction: (law: Identity<"law">): Identity<"lawFunction"> =>
		mint("lawFunction", [law], ["law", law.stem], `function of law ${law.display}`, hashed),
	lawTrigger: (law: Identity<"law">, relation: string): Identity<"lawTrigger"> =>
		mint(
			"lawTrigger",
			[law, relation],
			["law", law.stem],
			`trigger of law ${law.display} on ${relation}`,
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
	/** The name a migration sets a held object aside under. */
	aside: (of: string): Identity<"aside"> =>
		mint("aside", [of], ["aside", of], `${of} set aside`, hashed),
	/** The name an index is built under before it is swapped in for `of`. */
	swap: (of: string): Identity<"swap"> =>
		mint("swap", [of], ["next", of], `the next ${of}`, hashed),
	/** The name an enum's new roster is built under before it replaces `of`. */
	rebuild: (of: string): Identity<"rebuild"> =>
		mint("rebuild", [of], ["rebuild", of], `the rebuilt ${of}`, hashed),
	/** The scratch schema the drift check replays the installed schema `of` into. */
	scratch: (of: string): Identity<"scratch"> =>
		mint("scratch", [of], ["scratch", of], `scratch of ${of}`, hashed)
})
