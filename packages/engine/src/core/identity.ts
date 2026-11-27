import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isAsciiDigit } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { ConstantDigest, DomainDigest, RowTypeDigest } from "#compiler/core/fingerprint.ts"
import type { Identifier, IdentityKind } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Comparator, compareStrings, type Direction } from "#compiler/core/order.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"

/**
 * The size of PostgreSQL's name type, NAMEDATALEN, its terminating zero byte included: what an identifier and a
 * roster's handle in its names constant are held in.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope a name value, its terminating zero included: an identifier, a roster's handle
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/pg_config_manual.h#L39
 * @quote #define NAMEDATALEN 64
 * @verified 2026-11-20
 */
export const namedatalen = 64

/**
 * The longest identifier PostgreSQL keeps, in bytes: a longer one is truncated, so two names that differ past it are
 * one name.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one identifier: an object's, a column's, a role's or a temporary table's name
 * @derivation NAMEDATALEN less its terminating zero: "The system uses no more than NAMEDATALEN-1 bytes of an
 *   identifier; longer names can be written in commands, but they will be truncated."
 *   (https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/syntax.sgml#L133-L135)
 * @from {@link namedatalen}
 */
export const maxIdentifierBytes = namedatalen - 1

/**
 * The naming door: every PostgreSQL identifier grizzle installs, declared or derived, is minted here from the object's
 * structured identity, its kind and the parts that define it, and nowhere else.
 *
 * Each kind renders by one rule: readable exactly when its identity maps one-to-one into PostgreSQL's
 * maxIdentifierBytes inside the namespace PostgreSQL puts the object in, otherwise hashed, and a name never changes form for its
 * length or a collision.
 *
 * - Readable: a declared name's conversion (its segments, lowercased, joined by single underscores: the schema, tables,
 *   derived relations, rosters' domains, columns, row checks, a relation's whole view and a role's query views), a
 *   closed id's decoded column `<field>_name` beside it in a view, a login's or role's
 *   `<schema>__<name>` (a role's schema and policies take its role's), a level's schema of its relations' whole views,
 *   `__<schema>`, or a name grizzle fixes (`check` for a domain's
 *   CHECK, the per-schema singletons `__ledger` with its key and checks, its head `__ledger_head` with its key and check,
 *   `__refuse`, `__require_serializable` and
 *   `__snapshot_guard`, the per-table trigger `__isolation`). The declaration rules make each one-to-one in its
 *   namespace: declared names are compared by their conversions (`DeclaredNamespace`, every namespace of declared
 *   names: the schema's relations, rosters and contracts, each relation's or view's columns, each table's row checks,
 *   each role's views), none starts with `_`, and one whose conversion is over maxIdentifierBytes is refused; a schema's
 *   conversion does not start with `pg_`. A name a library derives (DerivedName) is compared in the same namespace by
 *   its conversion, at any length, and names no readable object. So no `__<schema>` meets a level's schema, a declared
 *   conversion, or a role's,
 *   `<schema>__<name>`, which starts as its level's does. A readable constructor takes the name parsed (`DeclaredName`,
 *   minted by `parseDeclaredName`; `SchemaName`, by `parseSchemaName`), so no readable identity has a name the rule
 *   refuses; a login's or role's name is refused when it does not fit with its schema's, and a level's schema of whole
 *   views when it does not fit with its lead (physical/ddl/names.ts).
 * - Hashed: `__`, a readable stem cut to `stemBudget` bytes at a segment boundary, `_` and a digest of the identity's
 *   canonical encoding, the first `5 * digestChars` bits of its SHA-256 as `digestChars` characters of lowercase RFC
 *   4648 base32: keys, foreign keys, span, norm and law checks, indexes, declared dependencies, contract and
 *   text-pattern domains, named by their definitions, constants, sets' domains, law and arm tag columns, laws and their functions and triggers, filter functions, key and unique probes,
 *   a migration's temporaries, and the table and whole view of a relation, and the domain and whole view of a roster,
 *   whose name a library derives, each named by that name, which its schema's namespace keeps unique (derivedTable,
 *   derivedWholeView, derivedRosterDomain).
 *   Every name grizzle derives starts with `__`, so no declared name meets
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

/** A hashed name's lead, `__`, which no declared name has. */
const hashedLead = "__"
/** The separator of a hashed name's stem and its digest. */
const digestSeparator = "_"
/** The first segment of the stem of a name a migration sets an object or a role aside under (identity.aside,
 * identity.roleAside). */
const asideSegment = "aside"
/** The first segment of the stem of an installation's live source's name (identity.liveSource). */
const liveSegment = "live"
/** The first segment of the stem of an installation's function owner's name (identity.functionOwner). */
const ownerSegment = "owner"
/** The separator of a role prefix and the name of the role it leads, `<prefix>__<name>` (roleInSpace). */
const roleSeparator = "__"

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
 * The bytes a hashed name's stem may take: the longest identifier (maxIdentifierBytes) less its lead, its separator and
 * its digest. No limit of its own: PostgreSQL's identifier length read against the hashed name's format, whose widths
 * are the format's.
 */
const stemBudget: number =
	maxIdentifierBytes - hashedLead.length - digestSeparator.length - digestChars

/**
 * The bytes an installation's role prefix may take: what the longest identifier leaves of `<prefix>__<name>` once the
 * longest hashed name the naming door mints for a cluster role has its bytes: the installation's decoder login's,
 * `__live_<digest>` (identity.liveSource), or a role's set aside while logins are renamed, `__aside_<digest>`
 * (identity.roleAside). Their stems are their lead words alone and their digests are of the whole identity, which
 * tells one installation's or one role's from another's, so their length is the same whatever the names they are of,
 * and the budget a constant. So every prefix within it leads the installation's decoder login and every
 * role set aside within maxIdentifierBytes, whatever the installation's names: a prefix too long for them is refused
 * where it is parsed (parseRolePrefix), before any connection or statement, never by a migration's statement. A
 * login's or a role's own name, which its declared names lengthen, is held to maxIdentifierBytes under the longest
 * prefix its configuration declares (RolePrefixBound) before generate writes anything, and with the prefix itself
 * where the role is named (roleInSpace). No limit of its own: maxIdentifierBytes less `<prefix>__<name>`'s separator
 * and the longest hashed role name, `__aside_<digest>`, each a width of the naming door's format.
 */
export const maxRolePrefixBytes: number =
	maxIdentifierBytes -
	roleSeparator.length -
	(hashedLead.length +
		Math.max(liveSegment.length, asideSegment.length, ownerSegment.length) +
		digestSeparator.length +
		digestChars)

/** One part of an identity: a text, a list of parts, or a nested identity. */
export type Part = string | ReadonlyArray<Part> | Identity<IdentityKind>

/** How a kind spells its identifier: readable, or hashed (`__<stem>_<digest>`). */
type Form = "readable" | "hashed"

/** An identity, minted by its kind's constructor below: the parts that define it, its canonical encoding, its stem's
 * segments and the stem they join to, display, the form its kind renders in, and its identifier. */
export interface Identity<K extends IdentityKind> {
	readonly kind: K
	readonly parts: ReadonlyArray<Part>
	readonly canonical: string
	/** The stem's segments, as cut to the stem's budget: what an identity named for this one extends its stem by. */
	readonly segments: ReadonlyArray<string>
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
	let bits =
		BigInt(`0x${sha256Hex(wellFormed(canonical)).slice(0, digestHexChars)}`) >> digestDropped
	let out = ""
	for (let i = 0; i < digestChars; i++) {
		out = base32.charAt(Number(bits & 31n)) + out
		bits >>= 5n
	}
	return out
}

const isUpper = (ch: string): boolean => ch >= "A" && ch <= "Z"
const isLower = (ch: string): boolean => ch >= "a" && ch <= "z"

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
		if (!(isUpper(ch) || isLower(ch) || isAsciiDigit(ch.charCodeAt(0)))) {
			flush()
			continue
		}
		const prev = chars[i - 1] ?? ""
		const next = chars[i + 1] ?? ""
		const boundary =
			current !== "" &&
			((isAsciiDigit(ch.charCodeAt(0)) && !isAsciiDigit(prev.charCodeAt(0))) ||
				(!isAsciiDigit(ch.charCodeAt(0)) && isAsciiDigit(prev.charCodeAt(0))) ||
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

/** The conversion of segments a name or a stem split into: joined by single underscores. */
const joined = (segments: ReadonlyArray<string>): string => segments.join("_")

/**
 * The conversion of a name: its segments, lowercased, joined by single underscores. A declared name's is its readable
 * identifier. The package root exports it beside parseDeclaredName, so a generator that writes declared names (den's
 * lowering) reads a name's segments and compares two names as grizzle's namespaces do, never by a rule of its own.
 */
export const conversionOf = (name: string): string => joined(nameSegments(name))

declare const declaredNameBrand: unique symbol
declare const derivedNameBrand: unique symbol
declare const schemaNameBrand: unique symbol

/** A name as declared that keeps the declared-name rule, minted only by `parseDeclaredName`: what every readable
 * identity's constructor takes. */
export type DeclaredName = string & { readonly [declaredNameBrand]: true }

/**
 * A name a library derives for a relation or roster (ir/desc.ts RelationNaming and RosterNaming `derived`: the package
 * root's derivedName, and records' own, program/records.ts), minted only by `parseDerivedName`: a declared name's
 * characters at any length, since no identifier is its conversion. The door names the objects it installs hashed over
 * it (identity.derivedTable, identity.derivedWholeView, identity.derivedRosterDomain), so no readable constructor takes
 * one.
 */
export type DerivedName = string & { readonly [derivedNameBrand]: true }

/**
 * A relation's or roster's name as its schema's namespace took it (DeclaredNamespace): a declared name, or a name a
 * library derives. Two of either kind that convert alike are one name of the namespace.
 */
export type HeldName = DeclaredName | DerivedName

/** A schema's declared name that keeps the schema's rule besides, minted only by `parseSchemaName`. */
export type SchemaName = DeclaredName & { readonly [schemaNameBrand]: true }

const declaredNameOf = nominal<string, DeclaredName>()
const derivedNameOf = nominal<string, DerivedName>()
const schemaName = nominal<DeclaredName, SchemaName>()

/**
 * The characters a declared name is written in: ASCII letters, digits and underscores, a letter first (`__` belongs to
 * grizzle's own names). A scope's name keeps them alone, since it names a rule's variables and never a PostgreSQL
 * identifier, as its type does (types/core/phantom.ts DeclaredName); a declared name keeps them and the rest of
 * parseDeclaredName's rule. The name, or the reason it breaks the rule.
 */
export const parseNameCharacters = (name: string): Result.Result<string, string> => {
	for (const ch of name) {
		if (!(isUpper(ch) || isLower(ch) || isAsciiDigit(ch.charCodeAt(0)) || ch === "_")) {
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
	if (isAsciiDigit(name.charCodeAt(0))) {
		return Result.err("a name not starting with a digit")
	}
	return Result.ok(name)
}

/** A declared name parsed, with its conversion, read once as the name is parsed. */
interface ParsedName {
	readonly name: DeclaredName
	readonly conversion: string
}

/**
 * How a name breaks the declared-name rule: its characters (parseNameCharacters's reason), or its conversion, the
 * identifier PostgreSQL would be given, whose `bytes` pass maxIdentifierBytes, which PostgreSQL would cut short.
 */
export type NameFault =
	| { readonly kind: "characters"; readonly why: string }
	| { readonly kind: "length"; readonly conversion: string; readonly bytes: number }

/** How a schema's declared name breaks its rule: as any declared name does (NameFault), or by a conversion starting
 * with `pg_`, which PostgreSQL reserves. */
export type SchemaNameFault = NameFault | { readonly kind: "reserved"; readonly conversion: string }

/**
 * The declared-name rule, the one judgement of a name every declaration of one reads (`parseDeclaredName`,
 * `admitDeclaredName`, `parseSchemaName`, `DeclaredNamespace`): its characters (parseNameCharacters), then its
 * conversion within maxIdentifierBytes. The name parsed, with its conversion, or how it breaks the rule.
 */
const parsedName = (name: string): Result.Result<ParsedName, NameFault> => {
	const named = parseNameCharacters(name)
	if (!named.ok) {
		return Result.err({ kind: "characters", why: named.error })
	}
	const conversion = conversionOf(named.value)
	const bytes = utf8Length(conversion)
	return bytes > maxIdentifierBytes
		? Result.err({ kind: "length", conversion, bytes })
		: Result.ok({ name: declaredNameOf(named.value), conversion })
}

/** A name fault as the rule states it. */
export const nameFaultText = (fault: SchemaNameFault): string => {
	switch (fault.kind) {
		case "characters":
			return fault.why
		case "length":
			return `a name whose conversion fits ${maxIdentifierBytes} bytes; its conversion ${fault.conversion} takes ${fault.bytes}`
		case "reserved":
			return `a name whose conversion does not start with pg_, which PostgreSQL reserves; its conversion ${fault.conversion} starts with it`
	}
}

/**
 * A name fault as the refusal of `declaration` (a kind and a name: `roster name "CatalogSyncNodesKind"`) at `loc`:
 * IdentifierTooLong, naming the identifier PostgreSQL would cut short and its bytes, for a conversion past
 * maxIdentifierBytes; MalformedDescription, the rule's statement of it, for any other.
 */
const faultRefusal = (fault: SchemaNameFault, declaration: string, loc: SourceLoc): CompileError =>
	fault.kind === "length"
		? CompileError.make({
				_tag: "IdentifierTooLong",
				at: loc,
				declaration,
				identifier: fault.conversion,
				bytes: fault.bytes,
				limit: maxIdentifierBytes
			})
		: malformedDescription(loc, `the declared ${declaration} as ${nameFaultText(fault)}`)

/**
 * The rule a declared name keeps: its characters' (parseNameCharacters), and a conversion (its segments, lowercased,
 * joined by single underscores) within maxIdentifierBytes. Two declared names of one namespace whose conversions agree are one
 * name, which the declaring passes refuse (`DeclaredNamespace`). The name, parsed, or how it breaks the rule
 * (`nameFaultText` states it). The package root exports it, so a generator that writes declared names (den's lowering)
 * judges each by this rule where it derives it, never by a rule of its own.
 */
export const parseDeclaredName = (name: string): Result.Result<DeclaredName, NameFault> =>
	Result.map(parsedName(name), (parsed) => parsed.name)

/**
 * The rule a name a library derives keeps (DerivedName): a declared name's characters (parseNameCharacters), at any
 * length, the rule every relation's or roster's name keeps, so a lookup of one by its text parses it so. The name,
 * parsed, or how it breaks the rule, its characters.
 */
export const parseDerivedName = (name: string): Result.Result<DerivedName, NameFault> => {
	const named = parseNameCharacters(name)
	return named.ok
		? Result.ok(derivedNameOf(named.value))
		: Result.err({ kind: "characters", why: named.error })
}

/**
 * A name a library derives admitted where its relation or roster is built, `declaration` (its kind and name) at `loc`:
 * the name, parsed by the derived-name rule (parseDerivedName), or its refusal, MalformedDescription for its characters.
 */
export const admitDerivedName = (
	name: string,
	declaration: string,
	loc: SourceLoc
): Result.Result<DerivedName, CompileError> =>
	Result.mapError(parseDerivedName(name), (fault) => faultRefusal(fault, declaration, loc))

/**
 * A declared name admitted where it is written, `declaration` (its kind and name) at `loc`: the name, parsed by the
 * declared-name rule, or its refusal (`faultRefusal`), IdentifierTooLong for an identifier PostgreSQL would cut short.
 * Every builder that takes a declared name admits it here (schema/protocol.ts requireDeclaredName), so a name past
 * PostgreSQL's identifiers is refused where it is written, never where a later stage reads it; ownership declares it by
 * the same rule (DeclaredNamespace).
 */
export const admitDeclaredName = (
	name: string,
	declaration: string,
	loc: SourceLoc
): Result.Result<DeclaredName, CompileError> =>
	Result.mapError(parseDeclaredName(name), (fault) => faultRefusal(fault, declaration, loc))

/**
 * The rule a schema's declared name keeps: `parseDeclaredName`'s, and a conversion not starting with `pg_`, which
 * PostgreSQL reserves in the two namespaces the conversion leads in, its schemas' (the installed schema, each role's
 * schema) and its roles' (each login's and role's `<schema>__<name>`). The name, parsed, or how it breaks the rule.
 */
export const parseSchemaName = (name: string): Result.Result<SchemaName, SchemaNameFault> =>
	Result.flatMap(
		parsedName(name),
		({ name: declared, conversion }): Result.Result<SchemaName, SchemaNameFault> =>
			conversion.startsWith("pg_")
				? Result.err({ kind: "reserved", conversion })
				: Result.ok(schemaName(declared))
	)

/**
 * A schema's declared name admitted where it is declared, at `loc`: the name, parsed by the schema's rule
 * (parseSchemaName), or its refusal (`faultRefusal`), IdentifierTooLong for an identifier PostgreSQL would cut short.
 */
export const admitSchemaName = (
	name: string,
	loc: SourceLoc
): Result.Result<SchemaName, CompileError> =>
	Result.mapError(parseSchemaName(name), (fault) =>
		faultRefusal(fault, `schema name ${JSON.stringify(name)}`, loc)
	)

declare const rolePrefixBrand: unique symbol

/** An installation's role prefix, verbatim as its connection gives it: minted only by `parseRolePrefix`. */
export type RolePrefix = string & { readonly [rolePrefixBrand]: true }

const rolePrefixOf = nominal<string, RolePrefix>()

/**
 * Why a text is no role prefix: not a string; empty; a character outside lowercase ASCII letters, digits and `_`; a
 * digit first; a `__`, the separator a prefix must not forge; `pg_` first, which PostgreSQL reserves for its own roles;
 * or longer than maxRolePrefixBytes, past which the decoder login or a role set aside would not fit under it.
 */
export type RolePrefixFault =
	| { readonly kind: "notText" }
	| { readonly kind: "empty" }
	| { readonly kind: "character"; readonly at: number; readonly character: string }
	| { readonly kind: "digitFirst" }
	| { readonly kind: "separator" }
	| { readonly kind: "reserved" }
	| { readonly kind: "length"; readonly bytes: number; readonly limit: number }

/** What a role prefix fault asks of the prefix, as a refusal states it. */
export const rolePrefixFaultText = (fault: RolePrefixFault): string => {
	switch (fault.kind) {
		case "notText":
			return "a string"
		case "empty":
			return "at least one character"
		case "character":
			return `lowercase ASCII letters, digits and _ alone, not ${JSON.stringify(fault.character)} at ${fault.at}`
		case "digitFirst":
			return "a letter or _ first, not a digit"
		case "separator":
			return "no __, the separator of a prefix and its role's stem"
		case "reserved":
			return "a first segment other than pg_, which PostgreSQL reserves for its own roles"
		case "length":
			return `at most ${fault.limit} bytes, not ${fault.bytes}, so the installation's decoder login and a role set aside fit under it within PostgreSQL's ${maxIdentifierBytes}`
	}
}

/** Whether `code` is a lowercase ASCII letter, a digit or `_`: a character of a lowercase PostgreSQL identifier. */
const isPrefixUnit = (code: number): boolean =>
	(code >= 0x61 && code <= 0x7a) || isAsciiDigit(code) || code === 0x5f

/**
 * The rule a role prefix keeps, used verbatim, never converted: a lowercase PostgreSQL identifier segment,
 * `[a-z_][a-z0-9_]*`, holding no `__`, so `<prefix>__<stem>` parts at its first `__` past the prefix, not starting with
 * `pg_`, and within maxRolePrefixBytes, so the hashed role names fit under it. Each role it leads is held to
 * maxIdentifierBytes with its name (roleInSpace). The prefix, as given, or the fault it breaks the rule by.
 */
export const parseRolePrefix = (prefix: string): Result.Result<RolePrefix, RolePrefixFault> => {
	if (prefix === "") {
		return Result.err({ kind: "empty" })
	}
	for (let at = 0; at < prefix.length; at++) {
		const code = prefix.charCodeAt(at)
		if (!isPrefixUnit(code)) {
			return Result.err({ kind: "character", at, character: prefix.charAt(at) })
		}
	}
	const first = prefix.charCodeAt(0)
	if (isAsciiDigit(first)) {
		return Result.err({ kind: "digitFirst" })
	}
	if (prefix.includes("__")) {
		return Result.err({ kind: "separator" })
	}
	if (prefix.startsWith("pg_")) {
		return Result.err({ kind: "reserved" })
	}
	const bytes = utf8Length(prefix)
	return bytes > maxRolePrefixBytes
		? Result.err({ kind: "length", bytes, limit: maxRolePrefixBytes })
		: Result.ok(rolePrefixOf(prefix))
}

/**
 * Where an installation's roles live in the cluster, whose roles every database shares: at their stems, the names a
 * login's or role's identity spells (`identity.login`, `identity.role`), which `grizzle generate` commits; or each under
 * the installation's role prefix, verbatim, `<prefix>__<stem>`. A stem is two conversions joined by its one `__`, a
 * letter first, and a prefix holds no `__`, so two prefixes part before the first `__` of either name and no prefixed
 * name is a stem: the roles of two installations of distinct role spaces are disjoint.
 */
export type RoleSpace =
	| { readonly kind: "stems" }
	| { readonly kind: "prefixed"; readonly prefix: RolePrefix }

/**
 * An installation as a caller names it outside a connection: a connection block (DbConnection) or any part of one,
 * the database and the role prefix that identify it, of which roleNameOf reads the prefix; one without a prefix installs
 * its roles at their stems.
 */
export interface RoleInstallation {
	readonly database?: string
	readonly rolePrefix?: string
}

/** A role space of the installation's role prefix, or of its stems with none: the one reading of an installation's
 * `rolePrefix`, refused as parseRolePrefix refuses it. */
export const roleSpaceOf = (
	rolePrefix: string | undefined
): Result.Result<RoleSpace, RolePrefixFault> =>
	rolePrefix === undefined
		? Result.ok({ kind: "stems" })
		: Result.map(parseRolePrefix(rolePrefix), (prefix) => ({ kind: "prefixed", prefix }))

/** An installed role past PostgreSQL's maxIdentifierBytes, which no installation can create or log in as: the role,
 * its bytes and the limit. */
export interface InstalledRoleTooLong {
	readonly role: string
	readonly bytes: number
	readonly limit: number
}

/** The bytes of the PostgreSQL role `<prefix>__<name>` for a prefix of `prefixBytes` bytes: the one count of a prefixed
 * role's bytes, which roleInSpace and longestRoleBytes read. */
const prefixedBytes = (prefixBytes: number, name: string): number =>
	prefixBytes + roleSeparator.length + utf8Length(name)

/**
 * The PostgreSQL role the installation of role space `space` installs for the role the naming door names `name`, in
 * any of its forms (RoleNameForm), or its refusal past maxIdentifierBytes: the one place a cluster role's name is
 * made from a minted one. A minted name fits by its minting (fitted, the hashed form's budget), so only a prefix
 * lengthens it; a hashed role name never past it, since a prefix is within maxRolePrefixBytes.
 */
export const roleInSpace = (
	space: RoleSpace,
	name: string
): Result.Result<string, InstalledRoleTooLong> => {
	if (space.kind === "stems") {
		return Result.ok(name)
	}
	const role = `${space.prefix}${roleSeparator}${name}`
	const bytes = prefixedBytes(utf8Length(space.prefix), name)
	return bytes > maxIdentifierBytes
		? Result.err({ role, bytes, limit: maxIdentifierBytes })
		: Result.ok(role)
}

declare const rolePrefixBoundBrand: unique symbol

/**
 * The bytes of the longest role prefix any installation of one configuration is under (GrizzleConfig
 * `rolePrefixBytes`), a fact of its deployment: 0 where every installation's roles are at their stems, as a production
 * database's alone on its cluster, else the bytes of the longest prefix one is under, as a test harness's that installs
 * each case under a prefix of its own. An integer from 0 to maxRolePrefixBytes, minted only by parseRolePrefixBound.
 */
export type RolePrefixBound = number & { readonly [rolePrefixBoundBrand]: true }

const rolePrefixBoundOf = nominal<number, RolePrefixBound>()

/** A configuration's `rolePrefixBytes`, read as its RolePrefixBound, or undefined for a value that is no integer from 0
 * to maxRolePrefixBytes. */
export const parseRolePrefixBound = (value: unknown): RolePrefixBound | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxRolePrefixBytes
		? rolePrefixBoundOf(value)
		: undefined

/**
 * The bytes of the longest PostgreSQL role the role the naming door names `name` installs as in an installation whose
 * role space is within `bound` (prefixPastBound): the name alone under a bound of 0, every role at its stem, else the
 * name under a prefix of the bound's bytes (roleInSpace), longer than at its stem. A configuration's roles that fit
 * maxIdentifierBytes so are each installed whole under every role space within its bound.
 */
export const longestRoleBytes = (bound: RolePrefixBound, name: string): number =>
	bound === 0 ? utf8Length(name) : prefixedBytes(bound, name)

/** The bytes of role space `space`'s prefix where they pass `bound`; undefined where the space is within it, its roles
 * at their stems or under a prefix of at most the bound's bytes. */
export const prefixPastBound = (space: RoleSpace, bound: RolePrefixBound): number | undefined => {
	if (space.kind === "stems") {
		return undefined
	}
	const bytes = utf8Length(space.prefix)
	return bytes > bound ? bytes : undefined
}

/** Whether `text` is a declared name's conversion, as the naming door spells one: what a stem's two parts each are. */
const isConversion = (text: string): boolean => parsedName(text).ok && conversionOf(text) === text

/**
 * The forms a drafted statement names a role of the installation in, each the identifier the naming door mints: a
 * login's or role's stem, `<schema>__<name>`, two conversions joined by their one `__` (identity.login, identity.role);
 * the name a migration sets a role aside under while it renames logins (identity.roleAside), hashed, `__aside_<digest>`;
 * the installation's live source's, its decoder login's (identity.liveSource), hashed, `__live_<digest>`; or the
 * installation's function owner's (identity.functionOwner), hashed, `__owner_<digest>`. A hashed
 * role name's stem is its lead word alone (maxRolePrefixBytes), so its form is read by its lead and its digest, with no
 * segment of any name to read back.
 *
 * These are the forms every committed folder holds: a folder is history, its files' digests in the installation's
 * ledger, and migrate reads all of them (adapter/migrate/input.ts), and no folder names a role in any other.
 */
export type RoleNameForm = "stem" | "aside" | "liveSource" | "functionOwner"

/** Whether `text` is a hashed name's digest: digestChars characters of lowercase base32. */
const isDigest = (text: string): boolean =>
	text.length === digestChars && Array.from(text).every((ch) => base32.includes(ch))

/** The form `name` names a role of the installation in, or undefined for any other text. */
export const roleNameForm = (name: string): RoleNameForm | undefined => {
	const at = name.indexOf("__")
	if (at > 0 && isConversion(name.slice(0, at)) && isConversion(name.slice(at + 2))) {
		return "stem"
	}
	const digestAt = name.length - digestChars
	const lead = name.slice(hashedLead.length, digestAt - digestSeparator.length)
	if (
		!name.startsWith(hashedLead) ||
		utf8Length(name) > maxIdentifierBytes ||
		name.slice(digestAt - digestSeparator.length, digestAt) !== digestSeparator ||
		!isDigest(name.slice(digestAt))
	) {
		return undefined
	}
	if (lead === asideSegment) {
		return "aside"
	}
	if (lead === ownerSegment) {
		return "functionOwner"
	}
	return lead === liveSegment ? "liveSource" : undefined
}

/**
 * The stem of the cluster role `role` when it lies in the namespace of an installation of role space `space` whose
 * levels' PostgreSQL schemas are `levels`: `<level>__<conversion>` under the space (roleInSpace), the names its
 * migrations can create, a login's or a role's of any of its snapshots; undefined for every other role, another
 * installation's, another space's or none's. A conversion holds no `__`, so the parts are read without guessing.
 */
const namespaceStem = (
	space: RoleSpace,
	levels: ReadonlySet<string>,
	role: string
): string | undefined => {
	const lead = space.kind === "stems" ? "" : `${space.prefix}__`
	if (!role.startsWith(lead)) {
		return undefined
	}
	const stem = role.slice(lead.length)
	const at = stem.indexOf("__")
	return at > 0 && levels.has(stem.slice(0, at)) && isConversion(stem.slice(at + 2))
		? stem
		: undefined
}

/**
 * A cluster role an installation creates, by what it is: a login's or a role's, by its stem (namespaceStem); the
 * decoder login of the live source of the level whose PostgreSQL schema is `level` (identity.liveSource); or the
 * function owner of that level (identity.functionOwner).
 */
export type InstallationRole =
	| { readonly kind: "stem"; readonly stem: string }
	| { readonly kind: "liveSource"; readonly level: string }
	| { readonly kind: "functionOwner"; readonly level: string }

/**
 * The one reading of the roles an installation of role space `space` creates in the cluster, whose levels' PostgreSQL
 * schemas are `levels`: a classifier of a cluster role as one of them (InstallationRole), or undefined for every other
 * role, another installation's, another space's or none's. Every role an installation's migrations create is a stem
 * under the space, `<level>__<conversion>`, or one of the hashed roles minted from a level's schema, its live source's
 * decoder login and its function owner, under the space (roleInSpace); a migration's renames set a role aside only
 * inside the migration's transaction (identity.roleAside), so no role aside outlives one. What collects an
 * installation's roles, uninstall's and a test template's sweep, reads it, and nothing else names them.
 */
export const installationRoleOf = (
	space: RoleSpace,
	levels: ReadonlySet<string>
): ((role: string) => InstallationRole | undefined) => {
	const hashedRoles = new Map<string, InstallationRole>()
	for (const level of levels) {
		for (const [kind, minted] of [
			["liveSource", identity.liveSource(level)],
			["functionOwner", identity.functionOwner(level)]
		] as const) {
			const role = roleInSpace(space, identifierOf(minted))
			if (role.ok) {
				hashedRoles.set(role.value, { kind, level })
			}
		}
	}
	return (role) => {
		const stem = namespaceStem(space, levels, role)
		return stem === undefined ? hashedRoles.get(role) : { kind: "stem", stem }
	}
}

/** Whether two names, declared or derived, are one name of a namespace: their segments agree, so the door renders both
 * as one conversion (TaskNote, Task_Note and task_note). */
export const declaredAlike = (a: HeldName, b: HeldName): boolean =>
	conversionOf(a) === conversionOf(b)

/**
 * The columns PostgreSQL holds in every table before any it declares, its system columns
 * (src/backend/catalog/heap.c, the SysAtt it reads by SystemAttributeByName): a table that declares
 * a column of one of their names is refused, 42701 "column name ... conflicts with a system column name". Every name
 * grizzle derives for a column of its own, a law column's or a hidden accumulator's, starts with `__` (hashedLead), so
 * none is one of them.
 */
const systemColumns: ReadonlySet<string> = new Set([
	"ctid",
	"xmin",
	"cmin",
	"xmax",
	"cmax",
	"tableoid"
])

/** No name PostgreSQL holds: a namespace of declared names other than a relation's columns. */
const noneHeld: ReadonlySet<string> = new Set()

/**
 * One PostgreSQL namespace of declared names: the schema's relations, rosters and contracts; a table's, closed
 * relation's, derived relation's or role view's columns; a table's row checks; a role's views. It holds each conversion
 * taken, with the declaration that took it and where, beside the names PostgreSQL holds there before any declaration
 * (`held`): a relation's columns its system columns (`columns`), which every table a relation may
 * install as holds, and no other namespace any. The door renders a declared name as its conversion, so two
 * declarations of one conversion would be one identifier: they are one name declared twice; and a declaration of a
 * conversion PostgreSQL holds would be an identifier it refuses.
 */
export class DeclaredNamespace {
	readonly #what: string
	readonly #held: ReadonlySet<string>
	readonly #taken = new Map<string, { readonly declaration: string; readonly loc: SourceLoc }>()

	private constructor(what: string, held: ReadonlySet<string>) {
		this.#what = what
		this.#held = held
	}

	/** A namespace PostgreSQL holds no name in, `what` naming it in a refusal: "relation Task's check". */
	static of(what: string): DeclaredNamespace {
		return new DeclaredNamespace(what, noneHeld)
	}

	/** A relation's columns, `what` naming them in a refusal ("relation Task's field"), PostgreSQL's system columns held. */
	static columns(what: string): DeclaredNamespace {
		return new DeclaredNamespace(what, systemColumns)
	}

	/**
	 * Declares `name`, a `kind` (relation, field, check...) at `loc`: the name, parsed, or its refusal,
	 * IdentifierTooLong for a conversion past maxIdentifierBytes, MalformedDescription for a name whose characters
	 * `parseDeclaredName` refuses or whose conversion PostgreSQL holds in the namespace,
	 * and IdentifierCollision, with both places, for a name whose conversion an earlier declaration took, the same name
	 * declared twice included.
	 */
	declare(name: string, kind: string, loc: SourceLoc): Result.Result<DeclaredName, CompileError> {
		const parsed = parsedName(name)
		if (!parsed.ok) {
			return Result.err(faultRefusal(parsed.error, `${kind} name ${JSON.stringify(name)}`, loc))
		}
		return Result.map(this.#take(name, parsed.value.conversion, kind, loc), () => parsed.value.name)
	}

	/**
	 * Declares `name`, a name a library derives for a `kind` at `loc` (DerivedName), into the same namespace as every
	 * declared name: the name, parsed by the derived-name rule (parseDerivedName), at any length, since it names no
	 * identifier, or its refusal: MalformedDescription for its characters or a conversion PostgreSQL holds, and
	 * IdentifierCollision for a conversion an earlier declaration took, a declared name's or a derived one's, as
	 * `declare` refuses it.
	 */
	declareDerived(
		name: string,
		kind: string,
		loc: SourceLoc
	): Result.Result<DerivedName, CompileError> {
		const parsed = parseDerivedName(name)
		if (!parsed.ok) {
			return Result.err(faultRefusal(parsed.error, `${kind} name ${JSON.stringify(name)}`, loc))
		}
		return Result.map(this.#take(name, conversionOf(parsed.value), kind, loc), () => parsed.value)
	}

	/**
	 * Takes `conversion`, the conversion of `name`, a `kind` at `loc`, or refuses it: MalformedDescription where
	 * PostgreSQL holds it in the namespace, IdentifierCollision where an earlier declaration took it.
	 */
	#take(
		name: string,
		conversion: string,
		kind: string,
		loc: SourceLoc
	): Result.Result<string, CompileError> {
		if (this.#held.has(conversion)) {
			return Result.err(
				malformedDescription(
					loc,
					`the declared ${kind} name ${JSON.stringify(name)} as a name whose conversion is none of PostgreSQL's system columns, which every table holds (${[...this.#held].join(", ")}); its conversion ${conversion} is one`
				)
			)
		}
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
		return Result.ok(conversion)
	}
}

/**
 * The segments of an identity's stem: the segments of its names and words, led by the kind's words unless a letter
 * leads, up to the last whose join by single underscores fits the budget (the first cut to the budget itself when it is
 * longer). A segment is ASCII letters or digits (nameSegments), one byte a character.
 */
const stemSegments = (
	kind: IdentityKind,
	segments: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const led = isLower(segments[0]?.charAt(0) ?? "")
		? segments
		: [...nameSegments(kind), ...segments]
	const stem: Array<string> = []
	let bytes = 0
	for (const segment of led) {
		const next = stem.length === 0 ? segment.length : bytes + 1 + segment.length
		if (next > stemBudget) {
			return stem.length === 0 ? [segment.slice(0, stemBudget)] : stem
		}
		stem.push(segment)
		bytes = next
	}
	return stem
}

const brand = <K extends IdentityKind>(text: string): Identifier<K> =>
	nominal<string, Identifier<K>>()(text)

/**
 * The one minter of an identifier: an identity of `kind` over `parts`, stemmed from `stem`, the segments of the names and
 * words that stem it, each name split once by its constructor (a nested identity's are its own `segments`), shown as
 * `display`, and spelled as its kind renders.
 */
const mint = <K extends IdentityKind>(
	kind: K,
	parts: ReadonlyArray<Part>,
	stem: ReadonlyArray<string>,
	display: string,
	rendering: Rendering
): Identity<K> => {
	const canonical = `${kind}(${parts.map(encodePart).join("")})`
	const segments = stemSegments(kind, stem)
	const stemText = joined(segments)
	return Object.freeze({
		kind,
		parts,
		canonical,
		segments,
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

/**
 * What the COMMENT of every judged table's stand-up begins with (identity.ruleStandUp's display, displayOf), and the
 * COMMENT of no other object: by it a custom migration's data step finds the stand-ups the catalog holds where it runs
 * (adapter/migrate/apply.ts installedStandUps), as it finds the guards by their trigger's one name.
 */
export const standUpDisplayLead = "the stand-up of the rule judge's session tables a write of "

/**
 * The name of the installation's re-check of a data step in each schema of its levels (identity.dataStepRecheck), by
 * which a custom migration's data step finds every one the catalog holds where it runs (adapter/migrate/apply.ts
 * installedRechecks).
 */
export const dataStepRecheckName = "__recheck"

export const identifierOf = <K extends IdentityKind>(identity: Identity<K>): Identifier<K> =>
	identity.identifier

/**
 * The replication slot of a live source in database `database`: the source's identifier `stem` (identity.liveSource,
 * served/forms.ts ServedLive stem), `_`, and the digest of the database's name, `__live_<digest>_<digest>`, 28 bytes. A
 * slot's name is the cluster's and a logical slot is its database's, so two databases holding one installation on one
 * cluster (two clones of one template, staging beside production) each make their own, where a slot named by the
 * installation alone was one name for both and a database's leader met the other's slot (42710, TESTRESET4,
 * 2026-11-23, test/pg/net/network.test.ts on clones of one template). No role space leads it: within its database the
 * stem alone names the installation, whose root schema is the database's one of that name. Every drop of a database's
 * slot of the source finds it by the stem and `_` in that database (physical/ddl/live.ts dropLiveSlot,
 * adapter/migrate/uninstall.ts), which no other source's slot begins with, its stem of a length of its own.
 */
export const liveSlotOf = (stem: string, database: string): string =>
	`${liveSlotLead(stem)}${digestOf(`database(${encodePart(database)})`)}`

/** What the slot of the live source `stem` begins with in every database (liveSlotOf): the stem and `_`. */
export const liveSlotLead = (stem: string): string => `${stem}${digestSeparator}`

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
 * The first two distinct contents of one identifier among `named`, in their order, when there are two: what a digest
 * collision is, since every hashed identifier is its identity's stem and digest, and every content-addressed key its
 * content's digest.
 */
const firstCollision = <N extends { readonly identifier: string; readonly canonical: string }>(
	named: Iterable<N>
): readonly [N, N] | undefined => {
	const seen = new Map<string, N>()
	for (const i of named) {
		const prior = seen.get(i.identifier)
		if (prior !== undefined && prior.canonical !== i.canonical) {
			return [prior, i]
		}
		seen.set(i.identifier, i)
	}
	return undefined
}

/**
 * The digest of a content, `canonical` its canonical text, as a hashed name ends in its identity's: digestChars
 * characters of lowercase base32, the first 5 * digestChars bits of its SHA-256 (digestOf). The one rendering of a
 * digest grizzle names a thing by, a hashed object's and a content-addressed key's alike (physical/planned/graph.ts
 * PlannedReachKey), whose table's keys `contentCensus` holds apart.
 */
export const contentDigest = (canonical: string): string => digestOf(canonical)

/** A content a key of one table names: its key (contentDigest of `canonical`), its canonical text, and its display. */
export interface ContentKey {
	readonly key: string
	readonly canonical: string
	readonly display: string
}

/**
 * The census of one table's content-addressed keys, or its refusal: two distinct contents of one key, which the digest's
 * width makes rare, never impossible, refused as DigestCollision naming both, as censusOf refuses two hashed identities
 * of one identifier.
 */
export const contentCensus = (
	keys: ReadonlyArray<ContentKey>
): Result.Result<void, CompileError> => {
	const collision = firstCollision(keys.map((k) => ({ ...k, identifier: k.key })))
	if (collision !== undefined) {
		const [first, second] = collision
		return Result.err(digestCollision(first.key, first.display, second.display))
	}
	return Result.ok(undefined)
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
export type TemporaryKind = Extract<IdentityKind, "aside" | "roleAside" | "swap">

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

/**
 * Where a parameter's value of a pattern stands: a scalar parameter, by its `name`, or the `field` of a relation
 * parameter's facts, the parameter by its `name`. A refusal by its pattern names it as this data: a parameter's or a
 * field's name may hold any character, a `.` among them, so no text joining the two names one place alone.
 */
export type ParamPlace =
	| { readonly kind: "scalar"; readonly name: string }
	| { readonly kind: "field"; readonly name: string; readonly field: string }

/** A parameter place as a message spells it: the parameter, or `<parameter>.<field>`, which no reader parses. */
export const paramPlaceText = (place: ParamPlace): string =>
	place.kind === "scalar" ? place.name : `${place.name}.${place.field}`

/** A side of a foreign key: its relation and its columns in order. */
export interface KeySide {
	readonly relation: string
	readonly fields: ReadonlyArray<KeyColumnName>
}

/** The access methods of an index grizzle installs: B-tree, GiST, pgvector's HNSW, hash and GIN. */
export type IndexMethod = "btree" | "gist" | "hnsw" | "hash" | "gin"

/**
 * The parts of a stored relation's upkeep, each a function of the judge of its own (identity.storedUpkeep, physical/ddl
 * rules.ts upkeepBlock), run where a delta its statements read holds a row, in this order: a unit form's rows at the
 * units a transaction wrote made its definition's rows there (`units`); a delta form's removal of the facts a write
 * withdraws (`lost`), then its insert of the facts it gains (`gained`).
 */
export const upkeepParts = ["units", "lost", "gained"] as const
export type UpkeepPart = (typeof upkeepParts)[number]

/** How an upkeep part's block's identity tells it after its relation. */
const upkeepPartDisplay: Readonly<Record<UpkeepPart, string>> = {
	units: "",
	lost: ": the facts a write withdraws",
	gained: ": the facts a write gains"
}

/**
 * What a B-tree entry does with a column: binds it by `equality`, reads its entries in its `order` (a seek, a page, a
 * range's last column), or matches a `prefix` of it (a prefix search's last column). A key's every column is an
 * equality. Only an equality's column may be left out of a lookup's entry, as a filter beside it, which keeps the
 * index's order (schema/representability.ts lookupEntry).
 */
const entryRoleRoster = ["equality", "order", "prefix"] as const
export type EntryRole = (typeof entryRoleRoster)[number]

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

/** A key column's stem segments: a field's name's, or a law column's own. */
const columnSegments = (c: KeyColumnName): ReadonlyArray<string> =>
	typeof c === "string" ? nameSegments(c) : c.segments

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
			/** Its selection's conjuncts by their canonical texts, which its identity states. */
			readonly selection: ReadonlyArray<string>
			/** Its selection's conjuncts as their author's predicates, in the same order, which its display reads. */
			readonly displays: ReadonlyArray<string>
	  }
	| {
			readonly kind: "copy" | "index" | "predecessor"
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
	predecessor: "the predecessor of the index"
} as const

/** The suffix of a decoded column's name after its field's conversion. */
const decodedSuffix = "_name"

/**
 * The bytes a closed-id field's conversion may take: maxIdentifierBytes less its decoded column's suffix, `_name`, so
 * the decoded column `<field>_name` each role view shows beside the code fits PostgreSQL's identifier. No limit of its
 * own: PostgreSQL's identifier read against the decoded column's form.
 */
export const closedIdFieldBytes: number = maxIdentifierBytes - decodedSuffix.length

/**
 * A closed-id field's name admitted where its relation is built, `relation` its relation's: the name, or
 * DecodedColumnTooLong where its conversion passes closedIdFieldBytes, so its decoded column would pass PostgreSQL's
 * identifier.
 */
export const admitClosedIdField = (
	relation: string,
	field: string,
	loc: SourceLoc
): Result.Result<string, CompileError> => {
	const conversion = conversionOf(field)
	const bytes = utf8Length(conversion)
	return bytes > closedIdFieldBytes
		? Result.err(
				CompileError.make({
					_tag: "DecodedColumnTooLong",
					at: loc,
					relation,
					field,
					conversion,
					bytes,
					limit: closedIdFieldBytes
				})
			)
		: Result.ok(field)
}

/**
 * An identity of a kind readable as one declared name's conversion, stemmed from that name: the name split once, its
 * segments the stem and joined the identifier.
 */
const readableAs = <K extends IdentityKind>(
	kind: K,
	name: DeclaredName,
	display: string
): Identity<K> => {
	const segments = nameSegments(name)
	return mint(kind, [name], segments, display, readable(joined(segments)))
}

/**
 * An identity of a kind hashed over a derived name, `name`, which its schema's namespace keeps unique, so two derived
 * relations or rosters are two identities whatever they are spelled after: `spelling`, the words its digest's readable
 * stem is spelled from, each split once, is its part beside the name, so no declared name's identity of the kind, its
 * one name, has its parts.
 */
const derivedAs = <K extends IdentityKind>(
	kind: K,
	name: DerivedName,
	spelling: ReadonlyArray<string>,
	display: string
): Identity<K> => mint(kind, [name, spelling], spelling.flatMap(nameSegments), display, hashed)

/** One constructor per kind: nothing else mints an identity. */
export const identity = Object.freeze({
	/** A schema, by its declared name, or the unique name a test installs a schema under, either parsed. */
	schema: (name: SchemaName): Identity<"schema"> => readableAs("schema", name, `schema ${name}`),
	/** A stored relation's table, by its declared name. */
	table: (relation: DeclaredName): Identity<"table"> =>
		readableAs("table", relation, `relation ${relation}`),
	/**
	 * The table of a relation whose name a library derives (ir/desc.ts RelationNaming `derived`), any length, no
	 * identifier: hashed, `__<stem>_<digest>`, over the name, which the schema's namespace keeps unique, so two derived
	 * relations are two tables whatever their stems and paths; its stem spelled from `spelling`, its naming's stem and
	 * path (derivedAs).
	 */
	derivedTable: (relation: DerivedName, spelling: ReadonlyArray<string>): Identity<"table"> =>
		derivedAs("table", relation, spelling, `relation ${relation}`),
	/**
	 * A roster's domain over smallint, its codes' range proof: its one CHECK admits exactly the roster's live codes, so
	 * every closed id it types is one, and every digit a closed relation's constant is indexed by is in range.
	 */
	rosterDomain: (roster: DeclaredName): Identity<"rosterDomain"> =>
		readableAs("rosterDomain", roster, `roster ${roster}`),
	/**
	 * The domain of a roster whose name a library derives (ir/desc.ts RosterNaming `derived`), any length, no identifier:
	 * hashed over the name, which the schema's namespace keeps unique, and spelled after it (derivedAs), as the roster's
	 * constants are named by it.
	 */
	derivedRosterDomain: (roster: DerivedName): Identity<"rosterDomain"> =>
		derivedAs("rosterDomain", roster, [roster], `roster ${roster}`),
	/**
	 * A roster's names constant, named by its roster and the digest of its names in code order: a changed constant is a
	 * new function, never one replaced in place.
	 */
	rosterConstant: (
		roster: HeldName,
		digest: ConstantDigest<"roster-names">
	): Identity<"rosterConstant"> =>
		mint(
			"rosterConstant",
			[roster, digest],
			[...nameSegments(roster), "names"],
			`names of roster ${roster} (${digest})`,
			hashed
		),
	/**
	 * A roster's live codes as a bit string at a set's width, one bit per code, set where its names constant names a
	 * handle, its padding 0, which its domain's CHECK and its sets' domain's read: named by those bits' digest, so a
	 * removal or a growth is a new function and a handle's rename none.
	 */
	rosterLive: (roster: HeldName, digest: ConstantDigest<"roster-live">): Identity<"rosterLive"> =>
		mint(
			"rosterLive",
			[roster, digest],
			[...nameSegments(roster), "live"],
			`live codes of roster ${roster} (${digest})`,
			hashed
		),
	/**
	 * The domain of a set over a roster, bit(width) with width every code the roster has minted rounded up to whole hex
	 * digits, whose one CHECK admits only its live codes' bits: one per roster and width, so a growth past a whole digit
	 * is a new domain and a column moves to it.
	 */
	bitsDomain: (roster: HeldName, width: number): Identity<"bitsDomain"> =>
		mint(
			"bitsDomain",
			[roster, `${width}`],
			[...nameSegments(roster), "bits", ...nameSegments(`${width}`)],
			`sets over roster ${roster} of ${width} bits`,
			hashed
		),
	/**
	 * The installation's digest domain, bytea of exactly 32 bytes, which every SHA-256 digest column is typed by: one per
	 * installation, its definition fixed by SHA-256's length.
	 */
	digestDomain: (): Identity<"digestDomain"> =>
		mint("digestDomain", [], ["sha256"], "the SHA-256 digest domain", readable("__sha256")),
	/**
	 * A variant's composite (ir/scalar.ts VariantType): its tag's code, then every arm's fields, one attribute each, in
	 * arm order. Named by the variant's declared name, so an arm appended to it adds attributes to this one type in place,
	 * which no stored value is rewritten for.
	 */
	variantRow: (variant: DeclaredName): Identity<"variantRow"> =>
		mint(
			"variantRow",
			[variant],
			[...nameSegments(variant), "row"],
			`the composite of variant ${variant}`,
			hashed
		),
	/**
	 * A variant's domain over its composite, whose one CHECK holds every attribute of the arm its tag names present and
	 * every other arm's absent: every column, cast and parameter of the variant is typed by it, so a value of it is a sum
	 * value wherever it stands. Named by the variant's declared name, as a roster's domain is by its roster's.
	 */
	variantDomain: (variant: DeclaredName): Identity<"variantDomain"> =>
		readableAs("variantDomain", variant, `variant ${variant}`),
	/**
	 * One attribute of a variant's composite past its tag: an arm's field's value, or, for a float, whether it is -0
	 * (ir/codes.ts FieldLayout `zero`), by the arm's code, which its handle keeps across every rename, the field's name
	 * and the part, which no other attribute of the composite holds together.
	 */
	variantAttribute: (
		code: number,
		field: string,
		part: "value" | "zero"
	): Identity<"variantAttribute"> =>
		mint(
			"variantAttribute",
			[String(code), field, part],
			[`a${code}`, ...nameSegments(field), ...(part === "zero" ? ["zero"] : [])],
			`${part === "zero" ? "the zero sign of " : ""}field ${field} of the arm of code ${code}`,
			hashed
		),
	/**
	 * A closed relation's or a side's constant, named by the digest of its content alone: two of equal content are one
	 * function, and a changed one is a new function.
	 */
	closedConstant: (digest: ConstantDigest<"closed-constant">): Identity<"closedConstant"> =>
		mint("closedConstant", [digest], ["constant"], `closed constant ${digest}`, hashed),
	/**
	 * A function of grizzle's library (ir/physical.ts LibraryFn), by its name and the digest of its definition
	 * (physical/ddl/library.ts): a library that changes a function's definition names a new function, which every
	 * statement calling it re-points at, as a changed constant is a new constant.
	 */
	libraryFunction: (
		fn: string,
		digest: ConstantDigest<"library-function">
	): Identity<"libraryFunction"> =>
		mint(
			"libraryFunction",
			[fn, digest],
			nameSegments(fn),
			`library function ${fn} (${digest})`,
			hashed
		),
	/**
	 * A table CHECK's or stored generation's expression over its row, installed as a function of the columns it reads
	 * (physical/ddl/row-functions.ts), named by the digest of its definition alone, read in no schema
	 * (sql/type-schemas.ts digestedHooks): an expression stated again, on any table of any installation, is the
	 * function already installed, and a changed one is a new function, which the CHECK or the column re-points at, as a
	 * changed constant is a new constant.
	 */
	rowFunction: (digest: ConstantDigest<"row-function">): Identity<"rowFunction"> =>
		mint("rowFunction", [digest], ["row"], `row function ${digest}`, hashed),
	/**
	 * A canonical relation's stored table (analysis/derived/canonical.ts), named by the digest of its canonical form alone:
	 * every derived relation's definition and every closed import of one built alike, named or not, is one table, and a
	 * changed definition is a new one.
	 */
	view: (digest: string): Identity<"view"> =>
		mint("view", [digest], ["stored"], `stored canonical relation ${digest}`, hashed),
	/**
	 * The whole view of an anonymous canonical relation's stored table (analysis/derived/canonical.ts), which every role
	 * that sees each relation of its definition whole reads it through: named by its form's digest, as its table is.
	 */
	canonicalWholeView: (digest: string): Identity<"wholeView"> =>
		mint(
			"wholeView",
			[digest],
			["stored"],
			`whole view of stored canonical relation ${digest}`,
			hashed
		),
	/** A field's column, in whatever table or view holds it: its name alone, so renaming a relation renames no column. */
	column: (field: DeclaredName): Identity<"column"> =>
		readableAs("column", field, `field ${field}`),
	/**
	 * A role view's decoded column beside a closed-id field's, `<field>_name`, the handle its code names. It is readable
	 * in its view's column namespace exactly when no other field of the relation converts to it, which ownership
	 * refuses, and fits maxIdentifierBytes exactly when the field's conversion leaves room for its suffix.
	 */
	decodedColumn: (field: DeclaredName): Identity<"decodedColumn"> => {
		const segments = nameSegments(field)
		return mint(
			"decodedColumn",
			[field],
			[...segments, "name"],
			`decoded name of field ${field}`,
			readable(`${joined(segments)}${decodedSuffix}`)
		)
	},
	/** A law column (`LawColumnStatement`). */
	lawColumn: (column: LawColumnStatement): Identity<"lawColumn"> => {
		switch (column.kind) {
			case "constant":
				return mint(
					"lawColumn",
					["constant", column.target, column.field, column.value.part],
					["tag", ...nameSegments(column.field), ...nameSegments(column.value.stem)],
					`tag ${column.target}.${column.field} = ${column.value.display}`,
					hashed
				)
			case "term": {
				const { term, selection, displays } = column
				const spelled = term.kind === "pred" ? `pred(${term.field})` : term.field
				return mint(
					"lawColumn",
					["term", [term.kind, term.field], selection],
					term.kind === "pred" ? ["pred", ...nameSegments(term.field)] : nameSegments(term.field),
					`${spelled}${displays.length === 0 ? "" : ` where ${displays.join(" and ")}`}`,
					hashed
				)
			}
			case "copy":
			case "index":
			case "predecessor":
				return mint(
					"lawColumn",
					[column.kind, column.family],
					[column.kind, ...nameSegments(column.count)],
					`${drawnWords[column.kind]} of the family ${column.owner}.${column.count}`,
					hashed
				)
			case "before":
			case "after":
				return mint(
					"lawColumn",
					[column.kind, column.family, column.fold, `${column.plane}`],
					[column.kind, ...nameSegments(column.count), `${column.plane}`],
					`the accumulator ${column.kind} plane ${column.plane} of the fold ${column.fold} over the family ${column.owner}.${column.count}`,
					hashed
				)
		}
	},
	/**
	 * A contract's domain, by the digest of its physical definition alone, read in no schema (sql/type-schemas.ts
	 * digestedHooks): two contracts of one definition are one domain in every installation, and the contract a column is
	 * of stays its type's brand.
	 */
	contractDomain: (definition: DomainDigest): Identity<"contractDomain"> =>
		mint("contractDomain", [definition], ["domain"], `domain of definition ${definition}`, hashed),
	/** A structural text domain, by the digest of its physical definition alone: equal definitions share it. */
	textDomain: (definition: DomainDigest): Identity<"textDomain"> =>
		mint("textDomain", [definition], ["text"], `text domain of definition ${definition}`, hashed),
	/**
	 * The pattern domain of a declared parameter, by the parameter's place, its name and, for a relation parameter's
	 * field, the field's, and the digest of the domain's whole definition, its base, the pattern's structural text
	 * domain, included (physical/ddl/domains.ts paramDomainIdentity): a placeholder of the parameter is cast to it, so a
	 * refusal by it names exactly the parameter and its pattern, whatever stored field shares the pattern.
	 */
	paramDomain: (place: ParamPlace, definition: DomainDigest): Identity<"paramDomain"> =>
		mint(
			"paramDomain",
			place.kind === "scalar"
				? [place.kind, place.name, definition]
				: [place.kind, place.name, place.field, definition],
			place.kind === "scalar"
				? ["param", ...nameSegments(place.name)]
				: ["param", ...nameSegments(place.name), ...nameSegments(place.field)],
			`pattern domain of parameter ${paramPlaceText(place)} of definition ${definition}`,
			hashed
		),
	/**
	 * The head table of a place, or of a clock no unit holds (ir/instant.ts Head), by its relation and its field: each
	 * child's last stamp, which the head's stamp function alone advances (physical/ddl/stamps.ts).
	 */
	head: (relation: string, field: string): Identity<"head"> =>
		mint(
			"head",
			[relation, field],
			["head", ...nameSegments(relation), ...nameSegments(field)],
			`head table of ${relation}.${field}`,
			hashed
		),
	/** The primary key of a head table, its child's fields, by the head's relation and field. */
	headKey: (relation: string, field: string): Identity<"headKey"> =>
		mint(
			"headKey",
			[relation, field],
			["head", ...nameSegments(relation), ...nameSegments(field), "pk"],
			`primary key of the head table of ${relation}.${field}`,
			hashed
		),
	/** The stamp function of a place, or of a clock no unit holds, by its relation and its field, which advances each
	 * child's head and returns it (physical/ddl/stamps.ts). */
	stamp: (relation: string, field: string): Identity<"stamp"> =>
		mint(
			"stamp",
			[relation, field],
			["stamp", ...nameSegments(relation), ...nameSegments(field)],
			`stamp function of ${relation}.${field}`,
			hashed
		),
	/**
	 * The head table of the unit `unit`'s clocks (ir/instant.ts ClockScope `unit`), in the installation's root schema:
	 * each key's last instant stamped in the unit, every clock of it alike, which the unit's stamp function alone
	 * advances (physical/ddl/stamps.ts).
	 */
	unitHead: (unit: string): Identity<"unitHead"> =>
		mint("unitHead", [unit], [...nameSegments(unit), "head"], `head table of unit ${unit}`, hashed),
	/** The primary key of the unit `unit`'s head table, over the unit's key. */
	unitHeadKey: (unit: string): Identity<"unitHeadKey"> =>
		mint(
			"unitHeadKey",
			[unit],
			[...nameSegments(unit), "head", "pk"],
			`primary key of the head table of unit ${unit}`,
			hashed
		),
	/** The stamp function of the unit `unit`'s clocks, which advances each key's head and returns it
	 * (physical/ddl/stamps.ts). */
	unitStamp: (unit: string): Identity<"unitStamp"> =>
		mint(
			"unitStamp",
			[unit],
			["stamp", ...nameSegments(unit)],
			`stamp function of unit ${unit}`,
			hashed
		),
	/** Every clock head table's column of each key's last instant (physical/ddl/stamps.ts), which no declared name is. */
	headInstant: (): Identity<"headInstant"> =>
		mint("headInstant", [], ["instant"], "the last instant stamped", readable("__instant")),
	/** Every head table's column of the transaction that last stamped each key, by its 64-bit id (xid8), which no
	 * declared name is (physical/ddl/stamps.ts). */
	headStamper: (): Identity<"headStamper"> =>
		mint(
			"headStamper",
			[],
			["stamper"],
			"the transaction that last stamped",
			readable("__stamper")
		),
	/** The guard of the clocks of `relation` (physical/ddl/clocked.ts): each row a statement inserts holds its
	 * transaction's stamp of each of its clocks at its scope's key. */
	clockGuard: (relation: string): Identity<"clockGuard"> =>
		mint(
			"clockGuard",
			[relation],
			["clocked", ...nameSegments(relation)],
			`clock guard of ${relation}`,
			hashed
		),
	/** The guard of the clocks of `relation` against an UPDATE that moves one (physical/ddl/clocked.ts): each row whose
	 * clock or scope key it changes holds its transaction's stamp there. */
	clockMoveGuard: (relation: string): Identity<"clockMoveGuard"> =>
		mint(
			"clockMoveGuard",
			[relation],
			["clock", "moved", ...nameSegments(relation)],
			`clock move guard of ${relation}`,
			hashed
		),
	/** Every clock relation's insert guard's trigger: one name, which PostgreSQL scopes to its table's triggers, and the
	 * constraint a refusal of either clock guard reports. */
	clockTrigger: (): Identity<"clockTrigger"> =>
		mint("clockTrigger", [], ["clocked"], "the clock trigger", readable("__clocked")),
	/** Every clock relation's move guard's trigger, beside its insert guard's. */
	clockMoveTrigger: (): Identity<"clockMoveTrigger"> =>
		mint(
			"clockMoveTrigger",
			[],
			["clock", "moved"],
			"the clock move trigger",
			readable("__clock_moved")
		),
	/**
	 * A stored relation's primary key, by its relation alone: a relation has exactly one, so a migration that moves it
	 * to other fields replaces it under its name, the one order PostgreSQL admits (a table holds at most one: 42P16).
	 */
	primaryKey: (relation: string): Identity<"primaryKey"> =>
		mint(
			"primaryKey",
			[relation],
			[...nameSegments(relation), "pk"],
			`primary key of ${relation}`,
			hashed
		),
	/** A candidate key or a generated unique, a span key's span field among its fields. */
	key: (relation: string, fields: ReadonlyArray<KeyColumnName>): Identity<"key"> =>
		mint(
			"key",
			[relation, fields],
			[...nameSegments(relation), "key", ...fields.flatMap(columnSegments)],
			`key ${fieldsOf(relation, fields)}`,
			hashed
		),
	/** A declared row check, by its declared name, in its table's constraint namespace. */
	check: (relation: string, name: DeclaredName): Identity<"check"> => {
		const segments = nameSegments(name)
		return mint(
			"check",
			[relation, name],
			[...nameSegments(relation), "check", ...segments],
			`check ${name} of ${relation}`,
			readable(joined(segments))
		)
	},
	/** The CHECK a law lowers to on a table: a closed law's, or a family's. */
	generatedCheck: (relation: string, law: Identity<"law">): Identity<"generatedCheck"> =>
		mint(
			"generatedCheck",
			[relation, law],
			[...nameSegments(relation), "check", ...law.segments],
			`check of ${relation} for law ${law.display}`,
			hashed
		),
	spanCheck: (relation: string, field: string, check: SpanCheck): Identity<"spanCheck"> =>
		mint(
			"spanCheck",
			[relation, field, check.kind === "endpoint" ? ["endpoint", check.contract] : check.kind],
			[
				...nameSegments(relation),
				...nameSegments(field),
				...(check.kind === "endpoint"
					? nameSegments(check.contract)
					: [check.kind === "shape" ? "span" : "width"])
			],
			`span ${check.kind === "endpoint" ? `endpoint ${check.contract}` : check.kind} check of ${relation}.${field}`,
			hashed
		),
	normCheck: (relation: string, field: string): Identity<"normCheck"> =>
		mint(
			"normCheck",
			[relation, field],
			[...nameSegments(relation), "norm", ...nameSegments(field)],
			`cosine norm check of ${relation}.${field}`,
			hashed
		),
	/** A date column's range CHECK: the days a CalendarDate spells. */
	dateCheck: (relation: string, field: string): Identity<"dateCheck"> =>
		mint(
			"dateCheck",
			[relation, field],
			[...nameSegments(relation), "range", ...nameSegments(field)],
			`date range check of ${relation}.${field}`,
			hashed
		),
	/** An integer numeric column's CHECK, numeric(p, 0)'s: the integers a bigint spells, no NaN. */
	integerCheck: (relation: string, field: string): Identity<"integerCheck"> =>
		mint(
			"integerCheck",
			[relation, field],
			[...nameSegments(relation), "integer", ...nameSegments(field)],
			`integer check of ${relation}.${field}`,
			hashed
		),
	/** An exact field's column CHECK: the values its host spells, numeric at its carrier's one scale, never NaN or an infinity. */
	exactCheck: (relation: string, field: string): Identity<"exactCheck"> =>
		mint(
			"exactCheck",
			[relation, field],
			[...nameSegments(relation), "exact", ...nameSegments(field)],
			`exact value check of ${relation}.${field}`,
			hashed
		),
	/** A computed numeric column's bound CHECK, pg.numeric.within's: the values within its bound. */
	boundCheck: (relation: string, field: string): Identity<"boundCheck"> =>
		mint(
			"boundCheck",
			[relation, field],
			[...nameSegments(relation), "bound", ...nameSegments(field)],
			`numeric bound check of ${relation}.${field}`,
			hashed
		),
	/** A closed id column's subset CHECK: the handles of its roster its field's subset holds. */
	subsetCheck: (relation: string, field: string): Identity<"subsetCheck"> =>
		mint(
			"subsetCheck",
			[relation, field],
			[...nameSegments(relation), "subset", ...nameSegments(field)],
			`closed id subset check of ${relation}.${field}`,
			hashed
		),
	/**
	 * A contract's, text domain's, roster's, set's or digest domain's CHECK, `check` in its domain's constraint
	 * namespace.
	 */
	domainCheck: (
		domain: Identity<
			| "contractDomain"
			| "textDomain"
			| "paramDomain"
			| "rosterDomain"
			| "bitsDomain"
			| "digestDomain"
			| "variantDomain"
		>
	): Identity<"domainCheck"> =>
		mint(
			"domainCheck",
			[domain],
			[...domain.segments, "check"],
			`check of ${domain.display}`,
			readable("check")
		),
	/** A foreign key from `from` to `to`, of the reference's form: over scalar columns, or PERIOD over a span's last. */
	foreignKey: (from: KeySide, to: KeySide, form: "period" | "scalar"): Identity<"foreignKey"> =>
		mint(
			"foreignKey",
			[from.relation, from.fields, to.relation, to.fields, form],
			[...nameSegments(from.relation), "fk", ...from.fields.flatMap(columnSegments)],
			`${form === "period" ? "PERIOD " : ""}foreign key ${sideDisplay(from)} to ${sideDisplay(to)}`,
			hashed
		),
	/**
	 * An index the engine creates: its relation, method and keys, and the columns its requests bind that its entry leaves
	 * out as filters beside it (schema/representability.ts lookupEntry), which its display states, so the draft's comment
	 * on the index says which lookups read past it.
	 */
	accessIndex: (
		relation: string,
		method: IndexMethod,
		keys: ReadonlyArray<IndexKey>,
		filtered: ReadonlyArray<string>
	): Identity<"accessIndex"> =>
		mint(
			"accessIndex",
			[relation, method, keys.map((k) => [k.field, k.dir, k.opclass]), filtered],
			[...nameSegments(relation), "ix", ...keys.flatMap((k) => nameSegments(k.field))],
			`${method} index ${relation}(${keys.map((k) => `${k.field}${k.dir === "desc" ? " desc" : ""}${k.opclass === "default" ? "" : ` ${k.opclass}`}`).join(", ")})${filtered.length === 0 ? "" : `, ${filtered.join(", ")} filtered beside it, not indexed: no byte bound fits the entry`}`,
			hashed
		),
	/**
	 * The composite type a hash index over several columns of `relation` holds the row of (physical/indexes/engine.ts
	 * createIndex): its fields, in the index's key order, each an attribute of the type, so one row type serves one index,
	 * dropped with it.
	 */
	hashRow: (relation: string, fields: ReadonlyArray<string>): Identity<"hashRow"> =>
		mint(
			"hashRow",
			[relation, fields],
			[...nameSegments(relation), "hr", ...fields.flatMap((f) => nameSegments(f))],
			`hash row ${relation}(${fields.join(", ")})`,
			hashed
		),
	/**
	 * A derived relation's unique index on a key its definition proves, in the stored table `table` holds its rows in
	 * (core/identity.ts view, a canonical relation's): minted from the table, so each table's indexes are its own and a
	 * definition whose new form is a new table names new ones, its name read from the relation's.
	 */
	derivedKey: (
		view: string,
		table: string,
		fields: ReadonlyArray<string>
	): Identity<"derivedKey"> =>
		mint(
			"derivedKey",
			[table, fields],
			[...nameSegments(view), "key", ...fields.flatMap(nameSegments)],
			`key ${fieldsOf(view, fields)}`,
			hashed
		),
	/** A law of the theory, as analysis/theory/theory.ts states it. */
	law: (law: LawStatement): Identity<"law"> =>
		mint("law", law.parts, law.stem.flatMap(nameSegments), law.display, hashed),
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
			[...nameSegments(relation), "pattern", ...nameSegments(field)],
			`pattern law of ${relation}.${field} under ${domain.display}`,
			hashed
		),
	/** The law of one stored field's variant, that its value is a value of the variant, checked by the variant's domain's
	 * CHECK and the domains of its arms' fields, which every field of one variant shares: one law per field, so the
	 * field names it. */
	variantLaw: (
		domain: Identity<"variantDomain">,
		relation: string,
		field: string
	): Identity<"variantLaw"> =>
		mint(
			"variantLaw",
			[domain, relation, field],
			[...nameSegments(relation), "variant", ...nameSegments(field)],
			`variant law of ${relation}.${field} under ${domain.display}`,
			hashed
		),
	/**
	 * The law of one generated field, that its term has a value at every row, which its column's NOT NULL refuses where
	 * it has none: one law per field, so the relation and the field name it. No constraint or function carries it; the
	 * snapshot's derived facts and a served file's key laws hold it, outside every fingerprint.
	 */
	generatedLaw: (relation: string, field: string): Identity<"generatedLaw"> =>
		mint(
			"generatedLaw",
			[relation, field],
			[...nameSegments(relation), "generated", ...nameSegments(field)],
			`generated law of ${relation}.${field}`,
			hashed
		),
	/** A login's PostgreSQL role, `<schema>__<login>`: roles are cluster-wide, so its installation is part of it. */
	login: (installation: Identity<"schema">, name: DeclaredName): Identity<"login"> => {
		const segments = nameSegments(name)
		return mint(
			"login",
			[installation, name],
			[...installation.segments, ...segments],
			`login ${name} of ${installation.display}`,
			readable(`${installation.identifier}__${joined(segments)}`)
		)
	},
	/** A role's PostgreSQL role, its theory role, `<schema>__<role>`. */
	role: (installation: Identity<"schema">, name: DeclaredName): Identity<"role"> => {
		const segments = nameSegments(name)
		return mint(
			"role",
			[installation, name],
			[...installation.segments, ...segments],
			`role ${name} of ${installation.display}`,
			readable(`${installation.identifier}__${joined(segments)}`)
		)
	},
	/** A role's own schema of views, its role's name. */
	roleSchema: (role: Identity<"role">): Identity<"roleSchema"> =>
		mint(
			"roleSchema",
			[role],
			role.segments,
			`schema of ${role.display}`,
			readable(role.identifier)
		),
	/** A role's query entry's view in its role's schema, by the entry's declared name. */
	roleView: (role: Identity<"role">, entry: DeclaredName): Identity<"roleView"> => {
		const segments = nameSegments(entry)
		return mint(
			"roleView",
			[role, entry],
			segments,
			`view ${entry} of ${role.display}`,
			readable(joined(segments))
		)
	},
	/** A level's schema of the whole views of its relations, `__<schema>`, minted from the level's schema: what every
	 * role holding one of them whole reads it through. */
	wholeSchema: (level: string): Identity<"wholeSchema"> =>
		mint(
			"wholeSchema",
			[level],
			[level],
			`whole views of schema ${level}`,
			readable(`${hashedLead}${level}`)
		),
	/** A relation's whole view, in its level's schema of whole views (`wholeSchema`), by the relation's declared name,
	 * its table's. */
	wholeView: (relation: DeclaredName): Identity<"wholeView"> =>
		readableAs("wholeView", relation, `whole view of relation ${relation}`),
	/**
	 * The whole view of a relation or roster whose name a library derives (ir/desc.ts RelationNaming and RosterNaming
	 * `derived`), in its level's schema of whole views, hashed over the name as its table or domain is (derivedAs),
	 * spelled after `spelling`.
	 */
	derivedWholeView: (
		relation: DerivedName,
		spelling: ReadonlyArray<string>
	): Identity<"wholeView"> =>
		derivedAs("wholeView", relation, spelling, `whole view of relation ${relation}`),
	/** A writable entry's filter function. */
	filter: (role: Identity<"role">, entry: string): Identity<"filter"> =>
		mint(
			"filter",
			[role, entry],
			[...role.segments, ...nameSegments(entry), "filter"],
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
			[...role.segments, ...nameSegments(entry), "key", ...key.flatMap(nameSegments)],
			`key probe (${key.join(", ")}) of ${entry} of ${role.display}`,
			hashed
		),
	/** A writable query entry's unique probe over one unique object of the relation it writes that no key subsumes, by
	 * the object's installed name. */
	uniqueProbe: (role: Identity<"role">, entry: string, object: string): Identity<"uniqueProbe"> =>
		mint(
			"uniqueProbe",
			[role, entry, object],
			[...role.segments, ...nameSegments(entry), "unique"],
			`unique probe of ${object} of ${entry} of ${role.display}`,
			hashed
		),
	/** A role's row security policy on a table it writes, its role's name: a role writes a table through at most one
	 * entry. */
	policy: (role: Identity<"role">, relation: string): Identity<"policy"> =>
		mint(
			"policy",
			[role, relation],
			role.segments,
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
	ledgerCheck: (column: string): Identity<"ledgerCheck"> => {
		const segments = nameSegments(column)
		return mint(
			"ledgerCheck",
			[column],
			["ledger", ...segments, "check"],
			`the migrations ledger's check of ${column}`,
			readable(`__ledger_${joined(segments)}_check`)
		)
	},
	/** The migrations ledger's head, the one row the snapshot guard reads (deploy/ledger/ledger.ts headTable). */
	ledgerHead: (): Identity<"ledgerHead"> =>
		mint(
			"ledgerHead",
			[],
			["ledger", "head"],
			"the migrations ledger's head",
			readable("__ledger_head")
		),
	/** The migrations ledger's head's primary key. */
	ledgerHeadKey: (): Identity<"ledgerHeadKey"> =>
		mint(
			"ledgerHeadKey",
			[],
			["ledger", "head", "pk"],
			"the migrations ledger's head's key",
			readable("__ledger_head_pk")
		),
	/** The migrations ledger's head's CHECK, which holds it to its one row. */
	ledgerHeadCheck: (): Identity<"ledgerHeadCheck"> =>
		mint(
			"ledgerHeadCheck",
			[],
			["ledger", "head", "row", "check"],
			"the migrations ledger's head's check of its one row",
			readable("__ledger_head_row_check")
		),
	/** The drift check's proofs, beside the migrations ledger (deploy/ledger/ledger.ts proofsTable). */
	proofs: (): Identity<"proofs"> =>
		mint("proofs", [], ["drift", "proofs"], "the drift check's proofs", readable("__drift_proofs")),
	/** The drift check's proofs' primary key. */
	proofsKey: (): Identity<"proofsKey"> =>
		mint(
			"proofsKey",
			[],
			["drift", "proofs", "pk"],
			"the drift check's proofs' key",
			readable("__drift_proofs_pk")
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
	/**
	 * The immutability guard of the immutable relation `relation` (physical/ddl/immutable.ts): the function its table's
	 * guard trigger runs on every row an UPDATE finds, which refuses one that changes a field the relation's rows never
	 * change in place.
	 */
	immutableGuard: (relation: string): Identity<"immutableGuard"> =>
		mint(
			"immutableGuard",
			[relation],
			["immutable", ...nameSegments(relation)],
			`immutability guard of ${relation}`,
			hashed
		),
	/** Every immutable relation's table's guard trigger of its rows: one name, which PostgreSQL scopes to its table's
	 * triggers. */
	immutableTrigger: (): Identity<"immutableTrigger"> =>
		mint(
			"immutableTrigger",
			[],
			["immutable"],
			"the immutability guard trigger",
			readable("__immutable")
		),
	/** Every immutable relation's table's guard trigger of a TRUNCATE: one name, scoped to its table's triggers. */
	immutableTruncateTrigger: (): Identity<"immutableTruncateTrigger"> =>
		mint(
			"immutableTruncateTrigger",
			[],
			["immutable", "truncate"],
			"the immutability guard trigger of a TRUNCATE",
			readable("__immutable_truncate")
		),
	/**
	 * The law of the sealed unit `unit` (physical/ddl/seal.ts): every row of every relation under it at a key is inserted
	 * by one transaction, the one that founds it there. One law a unit, which every member's seal guard raises.
	 */
	sealLaw: (unit: string): Identity<"sealLaw"> =>
		mint("sealLaw", [unit], [...nameSegments(unit), "sealed"], `seal of unit ${unit}`, hashed),
	/**
	 * The seal guard of `relation`, a member of the sealed unit `unit` (physical/ddl/seal.ts): the function its seal
	 * trigger runs at the end of every statement that inserts into it, which founds each key the statement inserted at
	 * that no transaction founded and refuses the statement where another founded one. Its body names the unit's
	 * founding table and the relation's key columns in PL/pgSQL text, so a rename of the relation names another.
	 */
	sealGuard: (unit: string, relation: string): Identity<"sealGuard"> =>
		mint(
			"sealGuard",
			[unit, relation],
			["sealed", ...nameSegments(relation)],
			`seal guard of ${relation} under unit ${unit}`,
			hashed
		),
	/** Every sealed unit's member's seal trigger: one name, which PostgreSQL scopes to its table's triggers, and the
	 * constraint a seal guard's refusal reports. */
	sealTrigger: (): Identity<"sealTrigger"> =>
		mint("sealTrigger", [], ["sealed"], "the seal trigger", readable("__sealed")),
	/**
	 * The founding table of the sealed unit `unit` (physical/ddl/seal.ts): each key the unit is founded at, with the
	 * transaction that founded it there, which its members' seal guards write and read.
	 */
	founding: (unit: string): Identity<"founding"> =>
		mint(
			"founding",
			[unit],
			[...nameSegments(unit), "founding"],
			`founding of unit ${unit}`,
			hashed
		),
	/** The primary key of the founding table of the sealed unit `unit`, over the unit's key. */
	foundingKey: (unit: string): Identity<"foundingKey"> =>
		mint(
			"foundingKey",
			[unit],
			[...nameSegments(unit), "founding", "pk"],
			`key of the founding of unit ${unit}`,
			hashed
		),
	/** Every founding table's column of the transaction that founded each key, by its 64-bit id (xid8). */
	founder: (): Identity<"founder"> =>
		mint("founder", [], ["founder"], "the founding transaction", readable("__founder")),
	/**
	 * The live change source of the installation whose root level's PostgreSQL schema is `root`: one name for its
	 * publication, which PostgreSQL scopes to the database, and for its decoder login, cluster wide under the
	 * installation's role space (roleInSpace), and the stem of its replication slot in each database (liveSlotOf); the
	 * publication's name is also the fan-out channel and the prefix of the logical messages the installation announces.
	 * Hashed by the root's identifier, `__live_<digest>`, its stem the lead word alone, so its length is one whatever the
	 * root's (maxRolePrefixBytes) and every role prefix within maxRolePrefixBytes leads it within maxIdentifierBytes.
	 */
	liveSource: (root: string): Identity<"liveSource"> =>
		mint("liveSource", [root], [liveSegment], `live source of ${root}`, hashed),
	/** The table of a schema's live secret, which only the installation's decoder login reads. */
	liveSecret: (): Identity<"liveSecret"> =>
		mint("liveSecret", [], ["live", "secret"], "the live secret", readable("__live_secret")),
	/** A declared function, its declared name's conversion, in the PostgreSQL schema of the level that declares it. */
	declaredFunction: (name: DeclaredName): Identity<"declaredFunction"> =>
		readableAs("declaredFunction", name, `function ${name}`),
	/**
	 * The row type of a heading a declared function takes rows of or returns, by the digest of its physical definition
	 * alone (core/fingerprint.ts RowTypeDigest): equal headings share it, and a changed heading is another type, which
	 * its functions take in its place.
	 */
	rowType: (definition: RowTypeDigest): Identity<"rowType"> =>
		mint("rowType", [definition], ["rows"], `row type of definition ${definition}`, hashed),
	/**
	 * The function owner of the installation whose root level's PostgreSQL schema is `root`: the role that owns every
	 * declared function and holds no privilege on any table, so a declared function, which runs as its owner, reads no
	 * table. Cluster-wide under the installation's role space (roleInSpace), hashed by the root's identifier, as the live
	 * source is, so every spelling of the root's declared name that installs one schema has one owner, and the
	 * installation's roles are read off its levels' schemas alone (installationRoleOf): `__owner_<digest>`, its stem the
	 * lead word alone, so its length is one whatever the root's (maxRolePrefixBytes).
	 */
	functionOwner: (root: string): Identity<"functionOwner"> =>
		mint("functionOwner", [root], [ownerSegment], `function owner of ${root}`, hashed),
	refusal: (): Identity<"refusal"> =>
		mint("refusal", [], ["refuse"], "the refusal function", readable("__refuse")),
	/** The function a call's borrows take their locks by, in the order of their ids (write/borrow/function.ts). */
	borrow: (): Identity<"borrow"> =>
		mint("borrow", [], ["borrow"], "the borrow function", readable("__borrow")),
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
		mint("lawTrigger", [law], ["rule", ...law.segments], `trigger of rule ${law.display}`, hashed),
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
			["rule", ...nameSegments(relation), ...law.segments],
			`function of rule ${law.display} on ${relation}`,
			hashed
		),
	/**
	 * The function a table's rule captures run (physical/ddl/rules.ts judged), which writes the rows each statement wrote
	 * of `relation` into its deltas and arms its session's judge: its body names the table's columns and the deltas in
	 * PL/pgSQL text, so it is replaced in place whenever they change, and a rename of the relation names another.
	 */
	ruleCapture: (relation: string): Identity<"ruleCapture"> =>
		mint(
			"ruleCapture",
			[relation],
			["capture", ...nameSegments(relation)],
			`rule capture of ${relation}`,
			hashed
		),
	/**
	 * The stand-up of the rule judge's session tables a write of `relation` needs (physical/ddl/rules.ts addStandUps):
	 * the function a session calls once, before its first write of the relation, which makes the session's sentinel, the
	 * relation's deltas and the deltas the judge reads beside them where the session holds none, as the judge's definer.
	 * Its body names the deltas, so it is replaced in place whenever they change, and a rename of the relation names
	 * another.
	 */
	ruleStandUp: (relation: string): Identity<"ruleStandUp"> =>
		mint(
			"ruleStandUp",
			[relation],
			["stand", ...nameSegments(relation)],
			`${standUpDisplayLead}${relation} needs`,
			hashed
		),
	/**
	 * The maker of a closure of the rule judge (physical/ddl/rules.ts Closure): the function the stand-up of every table
	 * whose writes reach the closure calls, which makes its deltas and their indexes where the session holds none, as the
	 * judge's definer, and last its marker, `stood`. It is named by its marker, so a closure of other deltas is another
	 * function, its stem by `relation`, the closure's first stored relation in name order. Its display leads with no
	 * stand-up's, so no custom migration's data step calls it as one (standUpDisplayLead).
	 */
	ruleClosure: (relation: string, stood: Identity<"ruleStood">): Identity<"ruleClosure"> =>
		mint(
			"ruleClosure",
			[stood],
			["closure", ...nameSegments(relation)],
			`the maker of the rule judge's session tables the upkeeps over ${relation} reach`,
			hashed
		),
	/**
	 * The maker of a share of the rule judge (physical/ddl/rules.ts Share): the function that makes `deltas`, the deltas
	 * two or more of the judge's makers need, a closure's maker or a table's stand-up, alike, and their indexes, where the
	 * session holds none, as the judge's definer, so the installation states each delta's table once. Named by its
	 * deltas, its stem by `relation`, the relation of the first of them.
	 */
	ruleShare: (
		relation: string,
		deltas: NonEmptyReadonlyArray<Identity<"ruleDelta">>
	): Identity<"ruleShare"> =>
		mint(
			"ruleShare",
			deltas,
			["share", ...nameSegments(relation)],
			`the maker of the rule judge's session tables of ${relation} that more than one stand-up needs`,
			hashed
		),
	/**
	 * A function of the rule judge's upkeep of stored derived relation `relation` (physical/ddl/rules.ts upkeepBlock,
	 * phase A): the one that runs one part of its form (`UpkeepPart`), which its part of the judge calls where a delta
	 * its statements read holds a row, so a session compiles and plans the parts its writes touch alone. A unit form's
	 * one part keeps the name of the relation alone.
	 */
	storedUpkeep: (relation: string, part: UpkeepPart): Identity<"storedUpkeep"> =>
		mint(
			"storedUpkeep",
			part === "units" ? [relation] : [relation, part],
			["upkeep", ...nameSegments(relation)],
			`the rule judge's upkeep of stored relation ${relation}${upkeepPartDisplay[part]}`,
			hashed
		),
	/**
	 * A table's rule capture of one statement event (sql/ast.ts CreateTransitionTrigger): one name per event, which
	 * PostgreSQL scopes to each table's triggers, as the isolation trigger's is.
	 */
	captureTrigger: (event: "insert" | "update" | "delete"): Identity<"captureTrigger"> =>
		mint(
			"captureTrigger",
			[event],
			["capture", event],
			`the rule capture of each ${event}`,
			readable(`__capture_${event}`)
		),
	/**
	 * The installation's rule judge (physical/ddl/rules.ts judged): the one function a session's sentinel's deferred
	 * trigger runs, so it keeps its name, and its object, for as long as the installation holds a rule over a query:
	 * a session's sentinel outlives every migration that replaces it, and PostgreSQL refuses to drop a function a
	 * trigger runs.
	 */
	ruleJudge: (): Identity<"ruleJudge"> =>
		mint("ruleJudge", [], ["judge"], "the rule judge", readable("__judge")),
	/**
	 * The installation's re-check of a data step (physical/ddl/recheck.ts): the function a custom migration's data step
	 * calls after its statements, inside its bracket (physical/ddl/immutable.ts dataStepBracket), which finds it by this
	 * one name in each schema of the installation's levels (adapter/migrate/apply.ts installedRechecks), as it finds the
	 * guards by their trigger's.
	 */
	dataStepRecheck: (): Identity<"dataStepRecheck"> =>
		mint(
			"dataStepRecheck",
			[],
			["recheck"],
			"the re-check of a data step",
			readable(dataStepRecheckName)
		),
	/**
	 * A part of the rule judge (physical/ddl/rules.ts addRules): the function that judges every rule whose statements
	 * read one of the session's deltas `deltas`, which the judge runs where the transaction wrote one of them, the
	 * written set its `sentinel` holds. It is named by its sentinel and its deltas, an upkeep's by its stratum too, which
	 * two strata's parts over the same deltas tell apart, and its stem by the relation of the first, `relation`, so a part
	 * whose deltas or whose written set's declaration change is another function, created in its place, never one whose
	 * parameters CREATE OR REPLACE would have to rename (42P13).
	 */
	ruleJudgePart: (
		relation: string,
		sentinel: Identity<"ruleSentinel">,
		deltas: NonEmptyReadonlyArray<Identity<"ruleDelta">>,
		pass: { readonly kind: "upkeep"; readonly stratum: number } | { readonly kind: "rules" }
	): Identity<"ruleJudgePart"> =>
		mint(
			"ruleJudgePart",
			pass.kind === "rules"
				? [sentinel, ...deltas]
				: [sentinel, "upkeep", String(pass.stratum), ...deltas],
			["judge", ...nameSegments(relation)],
			pass.kind === "rules"
				? `the rule judge of the deltas of ${relation} and the relations its rules join it to`
				: `the upkeep of stratum ${String(pass.stratum)} of the stored relations over the deltas of ${relation} and the relations they read beside it`,
			hashed
		),
	/**
	 * A block of the rule judge (physical/ddl/rules.ts addRules): the function that runs one rule's statement over what
	 * its region reads, a probe's one side of one table or a whole rule's units, which its part runs where one of the
	 * deltas the region reads holds a row, so a session compiles and plans the statements of the rules its writes can
	 * break alone. It is named by its rule's trigger, `rule`, and its region, its stem by the rule's law, `law`. It takes
	 * no argument, so CREATE OR REPLACE puts any statement of its rule in place.
	 */
	ruleJudgeBlock: (
		rule: Identity<"lawTrigger">,
		law: Identity<"law">,
		region:
			| { readonly kind: "probe"; readonly relation: string; readonly side: "added" | "removed" }
			| { readonly kind: "units" }
	): Identity<"ruleJudgeBlock"> =>
		mint(
			"ruleJudgeBlock",
			region.kind === "probe" ? [rule, region.relation, region.side] : [rule],
			["judge", ...law.segments],
			region.kind === "probe"
				? `the rule judge's block of rule ${law.display} over the rows ${region.side === "added" ? "a write adds to" : "a write removes from"} ${region.relation}`
				: `the rule judge's block of rule ${law.display} over its units`,
			hashed
		),
	/**
	 * A session's delta of `relation`'s writes on one side of the rules that read it (physical/ddl/rules.ts addRules): a
	 * table of pg_temp, by its installation, the identity of its root schema, since a session may write several, and by
	 * its declaration's canonical text, its columns and their types, so a migration that changes it names another and
	 * never meets a session's delta of the old declaration.
	 */
	ruleDelta: (
		installation: Identity<"schema">,
		relation: string,
		side: "news" | "olds",
		declaration: string
	): Identity<"ruleDelta"> =>
		mint(
			"ruleDelta",
			[installation, relation, side, declaration],
			["delta", side, ...nameSegments(relation)],
			`delta of ${side} of ${relation}`,
			hashed
		),
	/**
	 * A reader of a session's delta `delta` of `relation`'s writes on one side (physical/ddl/deltas.ts DeltaReads): the
	 * set-returning function a statement of the judge reads the columns `projection` of the rows of the delta a selection
	 * admits through, the selection's conjuncts over the delta's table, each by its text in canonical order, none for
	 * every row, the projection's columns by name in the delta's order; named by the delta's identity, the selection and
	 * the projection, so a migration that changes the delta's declaration or a read's selection or columns names another
	 * reader.
	 */
	ruleDeltaReader: (
		relation: string,
		side: "news" | "olds",
		delta: Identity<"ruleDelta">,
		selection: ReadonlyArray<string>,
		projection: ReadonlyArray<string>
	): Identity<"ruleDeltaReader"> =>
		mint(
			"ruleDeltaReader",
			[delta, selection, projection],
			["reader", side, ...nameSegments(relation)],
			`the reader of the delta of ${side} of ${relation}`,
			hashed
		),
	/**
	 * An index of a session's delta `delta` of `relation`'s writes on one side over its column `column`
	 * (physical/ddl/deltas.ts deltaIndexes): the B-tree its readers of a selection that fixes the column read the rows it
	 * admits through, made with the delta's table, named by the delta's identity and the column.
	 */
	ruleDeltaIndex: (
		relation: string,
		side: "news" | "olds",
		delta: Identity<"ruleDelta">,
		column: string
	): Identity<"ruleDeltaIndex"> =>
		mint(
			"ruleDeltaIndex",
			[delta, column],
			["index", side, ...nameSegments(relation)],
			`the index of the delta of ${side} of ${relation} over ${column}`,
			hashed
		),
	/**
	 * A session's marker of a set of the rule judge's deltas, `deltas`, of an installation, the identity of its root schema
	 * (physical/ddl/rules.ts Closure, addStandUps): a table of pg_temp of no column, which the one site that makes the
	 * set's deltas makes last, so its standing as the definer's own proves every one of them stands as the definer's own.
	 * Named by the set, so two sites that make one set make one marker, and an installation whose set holds another
	 * delta names another, which no session that stood the old set up holds.
	 */
	ruleStood: (
		installation: Identity<"schema">,
		deltas: NonEmptyReadonlyArray<Identity<"ruleDelta">>
	): Identity<"ruleStood"> =>
		mint(
			"ruleStood",
			[installation, ...deltas],
			["stood"],
			`the marker of a set of the rule judge's session tables of ${installation.display}`,
			hashed
		),
	/**
	 * A session's sentinel of an installation, the identity of its root schema (physical/ddl/rules.ts addRules): a table
	 * of pg_temp whose one row arms its deferred trigger, which runs the judge, and holds the transaction's written set,
	 * named by its declaration's canonical text too, so a migration that changes it names another and no capture meets
	 * a session's sentinel of the old declaration.
	 */
	ruleSentinel: (installation: Identity<"schema">, declaration: string): Identity<"ruleSentinel"> =>
		mint(
			"ruleSentinel",
			[installation, declaration],
			["sentinel"],
			`the rule sentinel of ${installation.display}`,
			hashed
		),
	/** The name a migration sets a held object aside under. */
	aside: (of: string): Identity<"aside"> =>
		mint("aside", [of], [asideSegment, ...nameSegments(of)], `${of} set aside`, hashed),
	/**
	 * The name a migration sets the cluster role `role` aside under while it renames logins (deploy/diff/declared.ts
	 * loginRenamed), `__aside_<digest>`: its stem the lead word alone, so its length is one whatever the role's
	 * (maxRolePrefixBytes) and every role prefix within maxRolePrefixBytes leads it within maxIdentifierBytes. An object's
	 * aside name (identity.aside) takes no prefix, so it keeps its readable stem.
	 */
	roleAside: (role: string): Identity<"roleAside"> =>
		mint("roleAside", [role], [asideSegment], `the role ${role} set aside`, hashed),
	/** The name an index is built under before it is swapped in for `of`. */
	swap: (of: string): Identity<"swap"> =>
		mint("swap", [of], ["next", ...nameSegments(of)], `the next ${of}`, hashed)
})

declare const fittedBrand: unique symbol

/** The kinds of identity whose readable name joins a schema's name to more, so one may not fit PostgreSQL's
 * maxIdentifierBytes: a login's or role's PostgreSQL role, `<schema>__<name>`, and a level's schema of whole views,
 * `__<schema>`. */
type FittedKind = "login" | "role" | "wholeSchema"

/** An identity of a FittedKind that fits PostgreSQL's maxIdentifierBytes: minted only by `fitted`, which refuses one that
 * does not. */
export type Fitted<K extends FittedKind> = Identity<K> & { readonly [fittedBrand]: true }

/** `named` as the Fitted identity it is, once its length is checked. */
const fittedOf = <K extends FittedKind>(named: Identity<K>): Fitted<K> =>
	nominal<Identity<K>, Fitted<K>>()(named)

/** An identity of a FittedKind, refused at `loc` as IdentifierTooLong of `declaration` when it does not fit PostgreSQL's
 * maxIdentifierBytes. */
const fitted = <K extends FittedKind>(
	named: Identity<K>,
	declaration: string,
	loc: SourceLoc
): Fitted<K> => {
	const bytes = utf8Length(named.identifier)
	if (bytes > maxIdentifierBytes) {
		throw new Refusal(
			CompileError.make({
				_tag: "IdentifierTooLong",
				at: loc,
				declaration,
				identifier: named.identifier,
				bytes,
				limit: maxIdentifierBytes
			})
		)
	}
	return fittedOf(named)
}

/** A login's PostgreSQL role, its stem, under the installation (roles are cluster-wide), by the name its ownership
 * declared (schema/own.ts ownLogin), or its refusal at `loc` (fitted): what login(...) carries as its stem
 * (schema/stem.ts) and the installer creates (physical/ddl/roles.ts). */
export const loginIdentity = (
	installation: Identity<"schema">,
	name: DeclaredName,
	loc: SourceLoc
): Fitted<"login"> =>
	fitted(identity.login(installation, name), `login name ${JSON.stringify(name)}`, loc)

/** A role's PostgreSQL role, its theory role and its stem, under the installation, by the name its ownership declared
 * (schema/own.ts ownRole). */
export const roleIdentity = (
	installation: Identity<"schema">,
	name: DeclaredName,
	loc: SourceLoc
): Fitted<"role"> =>
	fitted(identity.role(installation, name), `role name ${JSON.stringify(name)}`, loc)

/** A level's schema of the whole views of its relations (identity.wholeSchema), refused at `loc`, where `declaration` is
 * read through it, as IdentifierTooLong when `__<schema>` does not fit (fitted): what a role holding one of the level's
 * relations whole reads it through (physical/ddl/names.ts nameRole). */
export const wholeSchemaIdentity = (
	level: Identity<"schema">,
	declaration: string,
	loc: SourceLoc
): Fitted<"wholeSchema"> => fitted(identity.wholeSchema(level.identifier), declaration, loc)
