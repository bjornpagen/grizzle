import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import type { WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import {
	arrayText,
	catchRefusal,
	KeyLedger,
	Refusal,
	sameContent,
	unwrap
} from "#compiler/core/canonical.ts"
import type { KeyFault, RoleRule } from "#compiler/core/causes.ts"
import {
	CompileError,
	type CompileReason,
	type KeyRefusal,
	malformedDescription,
	type ProseTag,
	prose,
	undeclaredRelation
} from "#compiler/core/errors.ts"
import { type IdentityDigest, schemaFingerprint } from "#compiler/core/fingerprint.ts"
import {
	admitSchemaName,
	conversionOf,
	type DeclaredName,
	DeclaredNamespace,
	decodedColumnFits,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import { namedatalen } from "#compiler/core/identity.ts"
import {
	type ColumnIdent,
	type ConstraintName,
	FieldId,
	type IdentityKind,
	type RelationIdent,
	type SchemaFingerprint
} from "#compiler/core/ids.ts"
import { labeledChildLoc, SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { type NonEmptyCanonicalSet, nonEmptyNameSet } from "#compiler/core/set.ts"
import {
	type AdmittedClosedRelation,
	candidateKeyFields,
	fieldTermsOf,
	type CompareOp,
	conjunctsOf,
	type ContextDesc,
	decodeRoleOver,
	descIdentities,
	descIdentity,
	descText,
	descTextOver,
	type ExprDesc,
	exprChildren,
	type FieldDesc,
	fieldTypes,
	type LiteralDesc,
	type LoginDesc,
	nestedFields,
	type QueryDesc,
	type DerivedStorage,
	definitionFields,
	heldRelation,
	leadsWithHeading,
	type RelationDesc,
	type RoleDesc,
	type RoleEntryDesc,
	type RoleWritingKey,
	type RosterDesc,
	levelChain,
	rosterOrderOf,
	type SchemaDesc,
	type SchemaRelationDesc,
	schemaLevelDesc,
	type SelectionDesc,
	type SideDesc,
	type SlotsDesc,
	type StatementDesc,
	type TermDesc,
	termText,
	type UnitDesc,
	type UnitFieldDesc,
	type Writing,
	writtenNames
} from "#compiler/ir/desc.ts"
import type { Inserts } from "#compiler/ir/law.ts"
import type { OwnedSchema } from "#compiler/ir/products.ts"
import type { DeclaredKey } from "#compiler/ir/rel.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { isDrawnType, isNaturalDesc, naturalDescriptor } from "#compiler/scalar/natural.ts"
import { descCapabilities } from "#compiler/scalar/registry.ts"
import {
	type DeclaredEntries,
	derivedStatement,
	mergedDeclared,
	mergedEntry,
	noDeclaredEntries
} from "#compiler/schema/declared-entries.ts"
import { type WritableEntry, writableEntry } from "#compiler/schema/entry.ts"
import {
	canonicalFunctions,
	type OwnedFunction,
	ownFunctions
} from "#compiler/schema/function-own.ts"
import type { SchemaContent } from "#compiler/schema/levels.ts"
import { type KeyLayout, keyLayout } from "#compiler/schema/representability.ts"
import { determines, entryScope, type Scope } from "#compiler/schema/scope.ts"
import { foreignInput } from "#compiler/schema/terms.ts"
import { approximates, attachesHeading, queryUses } from "#compiler/schema/walk.ts"
import type { StatedEntry } from "#compiler/types/changeset/changeset.ts"

/**
 * The most UTF-8 bytes of one roster handle. A roster's names constant holds its handles as one name[], and a name
 * keeps at most NAMEDATALEN - 1 bytes of its text, clipping a longer one at a character boundary: a longer handle would
 * decode clipped, and two that share their first NAMEDATALEN - 1 bytes would decode alike.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one roster handle in UTF-8, as its roster's names constant holds it in a name
 * @derivation NAMEDATALEN less its terminating zero, as namein clips a name: "len = pg_mbcliplen(s, len, NAMEDATALEN -
 *   1);" (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/name.c, verified 2026-11-20)
 * @from {@link namedatalen}
 */
export const handleMaxBytes = namedatalen - 1

/**
 * An owned field: `named` is its column's identity at the naming door and `column` that identity's identifier; `writing`
 * says how it is written, by its caller unless PostgreSQL generates it from its row.
 */
interface OwnedField {
	readonly id: FieldId
	readonly name: DeclaredName
	readonly desc: FieldDesc
	readonly writing: Writing
	readonly named: Identity<"column">
	readonly column: ColumnIdent
}

export interface OwnedKey {
	readonly fields: DeclaredKey
	readonly primary: boolean
	/** The key's identity at the naming door, a primary key's or a candidate key's over its fields in declared order. */
	readonly named: Identity<"primaryKey" | "key">
	/** The constraint identifier, the identity's. */
	readonly constraint: ConstraintName
	readonly loc: SourceLoc
}

/** An owned row check: its identity at the naming door and its constraint identifier, the identity's. */
export interface OwnedCheck {
	readonly named: Identity<"check">
	readonly constraint: ConstraintName
}

/** What an owned relation of any kind holds before its kind: its name, level and location. */
type OwnedBase = Omit<Owning<RelationDesc["kind"]>, "kind" | "desc">

/**
 * An owned relation of kind K. `level` is the schema level that declares it: 0 for the root schema, n for its n-th
 * extension.
 */
interface Owning<K extends RelationDesc["kind"]> {
	readonly name: DeclaredName
	readonly kind: K
	readonly level: number
	readonly desc: Extract<SchemaRelationDesc, { readonly kind: K }>
	readonly loc: SourceLoc
}

/**
 * What an installed relation is named by: `named` its table's, roster domain's or materialized view's identity at the
 * naming door, and `ident` that identity's identifier. A closed relation and a live derived relation install no
 * relation of their own.
 */
interface Installed<K extends "table" | "rosterDomain" | "view"> {
	readonly named: Identity<K>
	readonly ident: RelationIdent
}

export type OwnedRelation =
	| (Owning<"relation"> &
			Installed<"table"> & {
				readonly fields: Readonly<Record<string, OwnedField>>
				/** Its primary key, then each key statement's key over it, in statement order. */
				readonly keys: readonly [OwnedKey, ...ReadonlyArray<OwnedKey>]
				/** Each row check statement's check over it, in statement order. */
				readonly checks: ReadonlyArray<OwnedCheck>
				readonly mutable: boolean
				readonly inserts: Inserts
			})
	| (Owning<"closed"> &
			Installed<"rosterDomain"> & {
				/**
				 * The roster its handles type, its handles' digest taken once here, which every reading of the owned schema
				 * types a closed id over it by.
				 */
				readonly roster: Roster
				/** Its one field, its handle under `id`. */
				readonly fields: Readonly<Record<string, OwnedField>>
				readonly keys: readonly []
				readonly mutable: false
			})
	| (Owning<"closedRelation"> & {
			readonly fields: Readonly<Record<string, OwnedField>>
			readonly keys: readonly []
			readonly mutable: false
	  })
	| (Owning<"derived"> & {
			readonly fields: Readonly<Record<string, never>>
			readonly keys: readonly []
			readonly mutable: false
			readonly reads: ReadonlyArray<string>
			/** Its materialized view, where PostgreSQL stores its rows; a live one's are its definition's alone. */
			readonly view: OwnedView
	  })

/** Where a derived relation's rows are: its definition's alone, or a materialized view of them too. */
export type OwnedView =
	| { readonly kind: "live" }
	| ({ readonly kind: "materialized" } & Installed<"view">)

/**
 * An owned contract: its declared name, its type-level brand, its descriptor, and its level, the lowest level of a
 * stored relation whose fields hold its values (the root's for natural, which every schema owns): the lowest level
 * whose schema, owned alone, owns it, and so states its law. Ownership names no installed object for it: its domain is
 * named by the domain's physical definition, which only the installation's names spell (physical/ddl/names.ts
 * InstallNames.contractNamed), so contracts of one definition share one domain.
 */
export interface OwnedContract {
	readonly name: DeclaredName
	readonly desc: FieldDesc & { readonly kind: "contract" }
	readonly loc: SourceLoc
	readonly level: number
}

/**
 * Ownership: a SchemaDesc to an OwnedSchema.
 *
 * own() is the first compiler pass over a schema. It turns the Description the builders recorded, or one a caller
 * deserialized, into the owned product: canonical fields with stable FieldIds, closed facts, declarations and their
 * source locations, the derived PostgreSQL identifiers, and the schema fingerprint. It is pure, returns a Result, and
 * never throws. It refuses, each with its source location:
 *
 * - a malformed description, or a statement naming a relation, field or handle no level declares
 *   (MalformedDescription), including a derived relation outside an extension, a derived level that disagrees with
 *   what the definition reads, a definition that reads its own level or above, and a definition that reads a parameter
 *   or a context;
 * - a relation, closed relation or contract name reused with a conflicting descriptor (DuplicateIdentity);
 * - a roster handle longer than a name's 63 bytes, and a closed relation's row value of a closedId field, at
 *   any contract depth, or a selection or row check literal compared with one, that is not a handle of its roster
 *   (MalformedDescription);
 * - a side term pred of a field that is not natural, a selection or row check that reads anything but its own row,
 *   and a key over a closed relation (MalformedDescription);
 * - a key over a field of a type with no equality, and a side that reads one, as bytes is (UnsupportedOperation,
 *   scalar/registry.ts descCapabilities);
 * - a family, tree, fold, alternatives or mutable statement over anything but ordinary relations (a derived relation's
 *   rows are its definition's, which no write draws), its slots' owner one with a field of its count, and a roster
 *   (MalformedDescription); a key's, a check's or a containment's side may read a derived relation, its terms and
 *   selection fields of the definition's heading, and the theory reads the rule over its definition
 *   (analysis/theory/query.ts);
 * - a primary or candidate key whose index entry can exceed PostgreSQL's limit (UnrepresentableKey, representability.ts),
 *   which ownership carries in `unrepresentable` and the compile refuses where it ends, with every other such key;
 * - a declared name the naming door's rule refuses (MalformedDescription, core/identity.ts parseDeclaredName, and
 *   parseSchemaName for the schema's), and two names of one namespace that convert to one identifier
 *   (IdentifierCollision with both locations, core/identity.ts DeclaredNamespace), a role's views included.
 *
 * Semantic identity excludes allocation order, callback identity, aliases and source locations.
 * Equivalent declarations agree: a relation, closed relation or statement declared twice identically is one
 * declaration, and the canonical description sorts each level's relations by name and its statements by identity
 * digest (ir/desc.ts descIdentity), and a closed relation holds its rows as a set by key (ir/desc.ts
 * AdmittedClosedRelation). A statement is canonicalized first: a check's and a selection's conjunctions and
 * disjunctions have their operands in canonical order, each comparison its canonical orientation and each IN list its
 * values in canonical order, so that reordered but equal declarations share one text. Roster order is kept, because it
 * is comparison order. The fingerprint hashes that canonical description (core/fingerprint.ts schemaFingerprint).
 * PostgreSQL identifiers are part of the installation artifact, not of the fingerprint.
 *
 * The owned schema: the frozen schema product (desc and fingerprint, ir/products.ts) with what ownership resolved
 * beside it.
 */
export interface Owned extends OwnedSchema {
	readonly name: string
	/**
	 * Each level of the schema, root first and the schema itself last: its declared name, the identity at the naming door
	 * of the PostgreSQL schema its relations install in, and its own fingerprint, the owned fingerprint of the schema
	 * whose top it is. An owned relation's `level` indexes it. The root's schema also holds what is the installation's
	 * own, every level's alike: its migrations ledger, its functions and its contract and text domains.
	 */
	readonly levels: NonEmptyReadonlyArray<OwnedLevel>
	readonly relations: Readonly<Record<string, OwnedRelation>>
	/**
	 * Every statement of every level, deduplicated, in canonical order, each at its location in the decoded description.
	 */
	readonly statements: ReadonlyArray<OwnedStatement>
	/**
	 * Each statement's index in `statements` by its canonical text (CanonicalStatement text): the owned statement a declared
	 * statement of any level is, which a law's `statements` name.
	 */
	readonly statementAt: ReadonlyMap<string, number>
	/**
	 * Each statement's level, by its index in `statements`: the lowest level that states it, whose schema, owned alone,
	 * states it and so every law it states (deploy/snapshot/build.ts levelsOf).
	 */
	readonly statementLevels: ReadonlyArray<number>
	/**
	 * Each statement's catalog entry, by its index in `statements`: the entry its author declares for the laws it states
	 * (law(...)), or none, so each law's is derived (types/changeset StatedEntry).
	 */
	readonly statementEntries: ReadonlyArray<StatedEntry>
	/** Every unit the schema's levels declare, by its name, each with the stored relations under it (OwnedUnit). */
	readonly units: ReadonlyMap<string, OwnedUnit>
	/** The unit each stored relation under one sits under, by the relation's name: one unit at most a relation. */
	readonly unitOf: ReadonlyMap<string, UnitMember>
	/**
	 * The catalog entries the schema's declarations declare for the laws no statement states: a relation's primary key's,
	 * a generated field's, a refined text's pattern law's and a contract's (schema/declared-entries.ts DeclaredEntries).
	 */
	readonly declared: DeclaredEntries
	readonly contracts: Readonly<Record<string, OwnedContract>>
	/** Every function a level declares, by its declared name (schema/function-own.ts). */
	readonly functions: Readonly<Record<string, OwnedFunction>>
	/** Every field of every relation and closed relation, sorted. */
	readonly fieldIds: ReadonlyArray<FieldId>
	/**
	 * The declared keys whose index entry no index holds, in the order ownership met them (ownKey): owned all the same,
	 * so the compile goes on to meet every other such key and refuses them all where it ends (core/canonical.ts
	 * KeyLedger), each stage's ledger starting from these.
	 */
	readonly unrepresentable: ReadonlyArray<KeyRefusal>
}

/** One level of an owned schema (Owned.levels). */
export interface OwnedLevel {
	readonly name: string
	readonly installation: Identity<"schema">
	readonly fingerprint: SchemaFingerprint
	readonly loc: SourceLoc
}

/** A statement's side beside the terms it pairs: its relation and its selection. */
export type SideScope = Omit<SideDesc, "terms">

/** A term of a statement's left side with the term of its right side at its position: a contained's left and right. */
export interface SidePair {
	readonly left: TermDesc
	readonly right: TermDesc
}

/**
 * What ownership made of a key statement. A key over a whole relation whose terms are all fields is a candidate key of
 * the relation, its identity minted, which the relation's keys hold beside its primary key. A key over a selection or
 * with a pred term constrains only the facts its side reads, so it is no key of the relation: it is a law over the
 * side, which the law model lowers from the statement's side.
 */
export type OwnedKeyLaw =
	| { readonly kind: "candidate"; readonly key: OwnedKey }
	| { readonly kind: "projected" }

/**
 * A statement as ownership admitted it. A statement over two sides holds their scopes and their terms paired by
 * position, which ownership parsed once from two sides of one width (pairSides), so no later pass pairs two sides by
 * position. A family, a tree, a fold and an alternatives statement are their Descriptions, whose families the theory
 * resolves.
 */
export type OwnedStatement =
	| Extract<StatementDesc, { readonly kind: "mutable" | "race" | "unit" | "series" }>
	| (Extract<StatementDesc, { readonly kind: "key" }> & { readonly key: OwnedKeyLaw })
	| (Extract<StatementDesc, { readonly kind: "check" }> & { readonly check: OwnedCheck })
	| (Omit<Extract<StatementDesc, { readonly kind: "contained" }>, "left" | "right"> & {
			readonly left: SideScope
			readonly right: SideScope
			readonly pairs: NonEmptyReadonlyArray<SidePair>
	  })
	| Extract<StatementDesc, { readonly kind: "family" | "tree" | "fold" | "alternatives" }>

/**
 * Every identity ownership minted, each once, in relation name order: the installation's, each relation's and its
 * fields', sequences', keys' and checks'. A contract's domain is the installation's to name. The installation's census
 * and its comments read them (physical/install/comments.ts).
 */
/** The identity of the relation PostgreSQL installs for `r`, none for a closed or live derived relation. */
const installedIdentity = (r: OwnedRelation): ReadonlyArray<Identity<IdentityKind>> => {
	switch (r.kind) {
		case "closedRelation":
			return []
		case "derived":
			return r.view.kind === "live" ? [] : [r.view.named]
		case "relation":
		case "closed":
			return [r.named]
	}
}

/**
 * Where the derived relation `name`'s rows are, by its storage: a materialized one's view named at the naming door; a
 * stored one's are its definition's, read live, until its table and upkeep land (ir/desc.ts DerivedStorage).
 */
const ownedView = (name: DeclaredName, storage: DerivedStorage): OwnedView => {
	switch (storage) {
		case "live":
		case "stored":
			return { kind: "live" }
		case "materialized": {
			const named = identity.view(name)
			return { kind: "materialized", named, ident: identifierOf(named) }
		}
	}
}

export const ownedIdentities = (owned: Owned): ReadonlyArray<Identity<IdentityKind>> => [
	...owned.levels.map((l) => l.installation),
	...Object.values(owned.relations).flatMap((r): ReadonlyArray<Identity<IdentityKind>> => [
		...installedIdentity(r),
		...Object.values(r.fields).map((f) => f.named),
		...r.keys.map((k) => k.named),
		...(r.kind === "relation" ? r.checks.map((c) => c.named) : [])
	])
]

/**
 * The rosters a schema declares, in name order, each its declared name and its live handles in declared order: what
 * the installation's codebook holds codes for (ir/codes.ts draftCodebook).
 */
export const rostersOf = (owned: Owned): ReadonlyArray<Roster> =>
	Object.values(owned.relations).flatMap((r) => (r.kind === "closed" ? [r.roster] : []))

/**
 * A function declaration, so that control flow knows a call never returns. Ownership's refusals are Refusals, which
 * own's boundary returns (core/canonical.ts catchRefusal).
 */
function fail(tag: ProseTag, loc: SourceLoc, text: string): never {
	throw new Refusal(CompileError.make(prose(tag, loc, text)))
}

/**
 * A stored relation's keys, its primary key first, each over a set of fields no earlier key of it holds. Two keys over
 * one set hold apart the same rows, whatever order each lists the fields in: they are one law, which one index
 * enforces (ir/law.ts KeyColumnSet), so a second is refused, MalformedDescription at its statement.
 */
const distinctKeys = (
	relation: string,
	keys: NonEmptyReadonlyArray<OwnedKey>
): NonEmptyReadonlyArray<OwnedKey> => {
	const bySet = new TupleMap<NonEmptyCanonicalSet<string>, OwnedKey>()
	for (const key of keys) {
		const set = nonEmptyNameSet(key.fields)
		const held = bySet.get(set)
		if (held !== undefined) {
			fail(
				"MalformedDescription",
				key.loc,
				`each key of ${relation} over a set of fields no other key of it holds; key (${key.fields.join(", ")}) holds the fields of ${held.primary ? "its primary key" : "its key"} (${held.fields.join(", ")}), which holds apart the same rows: state it once`
			)
		}
		bySet.set(set, key)
	}
	return keys
}

/** A refusal for `reason`, a reason with facts beyond a sentence. A function declaration, as fail is. */
function failWith(reason: CompileReason): never {
	throw new Refusal(CompileError.make(reason))
}

/**
 * A unit as ownership resolved it (ir/desc.ts UnitDesc): its name, its key, the lowest level that states it, and every
 * stored relation that sits under it, each relation under one unit at most.
 */
export interface OwnedUnit {
	readonly name: string
	readonly heading: NonEmptyReadonlyArray<UnitFieldDesc>
	readonly level: number
	readonly loc: SourceLoc
	/** Each relation under it, in relation name order. */
	readonly members: ReadonlyArray<UnitMember>
}

/**
 * A stored relation under a unit: the unit's name, and the relation's fields that hold the unit's key, one per field of
 * its heading, in its order: its primary key's first. The isolation checker reads which unit a write or a read of the
 * relation stands in from here, as the stored derived relations' admission does, and neither derives it again.
 */
export interface UnitMember {
	readonly unit: string
	readonly relation: string
	readonly fields: NonEmptyReadonlyArray<string>
}

/**
 * The fields of `relation`'s primary key that hold the key `heading` names, its first, where they are the heading's by
 * name and type in order (ir/desc.ts leadsWithHeading); none where it does not lead with them. Only a stored relation
 * has rows a write adds: a closed relation's are its declaration's, and a derived relation's its definition's.
 */
const leadingFields = (
	relation: OwnedRelation,
	heading: NonEmptyReadonlyArray<UnitFieldDesc>
): NonEmptyReadonlyArray<string> | undefined => {
	switch (relation.kind) {
		case "relation":
			return leadsWithHeading(heading, relation.desc.primaryKey, (f) => relation.fields[f]?.desc)
				? mapNonEmpty(heading, (f) => f.field)
				: undefined
		case "closed":
		case "closedRelation":
		case "derived":
			return undefined
	}
}

/** Whether one unit's heading leads with the other's, by name and type in order: the two would nest. */
const nests = (
	a: NonEmptyReadonlyArray<UnitFieldDesc>,
	b: NonEmptyReadonlyArray<UnitFieldDesc>
): boolean => {
	const [short, long] = a.length <= b.length ? [a, b] : [b, a]
	const types = new Map(long.map((f) => [f.field, f.type] as const))
	return leadsWithHeading(
		short,
		long.map((f) => f.field),
		(f) => types.get(f)
	)
}

/**
 * The units a schema's unit statements declare, each with the stored relations under it (OwnedUnit), and the rules they
 * keep, so that a unit is a partition of rows into locks, each row under one lock at most, which every process that
 * writes or reads the row takes alike:
 *
 * - one name is one unit: two unit statements of one name and two headings are refused, where one statement stated twice
 *   is one statement;
 * - no unit's heading leads with another's, by name and type in order: a relation keyed by the longer would sit under
 *   both, and a lock on the inner key would not exclude a holder of the outer one (two names over one heading alike);
 * - a unit is stated at or below the level of every relation under it, since a process over that level compiles its
 *   writes alone, holding no level above it, and would take none of the unit's locks.
 *
 * And the rule every series statement keeps: its relation is immutable, so its numbers only grow by appends.
 */
const ownUnits = (
	statements: ReadonlyArray<OwnedStatement>,
	levels: ReadonlyArray<number>,
	relations: Readonly<Record<string, OwnedRelation>>,
	levelName: (level: number) => string
): {
	readonly units: ReadonlyMap<string, OwnedUnit>
	readonly unitOf: ReadonlyMap<string, UnitMember>
} => {
	const declared = statements.flatMap(
		(
			st,
			at
		): ReadonlyArray<{
			readonly st: UnitDesc
			readonly level: number
		}> => (st.kind === "unit" ? [{ st, level: defined(levels[at], "a statement's level") }] : [])
	)
	for (const [i, a] of declared.entries()) {
		for (const b of declared.slice(i + 1)) {
			if (a.st.name === b.st.name) {
				fail(
					"MalformedDescription",
					b.st.loc,
					`unit ${b.st.name} over one heading; it is stated over two, (${a.st.heading.map((f) => f.field).join(", ")}) and (${b.st.heading.map((f) => f.field).join(", ")})`
				)
			}
			if (nests(a.st.heading, b.st.heading)) {
				fail(
					"MalformedDescription",
					b.st.loc,
					`unit ${b.st.name} over a heading no other unit's leads with or leads: unit ${a.st.name}'s (${a.st.heading.map((f) => f.field).join(", ")}) and its own (${b.st.heading.map((f) => f.field).join(", ")}) nest, and a lock on the inner key would not exclude a holder of the outer one; declare one of them`
				)
			}
		}
	}
	const unitOf = new Map<string, UnitMember>()
	const units = new Map<string, OwnedUnit>()
	for (const { st, level } of declared) {
		const members: Array<UnitMember> = []
		for (const name of Object.keys(relations).toSorted(compareStrings)) {
			const r = defined(relations[name], "a relation of its schema")
			const fields = leadingFields(r, st.heading)
			if (fields === undefined) {
				continue
			}
			if (r.level < level) {
				fail(
					"MalformedDescription",
					st.loc,
					`unit ${st.name} stated at or below the level of every relation under it; ${name}, keyed (${fields.join(", ")}, …), is a relation of ${levelName(r.level)}, below ${levelName(level)}, whose writes a process over ${levelName(r.level)} compiles without it: state the unit at ${levelName(r.level)}`
				)
			}
			const member: UnitMember = Object.freeze({ unit: st.name, relation: name, fields })
			members.push(member)
			unitOf.set(name, member)
		}
		units.set(
			st.name,
			Object.freeze({
				name: st.name,
				heading: st.heading,
				level,
				loc: st.loc,
				members: Object.freeze(members)
			})
		)
	}
	for (const st of statements) {
		if (st.kind === "mutable" && !unitOf.has(st.relation)) {
			failWith({
				_tag: "Refused",
				at: st.loc,
				refusal:
					"mutable over a relation under a unit, whose every change is a write its unit's borrow holds alone: declare the unit its primary key leads with, unit(name, { …its leading key fields }), or keep it closed and record each change as an inserted fact"
			})
		}
		if (st.kind === "series" && relations[st.relation]?.mutable === true) {
			fail(
				"MalformedDescription",
				st.loc,
				`series ${st.relation} over an immutable relation, whose numbers only grow by appends`
			)
		}
	}
	return { units, unitOf }
}

/** `name` declared, a `kind` at `loc`, into `namespace` (core/identity.ts DeclaredNamespace): the name, parsed, or its
 * refusal. */
const declareName = (
	namespace: DeclaredNamespace,
	name: string,
	kind: string,
	loc: SourceLoc
): DeclaredName => unwrap(namespace.declare(name, kind, loc))

const textOf = (value: unknown): WellFormedText => unwrap(descText(value))

/**
 * natural as every schema owns it (Owner #collectFields), its descriptor a contract's, its canonical text read once,
 * where the module loads, so no schema's ownership encodes it again.
 */
const naturalOwned = ((): {
	readonly desc: FieldDesc & { readonly kind: "contract" }
	readonly text: string
	readonly loc: SourceLoc
} => {
	const desc = naturalDescriptor.desc
	if (desc.kind !== "contract") {
		throw defect("natural is a contract")
	}
	return { desc, text: textOf(desc), loc: SourceLoc("natural", []) }
})()

const scopeOf = (side: SideDesc): SideScope => ({
	relation: side.relation,
	selection: side.selection
})

/** The terms of a statement's two sides paired by position (OwnedStatement): sides of one width. */
const pairSides = (
	left: SideDesc,
	right: SideDesc,
	s: StatementEntry
): NonEmptyReadonlyArray<SidePair> => {
	const unequal = (): never =>
		failWith({ _tag: "Refused", at: s.desc.loc, refusal: "the sides' field types differ" })
	if (right.terms.length > left.terms.length) {
		unequal()
	}
	return mapNonEmpty(left.terms, (l, i) => {
		const r = right.terms[i]
		return r === undefined ? unequal() : { left: l, right: r }
	})
}

interface RelationEntry {
	readonly desc: SchemaRelationDesc
	readonly level: number
}

/** A relation that stores facts: an ordinary or a closed relation, never a derived one. */
type StoredRelationDesc = Exclude<SchemaRelationDesc, { readonly kind: "derived" }>

/** A relation a law names, with its heading: a stored relation declared at the law's level or below. */
interface LawRelationEntry {
	readonly desc: StoredRelationDesc
	readonly level: number
	readonly heading: Readonly<Record<string, FieldDesc>>
}

/** A law's relation that is an ordinary relation, whose facts its callers write. */
interface OrdinaryEntry extends LawRelationEntry {
	readonly desc: OrdinaryRelationOf
}

/** The relation a rule's side reads: a stored relation with its heading, or a derived one with its definition's fields. */
type SideRelationEntry =
	| { readonly kind: "stored"; readonly entry: LawRelationEntry }
	| { readonly kind: "derived"; readonly name: string; readonly fields: ReadonlySet<string> }

interface StatementEntry {
	readonly desc: StatementDesc
	readonly level: number
	readonly text: string
	/** The statement's identity digest (ir/desc.ts descIdentity): its place in a level's canonical order. */
	readonly identity: IdentityDigest
	/** The catalog entry its author declares for its laws, each written copy's merged (mergedEntry), or none. */
	readonly entry: StatedEntry
}

/** The entries of a map in name order, as `[...map.keys()].sort()` orders the names. */
const byName = <V>(map: ReadonlyMap<string, V>): ReadonlyArray<readonly [string, V]> =>
	[...map].toSorted(([a], [b]) => compareStrings(a, b))

/** A roster's heading: its handle, under `id`. */
const rosterHeading = (desc: RosterDesc): Readonly<Record<string, FieldDesc>> => ({
	id: { kind: "closedId", roster: desc.name, only: undefined }
})

/** A stored relation's heading: an ordinary or closed relation's fields' types, a roster's handle. */
const headingOf = (desc: StoredRelationDesc): Readonly<Record<string, FieldDesc>> => {
	switch (desc.kind) {
		case "relation":
			return fieldTypes(desc.fields)
		case "closed":
			return rosterHeading(desc)
		case "closedRelation":
			return desc.fields
	}
}

/** An ordinary relation's Description. */
type OrdinaryRelationOf = Extract<RelationDesc, { readonly kind: "relation" }>

/** The closedId a descriptor is, through any depth of contracts. */
const closedIdBase = (desc: FieldDesc): (FieldDesc & { readonly kind: "closedId" }) | undefined =>
	desc.kind === "closedId" ? desc : desc.kind === "contract" ? closedIdBase(desc.base) : undefined

/** The roster a closed relation's closed-id field `field` is over, through any depth of contracts. */
const fieldRosterOf = (r: AdmittedClosedRelation, field: string): string | undefined => {
	const desc = r.fields[field]
	return desc === undefined ? undefined : closedIdBase(desc)?.roster
}

const isHandle = (roster: StoredRelationDesc, value: LiteralDesc): boolean =>
	roster.kind === "closed" && isRosterHandle(roster, value)

const isRosterHandle = (roster: RosterDesc, value: LiteralDesc): boolean =>
	typeof value === "string" && roster.handles.includes(value)

/** How a closed relation's fields are written: by its declaration, which is its one caller. */
const callerWritten: Writing = Object.freeze({ kind: "caller" })

/** Each comparison's mirror: the operator that holds of the same two operands written the other way round. */
const mirrorOf: { readonly [Op in CompareOp]: CompareOp } = {
	eq: "eq",
	ne: "ne",
	lt: "gt",
	le: "ge",
	gt: "lt",
	ge: "le"
}

/** Whether an operand is a bare literal, which takes the type of the term it meets and so never stands first. */
const isBare = (e: ExprDesc): boolean => e.kind === "literal" && e.type === undefined

/**
 * A canonical form with its canonical text (ir/desc.ts descText), read once where the form is made: a form made of
 * canonical parts is written from their texts (ir/desc.ts descTextOver), so no part is encoded twice.
 */
interface Canonical<T> {
	readonly form: T
	readonly text: WellFormedText
}

/** A form that is canonical as it is, with its text. */
const asIs = <T>(form: T): Canonical<T> => ({ form, text: textOf(form) })

/** A form made of canonical parts: each member `parts` names holds one, written from the text `parts` maps it to. */
const madeOf = <T>(form: T, parts: ReadonlyMap<string, WellFormedText>): Canonical<T> => ({
	form,
	text: unwrap(descTextOver(form, parts))
})

/**
 * The canonicalizer's rules, each a rewrite of a predicate that keeps its meaning, so two spellings of one predicate are
 * one form, of one text, law name and SQL. No operation of a row check raises (scalar/compute/registry.ts Totality), so
 * no order the rules choose carries meaning:
 * - `orientation`: a comparison in the one orientation of the two that mean it (`comparison`);
 * - `connectives`: a conjunction's or a disjunction's operands in canonical text order;
 * - `conjuncts`: a selection's conjuncts flattened (ir/desc.ts conjunctsOf), each once, in canonical text order, a
 *   conjunction being the set of its conjuncts;
 * - `inValues`: an IN list's values each once, in canonical text order;
 * - `inOfOne`: an IN list of one value the equality with it, which it means (`x IN (v)` is `x = v`, NULL where either
 *   is, and PostgreSQL stores it as `=`).
 *
 * The canonical form is every rule's, and every snapshot a draft reads holds its statements in it: grizzle writes no
 * other, and a format whose canonical form gains a rule has its record converted.
 */
interface Canonicalizer {
	readonly selection: (selection: SelectionDesc) => SelectionDesc
	readonly statement: (s: StatementDesc) => CanonicalStatement
}

/** The canonicalizer: each rule applied, recursively, every other part kept as written. */
const canonicalizer = (): Canonicalizer => {
	/**
	 * A comparison in the one orientation of the two that mean it, under `orientation`: a bare literal stands second; of
	 * two operands that may stand either way, eq and ne put them in canonical text order, and an ordering is stated as lt
	 * or le. Each of PostgreSQL's comparison operators has its mirror as its commutator: both are NULL when either operand
	 * is, and both read NaN as above every other float, so the two orientations mean the same.
	 */
	const comparison = (
		expr: Extract<ExprDesc, { readonly kind: "compare" }>
	): Canonical<ExprDesc> => {
		const left = predicate(expr.left)
		const right = predicate(expr.right)
		const swapped =
			isBare(left.form) !== isBare(right.form)
				? isBare(left.form)
				: expr.op === "eq" || expr.op === "ne"
					? compareStrings(left.text, right.text) > 0
					: expr.op === "gt" || expr.op === "ge"
		const [first, second] = swapped ? [right, left] : [left, right]
		return madeOf(
			Object.freeze({
				...expr,
				op: swapped ? mirrorOf[expr.op] : expr.op,
				left: first.form,
				right: second.form
			}),
			new Map([
				["left", first.text],
				["right", second.text]
			])
		)
	}

	/** A predicate under the rules, recursively. No other term is rewritten: a computation's operands keep their meaning
	 * by position. */
	const predicate = (expr: ExprDesc): Canonical<ExprDesc> => {
		switch (expr.kind) {
			case "and":
			case "or": {
				const each = mapNonEmpty(expr.args, predicate)
				const ordered = sortNonEmpty(each, (a, b) => compareStrings(a.text, b.text))
				const args = mapNonEmpty(ordered, (a) => a.form)
				Object.freeze(args)
				return madeOf(
					Object.freeze({ ...expr, args }),
					new Map([["args", arrayText(ordered.map((a) => a.text))]])
				)
			}
			case "not": {
				const arg = predicate(expr.arg)
				return madeOf(Object.freeze({ ...expr, arg: arg.form }), new Map([["arg", arg.text]]))
			}
			case "compare":
				return comparison(expr)
			case "in": {
				const written = expr.values.map((v) => [textOf(v), v] as const)
				const values = [...new Map(written)].toSorted(([a], [b]) => compareStrings(a, b))
				const [only, ...others] = values
				if (only !== undefined && others.length === 0) {
					return comparison(
						Object.freeze({
							kind: "compare",
							op: "eq",
							left: expr.arg,
							right: Object.freeze({ kind: "literal", value: only[1] })
						})
					)
				}
				const arg = predicate(expr.arg)
				return madeOf(
					Object.freeze({
						...expr,
						arg: arg.form,
						values: Object.freeze(values.map(([, v]) => v))
					}),
					new Map([
						["arg", arg.text],
						["values", arrayText(values.map(([text]) => text))]
					])
				)
			}
			case "var":
			case "field":
			case "value":
			case "parent":
			case "param":
			case "literal":
			case "compute":
			case "cast":
			case "guarded":
			case "base":
			case "cond":
			case "when":
			case "between":
			case "allen":
			case "pointIn":
			case "absent":
			case "exists":
			case "closedAt":
			case "closedRow":
			case "closedHas":
			case "call":
				return asIs(expr)
		}
	}

	/** A selection under the rules with its text: each conjunct's predicate, and its conjuncts' own
	 * conjuncts, each once, in the order of their canonical texts, so two selections of one set of conjuncts are one
	 * selection, and one of none reads every fact. */
	const selection = (s: SelectionDesc): Canonical<SelectionDesc> => {
		const each = [
			...new Map(
				s.conjuncts
					.flatMap(conjunctsOf)
					.map(predicate)
					.map((c) => [c.text, c.form] as const)
			)
		].toSorted(([a], [b]) => compareStrings(a, b))
		return madeOf(
			Object.freeze({ conjuncts: Object.freeze(each.map(([, conjunct]) => conjunct)) }),
			new Map([["conjuncts", arrayText(each.map(([text]) => text))]])
		)
	}

	/** A side under the rules: its selection's. */
	const side = (s: SideDesc): Canonical<SideDesc> => {
		const chosen = selection(s.selection)
		return madeOf(
			Object.freeze({ ...s, selection: chosen.form }),
			new Map([["selection", chosen.text]])
		)
	}

	/** A statement under the rules: a check's predicate and each side's selection. Equivalent declarations then have one
	 * canonical text, one fingerprint, and are one declaration. */
	const canonicalStatement = (s: StatementDesc): Canonical<StatementDesc> => {
		switch (s.kind) {
			case "check": {
				const p = predicate(s.predicate)
				return madeOf(Object.freeze({ ...s, predicate: p.form }), new Map([["predicate", p.text]]))
			}
			case "key": {
				const one = side(s.side)
				return madeOf(Object.freeze({ ...s, side: one.form }), new Map([["side", one.text]]))
			}
			case "contained": {
				const left = side(s.left)
				const right = side(s.right)
				return madeOf(
					Object.freeze({ ...s, left: left.form, right: right.form }),
					new Map([
						["left", left.text],
						["right", right.text]
					])
				)
			}
			case "fold": {
				const step = side(s.step)
				return madeOf(Object.freeze({ ...s, step: step.form }), new Map([["step", step.text]]))
			}
			case "mutable":
			case "race":
			case "family":
			case "tree":
			case "alternatives":
			case "unit":
			case "series":
				return asIs(s)
		}
	}

	return Object.freeze({
		selection: (s: SelectionDesc) => selection(s).form,
		statement: (s: StatementDesc) =>
			Object.freeze({ ...canonicalStatement(s), entry: derivedStatement })
	})
}

/** The canonical form: every rule's. */
const everyRule = canonicalizer()

/** A selection in canonical form. */
export const canonicalSelection = everyRule.selection

/**
 * A statement in canonical form and that form's canonical text: equal statements, however written, have one, and a
 * schema keeps one statement of each (Owner's collectStatements, schema/levels.ts levelContent). Beside them, outside
 * both and so outside the statement's identity, the catalog entry its author declares for the laws it states
 * (law(...), statements.ts lawBuilder), or none, so each law's is derived (types/changeset StatedEntry).
 */
export interface CanonicalStatement {
	readonly form: StatementDesc
	readonly text: string
	readonly entry: StatedEntry
}

/** A statement's canonical form and text (CanonicalStatement), read once where the statement is built or enters, with
 * no entry declared. */
export const canonicalStatementOf = everyRule.statement

/** The row's fields an expression references, added to `out`; a variable, value, parameter or literal holds none. */
const fieldRefs = (expr: ExprDesc, out: Set<string>): Set<string> => {
	if (expr.kind === "field") {
		out.add(expr.field)
	}
	for (const c of exprChildren(expr)) {
		fieldRefs(c.term, out)
	}
	return out
}

/** A statement as a diagnostic names it: its kind and the relations it is over. */
export const statementLabel = (s: StatementDesc): string => {
	switch (s.kind) {
		case "key":
			return `key (${s.side.terms.map(termText).join(", ")}) of ${s.side.selection.conjuncts.length === 0 ? "" : "selected "}${s.side.relation}`
		case "mutable":
			return `mutable ${s.relation}`
		case "race":
			return `race ${s.relation}`
		case "check":
			return `check ${s.name}`
		case "contained":
			return `contained ${s.left.relation} in ${s.right.relation}`
		case "family":
			return `${s.order} ${s.member.relation} in ${s.slots.owner}.${s.slots.count}`
		case "tree":
			return `tree ${s.member.relation}`
		case "fold":
			return `fold ${s.monoid} of ${s.step.relation} into ${s.end.relation}`
		case "alternatives":
			return `alternatives ${s.parent.relation}.${s.discriminator}`
		case "unit":
			return `unit ${s.name}`
		case "series":
			return `series ${s.relation}`
	}
}

/**
 * A primary key's layout, or its fault where it is a span alone: PostgreSQL's PRIMARY KEY needs a column before WITHOUT
 * OVERLAPS (42601), and an exclusion constraint is no primary key, so only a candidate key can be a span alone.
 */
const primaryLayout = (layout: KeyLayout): Result.Result<KeyLayout, KeyFault> =>
	layout.gist !== undefined && layout.fields.length === 1
		? Result.err({ kind: "spanAlone", field: layout.gist.span })
		: Result.ok(layout)

/**
 * The key over `keyFields` of the ordinary relation `name` described by `r`, its identity minted: refused when it names a
 * field `r` lacks; where its index entry is unrepresentable, the key refused in `keys` (UnrepresentableKey), and owned
 * all the same, so ownership goes on to meet every other such key.
 */
const ownKey = (
	keys: KeyLedger,
	name: string,
	r: RelationDesc & { readonly kind: "relation" },
	keyFields: DeclaredKey,
	primary: boolean,
	loc: SourceLoc
): OwnedKey => {
	const layout = keyLayout(
		keyFields.map((field) => {
			const decl = r.fields[field]
			if (decl === undefined) {
				return fail(
					"MalformedDescription",
					loc,
					`a key over fields of ${name}; ${field} is not one`
				)
			}
			if (!descCapabilities(decl.type).includes("equality")) {
				return fail(
					"UnsupportedOperation",
					loc,
					`equality: a key over ${name}.${field}, of a type with no equality, as bytes is: no key holds one`
				)
			}
			return { field, desc: decl.type }
		})
	)
	const verdict = primary ? Result.flatMap(layout, primaryLayout) : layout
	if (!verdict.ok) {
		keys.refuse({
			at: loc,
			subject: `key (${keyFields.join(", ")}) of ${name}`,
			key: keyFields,
			fault: verdict.error
		})
	}
	const named = primary ? identity.primaryKey(name) : identity.key(name, keyFields)
	return { fields: keyFields, primary, named, constraint: identifierOf(named), loc }
}

/**
 * The identity at the naming door of a schema's installation under its declared name `name`, declared at `loc`: refused
 * when the name breaks a schema name's rule (core/identity.ts admitSchemaName), IdentifierTooLong past PostgreSQL's
 * identifiers and MalformedDescription otherwise. A command that only places a schema's migrations reads it without
 * owning the schema.
 */
export const schemaInstallation = (
	name: string,
	loc: SourceLoc
): Result.Result<Identity<"schema">, CompileError> =>
	Result.map(admitSchemaName(name, loc), (schemaName) => identity.schema(schemaName))

/** The field a selection's conjunct fixes to a literal, `field = literal` either way round; none for any other. */
const fixedField = (e: ExprDesc): string | undefined => {
	if (e.kind !== "compare" || e.op !== "eq") {
		return undefined
	}
	if (e.left.kind === "field" && e.right.kind === "literal") {
		return e.left.field
	}
	return e.left.kind === "literal" && e.right.kind === "field" ? e.right.field : undefined
}

/** Whether a field is a span, through any depth of contracts: a containment pairing one is a coverage law. */
const spanned = (desc: FieldDesc | undefined): boolean =>
	desc?.kind === "span" || (desc?.kind === "contract" && spanned(desc.base))

/**
 * Whether a side of an ordinary relation reads its facts by fields of no span, every fact or a selection of them: the
 * side a foreign key's columns are, each column a field of the row or, selected, a generated column PostgreSQL computes
 * from it.
 */
const fieldSide = (side: SideDesc, entry: RelationEntry): boolean => {
	const fields = fieldTermsOf(side.terms)
	const desc = entry.desc
	return (
		fields !== undefined &&
		desc.kind === "relation" &&
		!fields.some((f) => spanned(desc.fields[f.field]?.type))
	)
}

/**
 * The levels of a canonical description, root first, each with its installation, minted from its declared name, and
 * its fingerprint, which `fingerprinted` gives the chain of levels. Two levels whose names convert to one PostgreSQL
 * schema are IdentifierCollision.
 */
const ownedLevels = (
	canonical: SchemaDesc,
	fingerprinted: LevelFingerprints
): NonEmptyReadonlyArray<OwnedLevel> => {
	const schemas = new Map<string, SchemaDesc>()
	return mapNonEmpty(fingerprinted(levelChain(canonical)), ({ level, fingerprint }): OwnedLevel => {
		const installation = unwrap(schemaInstallation(level.name, level.loc))
		const ident = identifierOf(installation)
		const prior = schemas.get(ident)
		if (prior !== undefined) {
			failWith({
				_tag: "IdentifierCollision",
				at: level.loc,
				other: prior.loc,
				identifier: ident,
				what: "the installation's schema",
				declaration: `schema ${level.name}`,
				otherDeclaration: `schema ${prior.name}`
			})
		}
		schemas.set(ident, level)
		return {
			name: level.name,
			installation,
			fingerprint,
			loc: level.loc
		}
	})
}

/** The chain of an owned schema's levels, root first, each with its fingerprint. */
type LevelFingerprints = (
	levels: NonEmptyReadonlyArray<SchemaDesc>
) => NonEmptyReadonlyArray<{ readonly level: SchemaDesc; readonly fingerprint: SchemaFingerprint }>

/**
 * Each level's fingerprint hashed over its canonical description (core/fingerprint.ts schemaFingerprint), in the
 * Descriptions' one identity digests (ir/desc.ts descIdentities), reading each part they share once: a base, which the
 * level above holds among its bases, and a query its relations read by many paths, and a part a ChangeSet over the
 * schema digested. What `grizzle generate` and `grizzle check` record and verify.
 */
const hashedLevels: LevelFingerprints = (levels) =>
	mapNonEmpty(levels, (level) => ({
		level,
		fingerprint: unwrap(schemaFingerprint(descIdentities, level))
	}))

/** A level of a schema as its installation's snapshot records it: its declared name and its fingerprint. */
/**
 * Each level's fingerprint as the installation's snapshot records it at the level's position: the fingerprints a layer
 * serves under, which `grizzle generate` hashed and recorded, so the layer hashes none. The snapshot is trusted as the
 * one generate wrote for the schema, which check, drift and migrate verify, so nothing of it is compared with the
 * schema here; a position it records no level at is MalformedDescription, since no fingerprint stands there.
 */
const recordedLevels =
	(recorded: ReadonlyArray<SchemaFingerprint>): LevelFingerprints =>
	(levels) =>
		mapNonEmpty(levels, (level, at) => {
			const fingerprint = recorded[at]
			if (fingerprint === undefined) {
				return fail(
					"MalformedDescription",
					level.loc,
					`a snapshot.json that records level ${at}, schema ${level.name}: it records ${recorded.length} levels`
				)
			}
			return { level, fingerprint }
		})

/** The PostgreSQL schemas an owned schema's levels install in under their declared names, root first. */
export const installationsOf = (owned: Owned): NonEmptyReadonlyArray<Identity<"schema">> =>
	mapNonEmpty(owned.levels, (l) => l.installation)

/** The candidate keys and row checks the statements state over one relation, in statement order. */
interface RelationLaws {
	readonly keys: ReadonlyArray<OwnedKey>
	readonly checks: ReadonlyArray<OwnedCheck>
}

class Owner {
	readonly #schemaName: string
	readonly #levels: NonEmptyReadonlyArray<SchemaDesc>
	readonly #relations = new Map<string, RelationEntry>()
	readonly #statements: Array<StatementEntry> = []
	/** The identity digests of the statements, each part they share digested once (StatementEntry identity). */
	/** Each ordinary relation's namespace of row checks, filled as its check statements are owned. */
	readonly #checkNames = new Map<string, DeclaredNamespace>()
	/**
	 * Each contract by its name: its first descriptor, that descriptor's canonical text, where it was first used, and the
	 * lowest level of a relation that uses it (OwnedContract `level`).
	 */
	readonly #contracts = new Map<
		string,
		{
			readonly desc: FieldDesc & { readonly kind: "contract" }
			readonly text: string
			readonly loc: SourceLoc
			readonly level: number
		}
	>()
	readonly #mutable = new Set<string>()
	/** Each raced relation, by the race statement that races it (#checkRaces). */
	readonly #raced = new Map<string, StatementEntry>()

	/**
	 * Each level's statements, root first, as the level writes them, each in canonical form with its canonical text
	 * (CanonicalStatement): read once where each statement was built or entered.
	 */
	readonly #written: NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>>
	/** The catalog entries the levels' declarations declare for the laws no statement states (Owned declared). */
	readonly #lawEntries: DeclaredEntries

	/** The declared keys whose index entry no index holds, each refused here as ownership meets it (ownKey). */
	readonly #keys: KeyLedger

	constructor(
		desc: SchemaDesc,
		written: NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>>,
		keys: KeyLedger,
		declared: DeclaredEntries
	) {
		this.#levels = levelChain(desc)
		this.#schemaName = desc.name
		this.#written = written
		this.#keys = keys
		this.#lawEntries = declared
	}

	run(fingerprinted: LevelFingerprints): Owned {
		this.#collectRelations()
		this.#checkDerived()
		this.#collectFields()
		this.#collectStatements()
		const statements = this.#statements.map((s) => {
			const statement = this.#checkStatement(s)
			this.#checkLevels(s)
			return { text: s.text, identity: s.identity, level: s.level, entry: s.entry, statement }
		})
		this.#checkRaces(statements.map((s) => s.statement))
		const relations = this.#ownRelations(statements.map((s) => s.statement))
		const { units, unitOf } = ownUnits(
			statements.map((s) => s.statement),
			statements.map((s) => s.level),
			relations,
			(level) => this.#levelName(level)
		)
		const contracts = this.#ownContracts()
		const functions = unwrap(ownFunctions(this.#levels))
		const canonical = this.#canonicalDesc()
		const levels = ownedLevels(canonical, fingerprinted)
		const fingerprint = lastNonEmpty(levels).fingerprint
		const fieldIds = Object.values(relations)
			.flatMap((r) => Object.values(r.fields).map((f) => f.id))
			.toSorted()
		const ordered = statements.toSorted((a, b) => compareStrings(a.identity, b.identity))
		return {
			desc: canonical,
			fingerprint,
			name: this.#schemaName,
			levels,
			relations,
			statements: ordered.map((s) => s.statement),
			statementAt: new Map(ordered.map((s, i) => [s.text, i] as const)),
			statementLevels: ordered.map((s) => s.level),
			statementEntries: ordered.map((s) => s.entry),
			units,
			unitOf,
			declared: this.#lawEntries,
			contracts,
			functions,
			fieldIds,
			unrepresentable: this.#keys.met()
		}
	}

	/**
	 * Each relation a level declares: a derived one only above the base, and one declaration per name. A closed
	 * relation's rows are a set (ir/desc.ts AdmittedClosedRelation), so two declarations of one set of rows are one
	 * declaration.
	 */
	#collectRelations(): void {
		for (const [level, schema] of this.#levels.entries()) {
			for (const r of schema.relations) {
				if (r.kind === "derived" && level === 0) {
					fail(
						"MalformedDescription",
						r.loc,
						`derived relation ${r.name} declared in an extension of the schema its definition reads, schema.extend`
					)
				}
				const prior = this.#relations.get(r.name)
				if (prior === undefined) {
					this.#relations.set(r.name, { desc: r, level })
					continue
				}
				if (textOf(prior.desc) !== textOf(r)) {
					failWith({
						_tag: "DuplicateIdentity",
						at: r.loc,
						duplicate: { kind: "relation", name: r.name, earlier: prior.desc.loc }
					})
				}
			}
		}
	}

	#relation(name: string, loc: SourceLoc, what: string): RelationEntry {
		const entry = this.#relations.get(name)
		if (entry === undefined) {
			return fail(
				"MalformedDescription",
				loc,
				`${what} names ${name}, which no level of the schema declares`
			)
		}
		return entry
	}

	/** A relation the statement `s` names, which some level of the schema declares. */
	#statementRelation(name: string, s: StatementEntry): RelationEntry {
		const entry = this.#relations.get(name)
		if (entry === undefined) {
			return failWith(undeclaredRelation(s.desc.loc, name))
		}
		return entry
	}

	/**
	 * Derived definitions read no parameter and no context: a materialized view holds no session, so no context fact
	 * reaches a derived definition. Each reads a live derived relation through its definition, as the query builder
	 * writes a match of one, never by its name, which no stored relation answers. Each is one level above the highest
	 * derived level it reads.
	 */
	#checkDerived(): void {
		for (const entry of this.#relations.values()) {
			const r = entry.desc
			if (r.kind !== "derived") {
				continue
			}
			const uses = queryUses(r.query)
			if (uses.inputs.size > 0) {
				fail(
					"MalformedDescription",
					entry.desc.loc,
					`a parameterless definition for ${r.name}; it reads ${[...uses.inputs].toSorted(compareStrings).join(", ")}`
				)
			}
			if (uses.contexts.size > 0) {
				fail(
					"MalformedDescription",
					entry.desc.loc,
					`a definition for ${r.name} that matches no context, which a materialized view holds no session for; it matches ${[...uses.contexts.keys()].toSorted(compareStrings).join(", ")}`
				)
			}
			let level = 1
			for (const read of uses.relations) {
				const lower = this.#relation(read, entry.desc.loc, `the definition of ${r.name}`)
				if (lower.desc.kind === "derived" && lower.desc.storage === "live") {
					fail(
						"MalformedDescription",
						entry.desc.loc,
						`a definition of ${r.name} that reads the live derived relation ${read} through its definition; it matches ${read} by name, and a live derived relation stores nothing to match, so a query over it matches the query it is defined by`
					)
				}
				if (lower.level >= entry.level) {
					fail(
						"MalformedDescription",
						entry.desc.loc,
						`a definition over the levels below ${r.name}; ${read} is declared at its own level or above`
					)
				}
				if (lower.desc.kind === "derived") {
					level = Math.max(level, lower.desc.level + 1)
				}
			}
			if (level !== r.level) {
				fail(
					"MalformedDescription",
					entry.desc.loc,
					`derived level ${level} for ${r.name}, one above the highest derived level it reads, not ${r.level}`
				)
			}
		}
	}

	/**
	 * Fields: closed references and sets resolve to declared rosters of the field's level or below, contract names
	 * are not reused with a conflicting descriptor, and str.pattern types a closed relation's own field alone. A derived relation's fields are its definition's, which derived
	 * analysis reads. How many columns a table holds is PostgreSQL's limit, checked where the installation emits the
	 * table (physical/ddl/context.ts). natural is every schema's first, whatever its fields: it is the type of every
	 * count (scalar/aggregate.ts countOverload), and every query over the schema may count.
	 */
	#collectFields(): void {
		this.#contracts.set(naturalOwned.desc.name, { ...naturalOwned, level: 0 })
		const ordered = [...this.#relations.values()].toSorted((a, b) =>
			a.desc.name < b.desc.name ? -1 : 1
		)
		for (const entry of ordered) {
			if (entry.desc.kind === "derived") {
				continue
			}
			const heading = headingOf(entry.desc)
			for (const [field, desc] of Object.entries(heading)) {
				const loc = labeledChildLoc(entry.desc.loc, field, `field ${entry.desc.name}.${field}`)
				nestedFields(desc, (d) => {
					if (d.kind === "closedId" || d.kind === "bits") {
						this.#rosterAt(d.roster, entry, loc, d.kind === "closedId" ? "closedId" : "bits")
					}
					if (d.kind === "pattern" && (entry.desc.kind !== "closedRelation" || d !== desc)) {
						fail(
							"MalformedDescription",
							loc,
							"str.pattern as a closed relation's own field: its values are patterns admitted where the schema compiles, which only a closed relation's rows state"
						)
					}
					if (d.kind === "contract") {
						const prior = this.#contracts.get(d.name)
						if (prior === undefined) {
							this.#contracts.set(d.name, { desc: d, text: textOf(d), loc, level: entry.level })
						} else if (prior.text !== textOf(d)) {
							failWith({
								_tag: "DuplicateIdentity",
								at: loc,
								duplicate: { kind: "contract", name: d.name, earlier: prior.loc }
							})
						} else if (entry.level < prior.level) {
							this.#contracts.set(d.name, { ...prior, level: entry.level })
						}
					}
				})
			}
			switch (entry.desc.kind) {
				case "relation":
					this.#checkDecodedColumns(entry, entry.desc)
					break
				case "closed":
					this.#checkRoster(entry, entry.desc)
					break
				case "closedRelation":
					this.#checkKeySlots(entry, entry.desc)
					break
			}
		}
	}

	/**
	 * Each slot of a closed relation's key names fin(O, n) over a closed relation O of its level or below and a natural
	 * field n of O beside O's key, and O's key pairs with the relation's first key fields, roster for roster in order:
	 * those fields are the owner prefix, which every slot follows and every slot's O shares the length of. That an
	 * owner's count bounds each row's slot code is a law of the codes, checked when the installation packs the relation.
	 */
	#checkKeySlots(entry: RelationEntry, r: AdmittedClosedRelation): void {
		let prefix: number | undefined
		for (const slot of r.slots) {
			const loc = labeledChildLoc(entry.desc.loc, slot.field, `slot ${r.name}.${slot.field}`)
			const fin = `fin(${slot.fin.owner}, ${JSON.stringify(slot.fin.count)})`
			const declared = this.#relations.get(slot.fin.owner)
			if (declared?.desc.kind !== "closedRelation") {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} over a closed relation the schema declares; ${slot.fin.owner} is not one`
				)
			}
			if (declared.level > entry.level) {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} over a closed relation of this level or below; ${slot.fin.owner} is declared above`
				)
			}
			const owner = declared.desc
			const count = owner.fields[slot.fin.count]
			if (count === undefined || owner.key.includes(slot.fin.count) || !isNaturalDesc(count)) {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} counted by a natural field of ${owner.name} beside its key; ${slot.fin.count} is not one`
				)
			}
			const paired = owner.key.every((field, i) => {
				const own = r.key[i]
				const roster = own === undefined ? undefined : fieldRosterOf(r, own)
				return roster !== undefined && roster === fieldRosterOf(owner, field)
			})
			if (!paired || r.key.indexOf(slot.field) < owner.key.length) {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} whose key, ${owner.key.join(", ")}, pairs with ${r.name}'s first key fields in order, roster for roster, the slot after them`
				)
			}
			if (prefix !== undefined && prefix !== owner.key.length) {
				return fail(
					"MalformedDescription",
					loc,
					`slots counted over one owner prefix of ${r.name}'s key; ${fin}'s key has ${owner.key.length} fields where another slot's has ${prefix}`
				)
			}
			prefix = owner.key.length
		}
	}

	/** The roster `roster` a field of `entry` reads, declared at the field's level or below. */
	#rosterAt(roster: string, entry: RelationEntry, loc: SourceLoc, former: string): RosterDesc {
		const declared = this.#relations.get(roster)
		if (declared?.desc.kind !== "closed") {
			return fail(
				"MalformedDescription",
				loc,
				`${former}(${roster}) over a roster the schema declares; ${roster} is not one`
			)
		}
		if (declared.level > entry.level) {
			fail(
				"MalformedDescription",
				loc,
				`${former}(${roster}) over a roster of this level or below; ${roster} is declared above`
			)
		}
		return declared.desc
	}

	/** A roster's handles fit the name its names constant holds each in. */
	/**
	 * A roster's handles must each be a name PostgreSQL stores as written: no NUL (a name ends at its first one, as
	 * NAMEDATALEN's C string does), no lone surrogate (no UTF-8 encodes one), and at most `handleMaxBytes` bytes.
	 */
	#checkRoster(entry: RelationEntry, r: RosterDesc): void {
		for (const handle of r.handles) {
			if (handle.includes("\u0000") || !handle.isWellFormed()) {
				fail(
					"MalformedDescription",
					labeledChildLoc(entry.desc.loc, "handles", `roster of ${r.name}`),
					`handles that hold no NUL and no lone surrogate, as a PostgreSQL name does; ${JSON.stringify(handle)} holds one`
				)
			}
			if (utf8Length(handle) > handleMaxBytes) {
				fail(
					"MalformedDescription",
					labeledChildLoc(entry.desc.loc, "handles", `roster of ${r.name}`),
					`handles of at most ${handleMaxBytes} UTF-8 bytes, the most a name holds (NAMEDATALEN - 1); ${JSON.stringify(handle)} has ${utf8Length(handle)}`
				)
			}
		}
	}

	/**
	 * A role view shows each closed-id field `f` beside its name, the column decodedColumn(f): that column's identifier
	 * fits a name, and no other field of the relation converts to it.
	 */
	#checkDecodedColumns(entry: RelationEntry, r: OrdinaryRelationOf): void {
		const fields = Object.entries(r.fields).map(([field, decl]) => ({
			field,
			decl,
			declared: unwrap(this.#fieldName(field, entry))
		}))
		const columns = new Map(
			fields.map(({ field, declared }) => [conversionOf(declared), field] as const)
		)
		for (const { field, decl, declared } of fields) {
			if (closedIdBase(decl.type) === undefined) {
				continue
			}
			const loc = labeledChildLoc(entry.desc.loc, field, `field ${r.name}.${field}`)
			if (!decodedColumnFits(declared)) {
				fail(
					"MalformedDescription",
					loc,
					`a closed-id field whose decoded column ${field}_name fits a name of ${handleMaxBytes} bytes`
				)
			}
			const other = columns.get(identifierOf(identity.decodedColumn(declared)))
			if (other !== undefined) {
				fail(
					"MalformedDescription",
					loc,
					`a closed-id field whose decoded column ${field}_name is no field of ${r.name}; ${other} is`
				)
			}
		}
	}

	/** A field's name parsed by the naming door, as its relation's ownership declares it. */
	#fieldName(field: string, entry: RelationEntry): Result.Result<DeclaredName, CompileError> {
		return DeclaredNamespace.columns(`relation ${entry.desc.name}'s field`).declare(
			field,
			"field",
			labeledChildLoc(entry.desc.loc, field, `field ${entry.desc.name}.${field}`)
		)
	}

	/**
	 * Each statement a level writes, in its canonical form, kept once however many levels or lists write it, at the
	 * lowest level that does, with the catalog entry any copy's author declares: two copies whose authors declare two
	 * entries are refused (MalformedDescription), since one statement's laws have one name.
	 */
	#collectStatements(): void {
		const at = new Map<string, number>()
		for (const [level, statements] of this.#written.entries()) {
			for (const { form, text, entry } of statements) {
				const known = at.get(text)
				if (known === undefined) {
					at.set(text, this.#statements.length)
					this.#statements.push({
						desc: form,
						level,
						text,
						identity: unwrap(descIdentity(form)),
						entry
					})
					continue
				}
				const first = defined(this.#statements[known], "a statement kept is at its index")
				const merged = mergedEntry(first.entry, entry)
				if (merged === undefined) {
					fail(
						"MalformedDescription",
						form.loc,
						`${statementLabel(form)} written twice, with two catalog entries: one statement's laws have one entry`
					)
				}
				this.#statements[known] = { ...first, entry: merged }
			}
		}
	}

	/**
	 * A relation a statement names, declared at the statement's level or below: a stored relation, or a derived one,
	 * which a key's, a check's and a containment's side may read (`#sideRelation`).
	 */
	#declared(name: string, s: StatementEntry): RelationEntry {
		const entry = this.#statementRelation(name, s)
		if (entry.level > s.level) {
			fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} names ${name}, which a higher level declares`
			)
		}
		return entry
	}

	/**
	 * A stored relation a statement names, declared at the statement's level or below: a family, a tree, a fold, an
	 * alternatives statement and mutable name the rows grizzle writes, which a derived relation's definition states.
	 */
	#lawRelation(name: string, s: StatementEntry): LawRelationEntry {
		const entry = this.#declared(name, s)
		const desc = entry.desc
		if (desc.kind === "derived") {
			return fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} over a stored relation; ${name} is a derived relation, whose rows its definition states and no write draws`
			)
		}
		return { desc, level: entry.level, heading: headingOf(desc) }
	}

	/**
	 * The relation a key's, a check's or a containment's side reads: a stored relation, or a derived relation, read by
	 * its definition's heading, whose fields' types the theory reads (analysis/theory/query.ts).
	 */
	#sideRelation(name: string, s: StatementEntry): SideRelationEntry {
		const entry = this.#declared(name, s)
		const desc = entry.desc
		return desc.kind === "derived"
			? { kind: "derived", name, fields: new Set(definitionFields(desc.query)) }
			: { kind: "stored", entry: { desc, level: entry.level, heading: headingOf(desc) } }
	}

	#ordinary(name: string, s: StatementEntry, why: string): OrdinaryEntry {
		const entry = this.#lawRelation(name, s)
		const desc = entry.desc
		if (desc.kind !== "relation") {
			return fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} over an ordinary relation; ${name} ${why}`
			)
		}
		return { ...entry, desc }
	}

	#requireFields(entry: LawRelationEntry, fields: ReadonlyArray<string>, s: StatementEntry): void {
		for (const f of fields) {
			if (!Object.hasOwn(entry.heading, f)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} names ${entry.desc.name}.${f}, which is not a field of ${entry.desc.name}`
				)
			}
		}
	}

	/**
	 * A key's or a containment's side as ownership admits it: a side of a stored relation (`#checkSide`), or of a derived
	 * relation, each term's field one of its definition's heading and its selection a predicate over that heading's
	 * fields alone; the theory types the terms, the selection and every handle it compares (analysis/theory/query.ts).
	 */
	#checkRuleSide(side: SideDesc, s: StatementEntry): SideRelationEntry {
		const read = this.#sideRelation(side.relation, s)
		if (read.kind === "stored") {
			this.#checkSide(side, s)
			return read
		}
		const requireField = (field: string): void => {
			if (!read.fields.has(field)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} names ${side.relation}.${field}, which is not a field of ${side.relation}`
				)
			}
		}
		for (const t of side.terms) {
			requireField(t.field)
		}
		for (const conjunct of side.selection.conjuncts) {
			const foreign = foreignInput(conjunct)
			if (foreign !== undefined) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} selects ${side.relation} by its row only, not ${foreign}`
				)
			}
			for (const f of fieldRefs(conjunct, new Set())) {
				requireField(f)
			}
		}
		return read
	}

	/**
	 * A law side as ownership admits it: over a stored relation of the statement's level or below, each term a field of
	 * its heading and each pred term's field natural, and its selection a predicate over its own row, every field it
	 * reads the relation's and every handle it compares with a closedId field one of its roster's.
	 */
	#checkSide(side: SideDesc, s: StatementEntry): LawRelationEntry {
		const entry = this.#lawRelation(side.relation, s)
		this.#requireFields(
			entry,
			side.terms.map((t) => t.field),
			s
		)
		for (const t of side.terms) {
			const desc = entry.heading[t.field]
			if (desc !== undefined && !descCapabilities(desc).includes("equality")) {
				fail(
					"UnsupportedOperation",
					s.desc.loc,
					`equality: ${statementLabel(s.desc)} reads ${side.relation}.${t.field}, of a type with no equality, as bytes is: no rule's side reads one`
				)
			}
			if (t.kind === "pred" && (desc === undefined || !isNaturalDesc(desc))) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} reads pred(${side.relation}.${t.field}); pred reads a natural field, and ${t.field} is not one`
				)
			}
		}
		for (const conjunct of side.selection.conjuncts) {
			const foreign = foreignInput(conjunct)
			if (foreign !== undefined) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} selects ${side.relation} by its row only, not ${foreign}`
				)
			}
			this.#requireFields(entry, [...fieldRefs(conjunct, new Set())], s)
			this.#checkPredicateHandles(conjunct, entry.heading, s)
		}
		return entry
	}

	/** The closed relation a closedId descriptor references, through any depth of contracts. */
	#rosterOf(desc: FieldDesc | undefined): RosterDesc | undefined {
		const base = desc === undefined ? undefined : closedIdBase(desc)
		if (base === undefined) {
			return undefined
		}
		const roster = this.#relations.get(base.roster)?.desc
		return roster?.kind === "closed" ? roster : undefined
	}

	/**
	 * A row check's literals compared with a closedId field, at any contract depth, are handles of its roster. Only a
	 * comparison, a range and a set membership compare a field with literals.
	 */
	#checkPredicateHandles(
		predicate: ExprDesc,
		heading: Readonly<Record<string, FieldDesc>>,
		s: StatementEntry
	): void {
		const check = (term: ExprDesc, values: ReadonlyArray<LiteralDesc>) => {
			if (term.kind !== "field") {
				return
			}
			const roster = this.#rosterOf(heading[term.field])
			if (roster === undefined) {
				return
			}
			for (const value of values) {
				if (!isHandle(roster, value)) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(s.desc)} compares ${term.field} with a handle of ${roster.name}; ${JSON.stringify(value)} is not one`
					)
				}
			}
		}
		const literal = (e: ExprDesc): ReadonlyArray<LiteralDesc> =>
			e.kind === "literal" ? [e.value] : []
		switch (predicate.kind) {
			case "compare":
				check(predicate.left, literal(predicate.right))
				check(predicate.right, literal(predicate.left))
				return
			case "between":
				check(predicate.arg, [...literal(predicate.low), ...literal(predicate.high)])
				return
			case "in":
				check(predicate.arg, predicate.values)
				return
			case "and":
			case "or":
				for (const arg of predicate.args) {
					this.#checkPredicateHandles(arg, heading, s)
				}
				return
			case "not":
				this.#checkPredicateHandles(predicate.arg, heading, s)
				return
			case "var":
			case "field":
			case "value":
			case "parent":
			case "param":
			case "literal":
			case "compute":
			case "cast":
			case "guarded":
			case "base":
			case "cond":
			case "when":
			case "allen":
			case "pointIn":
			case "absent":
			case "exists":
			case "closedAt":
			case "closedRow":
			case "closedHas":
			case "call":
				return
		}
	}

	/**
	 * A statement reaches an ordinary relation of a level below its own only where no write of that level changes: as
	 * one side of a containment whose other side is a relation of its own level or above, the lower side's terms fields of
	 * no span, selected or not, into a target, below or not, that holds a key (`#keyOf`), which PostgreSQL holds as a
	 * deferred foreign key judged at COMMIT, its law columns, a selection's or a fixed field's, generated columns
	 * PostgreSQL computes on the row however it is written, into a UNIQUE the key implies, which refuses nothing the key
	 * admits, or by the rule judge at COMMIT, so no write of the lower level is compiled or drawn otherwise and each meets
	 * the law as one above it; in a rule over a query, a containment one of whose sides is a derived relation, or a key or
	 * a check over one, whose deferred triggers or, lowered, deferred foreign keys PostgreSQL runs at COMMIT; or as a row
	 * check over the lower relation, the level's own CHECK on its table, which the level's migration installs and
	 * PostgreSQL judges on every row, so a write of the lower level meets it as a law above, naming it by its level
	 * (types/changeset Law `above`), and changes nothing of how that write is compiled or drawn. A process over the lower
	 * level holds none of the levels above it and compiles its writes alone, so every other reach is LevelRefused: a key,
	 * mutable, a family, tree, fold or alternatives over a lower relation, and a containment with both sides on lower
	 * relations, whose foreign key would order the lower level's own statements, reaching one by a pred or span term, or
	 * into a target no key holds. A roster's, a closed relation's and a derived relation's rows no write changes.
	 */
	#checkLevels(s: StatementEntry): void {
		const lower = (relation: string): RelationEntry | undefined => {
			const entry = this.#relations.get(relation)
			return entry?.desc.kind === "relation" && entry.level < s.level ? entry : undefined
		}
		const refuse = (relation: string, entry: RelationEntry): never =>
			failWith({
				_tag: "LevelRefused",
				at: s.desc.loc,
				statement: statementLabel(s.desc),
				level: this.#levelName(s.level),
				relation,
				below: this.#levelName(entry.level)
			})
		const reach = (relations: ReadonlyArray<string>): void => {
			for (const relation of relations) {
				const entry = lower(relation)
				if (entry !== undefined) {
					refuse(relation, entry)
				}
			}
		}
		const d = s.desc
		const derived = (relation: string): boolean =>
			this.#relations.get(relation)?.desc.kind === "derived"
		switch (d.kind) {
			case "contained": {
				if (derived(d.left.relation) || derived(d.right.relation)) {
					return
				}
				const source = lower(d.left.relation)
				const target = lower(d.right.relation)
				if (source === undefined && target === undefined) {
					return
				}
				const keyed = this.#keyOf(d.right, target ?? this.#statementRelation(d.right.relation, s))
				if (
					source !== undefined &&
					(target !== undefined || !fieldSide(d.left, source) || !keyed)
				) {
					refuse(d.left.relation, source)
				}
				if (target !== undefined && !keyed) {
					refuse(d.right.relation, target)
				}
				return
			}
			case "key":
				return reach([d.side.relation])
			case "mutable":
			case "race":
			case "series":
				return reach([d.relation])
			case "unit":
				return
			case "check":
				return
			case "family":
			case "tree":
				return reach([d.member.relation, d.slots.owner])
			case "fold":
				return reach([d.family.owner, d.step.relation, d.end.relation])
			case "alternatives":
				return reach([d.parent.relation, ...d.arms.map((a) => a.arm.relation)])
		}
	}

	/** The declared name of the level at `index`. */
	#levelName(index: number): string {
		const level = this.#levels[index]
		if (level === undefined) {
			throw defect(`ownership's level ${index} is one of the schema's levels`)
		}
		return level.name
	}

	/**
	 * Whether `side` holds a key of `entry`'s ordinary relation: its terms fields, and its fields and the fields its
	 * selection fixes, each by a conjunct `field = literal`, none of them a span, together holding the relation's primary
	 * key or a candidate key a key statement of its level or below declares. Its other conjuncts narrow the facts it reads
	 * and hold nothing apart. The UNIQUE over them a foreign key into it references is that key's own, or one over a
	 * superkey of it or over its selected columns, which refuses nothing the key admits.
	 */
	#keyOf(side: SideDesc, entry: RelationEntry): boolean {
		const terms = candidateKeyFields({ ...side, selection: { conjuncts: [] } })
		const fixed = side.selection.conjuncts.flatMap((c) => {
			const field = fixedField(c)
			return field === undefined ? [] : [field]
		})
		const desc = entry.desc
		if (terms === undefined || desc.kind !== "relation") {
			return false
		}
		const fields = [...new Set([...terms, ...fixed])]
		if (fields.some((f) => spanned(desc.fields[f]?.type))) {
			return false
		}
		const held = (key: ReadonlyArray<string>): boolean => key.every((f) => fields.includes(f))
		return (
			held(desc.primaryKey) ||
			this.#statements.some((k) => {
				if (
					k.desc.kind !== "key" ||
					k.desc.side.relation !== side.relation ||
					k.level > entry.level
				) {
					return false
				}
				const declared = candidateKeyFields(k.desc.side)
				return declared !== undefined && held(declared)
			})
		)
	}

	/** The statement as ownership admits it (OwnedStatement). */
	#checkStatement(s: StatementEntry): OwnedStatement {
		const d = s.desc
		switch (d.kind) {
			case "key": {
				const read = this.#checkRuleSide(d.side, s)
				if (read.kind === "derived") {
					return { ...d, key: { kind: "projected" } }
				}
				const entry = read.entry
				if (entry.desc.kind !== "relation") {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`a key over an ordinary relation; ${d.side.relation} is keyed by its declaration`
					)
				}
				const fieldsOf = entry.desc.fields
				if (
					d.side.terms.some((t) => t.kind === "field" && fieldsOf[t.field]?.type.kind === "bits")
				) {
					failWith({
						_tag: "Refused",
						at: d.loc,
						refusal: "a key lists no set: a set's bit string is too wide for an index entry"
					})
				}
				const fields = candidateKeyFields(d.side)
				return {
					...d,
					key:
						fields === undefined
							? { kind: "projected" }
							: {
									kind: "candidate",
									key: ownKey(this.#keys, d.side.relation, entry.desc, fields, false, d.loc)
								}
				}
			}
			case "mutable":
				this.#ordinary(d.relation, s, "is a closed relation, immutable by nature")
				this.#mutable.add(d.relation)
				return d
			case "race": {
				const entry = this.#ordinary(d.relation, s, "has fixed facts, which no insertion races")
				this.#checkRacedKey(entry.desc, s)
				this.#raced.set(d.relation, s)
				return d
			}
			case "unit":
				return d
			case "series": {
				const entry = this.#ordinary(d.relation, s, "has fixed facts, which no write appends")
				const [field, ...rest] = entry.desc.primaryKey
				const decl = entry.desc.fields[d.field]
				if (field !== d.field || rest.length > 0 || decl === undefined || !isDrawnType(decl.type)) {
					failWith({
						_tag: "Refused",
						at: d.loc,
						refusal:
							"a series' relation is keyed by one field alone, the series' numbers, of a type grizzle draws: natural or a contract over an integer"
					})
				}
				return d
			}
			case "check": {
				const read = this.#sideRelation(d.relation, s)
				if (read.kind === "derived") {
					return this.#derivedCheck(d, read, s)
				}
				const entry = this.#ordinary(
					d.relation,
					s,
					"has fixed facts, which no row check constrains"
				)
				const foreign = foreignInput(d.predicate)
				if (foreign !== undefined) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`check ${d.name} over its row only, not ${foreign}`
					)
				}
				this.#requireFields(entry, [...fieldRefs(d.predicate, new Set())], s)
				this.#checkPredicateHandles(d.predicate, entry.heading, s)
				const checks =
					this.#checkNames.get(d.relation) ?? DeclaredNamespace.of(`relation ${d.relation}'s check`)
				this.#checkNames.set(d.relation, checks)
				const named = identity.check(d.relation, declareName(checks, d.name, "check", d.loc))
				return { ...d, check: { named, constraint: identifierOf(named) } }
			}
			case "contained": {
				this.#checkRuleSide(d.left, s)
				this.#checkRuleSide(d.right, s)
				return {
					kind: d.kind,
					left: scopeOf(d.left),
					right: scopeOf(d.right),
					pairs: pairSides(d.left, d.right, s),
					loc: d.loc
				}
			}
			case "family": {
				const member = this.#ordinary(d.member.relation, s, "is no family's member")
				this.#checkSide(d.member, s)
				this.#checkSlots(d.slots, s)
				if (member.level > this.#lawRelation(d.slots.owner, s).level) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} over an owner of the member's level or below`
					)
				}
				return d
			}
			case "tree": {
				const tree = this.#ordinary(d.member.relation, s, "is no tree's relation")
				this.#checkSide(d.member, s)
				this.#checkSlots(d.slots, s)
				if (d.slots.owner !== d.member.relation) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} counted over its own relation; ${d.slots.owner} is another`
					)
				}
				this.#requireFields(tree, d.root, s)
				return d
			}
			case "fold": {
				this.#checkSlots(d.family, s)
				this.#checkSide(d.step, s)
				this.#checkSide(d.end, s)
				return d
			}
			case "alternatives": {
				const parent = this.#ordinary(d.parent.relation, s, "is no alternatives parent")
				this.#checkSide(d.parent, s)
				for (const a of d.arms) {
					this.#ordinary(a.arm.relation, s, "is no alternatives arm")
					this.#checkSide(a.arm, s)
				}
				const roster = this.#lawRelation(d.roster, s)
				if (roster.desc.kind !== "closed") {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} over a roster; ${d.roster} is none`
					)
				}
				const disc = parent.heading[d.discriminator]
				if (disc === undefined || closedIdBase(disc)?.roster !== d.roster) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} discriminated by a closedId(${d.roster}) field of ${d.parent.relation}`
					)
				}
				for (const a of d.arms) {
					if (!isHandle(roster.desc, a.handle)) {
						fail(
							"MalformedDescription",
							s.desc.loc,
							`${statementLabel(d)} armed by ${d.roster}'s handles; ${a.handle} is not one`
						)
					}
				}
				return d
			}
		}
	}

	/**
	 * A row check over a derived relation's facts: its predicate over the definition's heading alone, and its name
	 * declared in the derived relation's check namespace. The triggers that hold it on the tables it reads are named by its
	 * law (laws/model/model.ts RuleTrigger), never by its name, which is unique in no table's namespace.
	 */
	#derivedCheck(
		d: Extract<StatementDesc, { readonly kind: "check" }>,
		read: Extract<SideRelationEntry, { readonly kind: "derived" }>,
		s: StatementEntry
	): OwnedStatement {
		const foreign = foreignInput(d.predicate)
		if (foreign !== undefined) {
			fail("MalformedDescription", s.desc.loc, `check ${d.name} over its row only, not ${foreign}`)
		}
		for (const f of fieldRefs(d.predicate, new Set())) {
			if (!read.fields.has(f)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(d)} names ${d.relation}.${f}, which is not a field of ${d.relation}`
				)
			}
		}
		const checks =
			this.#checkNames.get(d.relation) ?? DeclaredNamespace.of(`relation ${d.relation}'s check`)
		this.#checkNames.set(d.relation, checks)
		const named = identity.check(d.relation, declareName(checks, d.name, "check", d.loc))
		return { ...d, check: { named, constraint: identifierOf(named) } }
	}

	/** The slots of a count: its owner an ordinary relation of the statement's level or below, and its count a field. */
	/**
	 * A raced relation's primary key, which every insertion into it races at: one with a payload beside it, since at a
	 * key that is the whole heading every row met is an exact repeat; no span, whose exclusion constraint PostgreSQL
	 * arbitrates by DO NOTHING alone, which yields no row met; and no field the database or grizzle draws, so no
	 * insertion meets stored rows at another key (write/insert/unique.ts generatedArbiter).
	 */
	#checkRacedKey(r: OrdinaryRelationOf, s: StatementEntry): void {
		const key = r.primaryKey
		if (Object.keys(r.fields).every((f) => key.includes(f))) {
			fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} over a relation with a field beside its primary key; ${r.name}'s key is its whole heading, so every row an insertion meets there is an exact repeat`
			)
		}
		const spans = key.filter((f) => spanned(r.fields[f]?.type))
		if (spans.length > 0) {
			fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} over a primary key of no span; ${r.name}.${spans.join(", ")} is a span, whose exclusion constraint PostgreSQL arbitrates by DO NOTHING alone, which yields no row an insertion met`
			)
		}
		const drawn = key.filter((f) => {
			const writing = r.fields[f]?.writing.kind
			return writing === "drawn"
		})
		if (drawn.length > 0) {
			fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} over a primary key its insertions state; ${r.name}.${drawn.join(", ")} is drawn, so an insertion that draws it meets stored rows at another key`
			)
		}
	}

	/**
	 * Each raced relation against the statements beside its race: never mutable, since a row an insertion met could
	 * change after, and never a family's member or owner, whose members grizzle writes under the owner the insertion
	 * states.
	 */
	#checkRaces(statements: ReadonlyArray<OwnedStatement>): void {
		const families = new Set(
			statements.flatMap((s) =>
				s.kind === "family" || s.kind === "tree" ? [s.member.relation, s.slots.owner] : []
			)
		)
		for (const [relation, s] of this.#raced) {
			if (this.#mutable.has(relation)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} over an immutable relation; ${relation} is mutable, so a row an insertion met may change`
				)
			}
			if (families.has(relation)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} over a relation no family holds; ${relation} is a family's member or owner, whose members grizzle writes under the owner an insertion states`
				)
			}
		}
	}

	#checkSlots(slots: SlotsDesc, s: StatementEntry): void {
		const owner = this.#ordinary(slots.owner, s, "has no drawn count")
		this.#requireFields(owner, [slots.count], s)
	}

	/** The schema's one namespace of relations, derived relations, rosters and contracts (PostgreSQL's relation and type
	 * namespaces, which grizzle treats as one). */
	readonly #schemaNames = DeclaredNamespace.of("relation, roster and contract")

	/** The relations, each owning the keys and checks `statements` state over it, read off them once by relation. */
	#ownRelations(
		statements: ReadonlyArray<OwnedStatement>
	): Readonly<Record<string, OwnedRelation>> {
		const keys = new Map<string, Array<OwnedKey>>()
		const checks = new Map<string, Array<OwnedCheck>>()
		const add = <A>(by: Map<string, Array<A>>, relation: string, item: A): void => {
			by.getOrInsertComputed(relation, () => []).push(item)
		}
		for (const s of statements) {
			if (s.kind === "key" && s.key.kind === "candidate") {
				add(keys, s.side.relation, s.key.key)
			} else if (s.kind === "check") {
				add(checks, s.relation, s.check)
			}
		}
		const out: Record<string, OwnedRelation> = {}
		for (const [name, entry] of byName(this.#relations)) {
			out[name] = this.#ownRelation(
				{ keys: keys.get(name) ?? [], checks: checks.get(name) ?? [] },
				name,
				entry
			)
		}
		return out
	}

	/**
	 * One relation's owned identifiers: its table, roster domain or materialized view, and what each kind owns besides.
	 * A closed relation installs no relation of its own.
	 */
	#ownRelation(laws: RelationLaws, declared: string, entry: RelationEntry): OwnedRelation {
		const r = entry.desc
		const what: Readonly<Record<RelationDesc["kind"], string>> = {
			relation: "relation",
			closed: "roster",
			closedRelation: "closed relation",
			derived: "relation"
		}
		const name = declareName(this.#schemaNames, declared, what[r.kind], entry.desc.loc)
		const owning: OwnedBase = { name, level: entry.level, loc: entry.desc.loc }
		switch (r.kind) {
			case "relation":
				return this.#ownStored(laws, owning, entry, r)
			case "closed": {
				const named = identity.rosterDomain(name)
				return {
					...owning,
					kind: r.kind,
					desc: r,
					roster: Roster.of(name, rosterOrderOf(r), r.handles),
					named,
					ident: identifierOf(named),
					fields: this.#closedFields(owning, entry, rosterHeading(r)),
					keys: [],
					mutable: false
				}
			}
			case "closedRelation":
				return {
					...owning,
					kind: r.kind,
					desc: r,
					fields: this.#closedFields(owning, entry, r.fields),
					keys: [],
					mutable: false
				}
			case "derived": {
				const reads = [...queryUses(r.query).relations].toSorted(compareStrings)
				return {
					...owning,
					kind: r.kind,
					desc: r,
					fields: {},
					keys: [],
					mutable: false,
					reads,
					view: ownedView(name, r.storage)
				}
			}
		}
	}

	/** A stored relation's columns, keys and row checks. */
	#ownStored(
		laws: RelationLaws,
		owning: OwnedBase,
		entry: RelationEntry,
		r: OrdinaryRelationOf
	): OwnedRelation {
		const { name } = owning
		const fields: Record<string, OwnedField> = {}
		const columns = DeclaredNamespace.columns(`relation ${name}'s field`)
		for (const [declared, decl] of Object.entries(r.fields)) {
			const field = declareName(
				columns,
				declared,
				"field",
				labeledChildLoc(entry.desc.loc, declared, `field ${name}.${declared}`)
			)
			const named = identity.column(field)
			fields[field] = {
				id: FieldId(name, field),
				name: field,
				desc: decl.type,
				writing: decl.writing,
				named,
				column: identifierOf(named)
			}
		}
		const primary = ownKey(
			this.#keys,
			name,
			r,
			r.primaryKey,
			true,
			labeledChildLoc(entry.desc.loc, "primaryKey", `primary key of ${name}`)
		)
		const named = identity.table(name)
		return {
			...owning,
			kind: r.kind,
			desc: r,
			named,
			ident: identifierOf(named),
			fields,
			keys: distinctKeys(name, [primary, ...laws.keys]),
			checks: laws.checks,
			mutable: this.#mutable.has(name),
			inserts: this.#raced.has(name) ? "race" : "repeatable"
		}
	}

	/** A roster's or closed relation's fields: every one fixed when the schema compiles. */
	#closedFields(
		owning: OwnedBase,
		entry: RelationEntry,
		heading: Readonly<Record<string, FieldDesc>>
	): Readonly<Record<string, OwnedField>> {
		const { name } = owning
		const fields: Record<string, OwnedField> = {}
		const columns = DeclaredNamespace.columns(`closed relation ${name}'s field`)
		for (const [declared, desc] of Object.entries(heading)) {
			const field = declareName(
				columns,
				declared,
				"field",
				labeledChildLoc(entry.desc.loc, declared, `field ${name}.${declared}`)
			)
			const named = identity.column(field)
			fields[field] = {
				id: FieldId(name, field),
				name: field,
				desc,
				writing: callerWritten,
				named,
				column: identifierOf(named)
			}
		}
		return fields
	}

	/** Each contract by its declared name, a contract's name its type-level brand alone (OwnedContract). */
	#ownContracts(): Readonly<Record<string, OwnedContract>> {
		const out: Record<string, OwnedContract> = {}
		const names = DeclaredNamespace.of("contract")
		for (const [declared, c] of byName(this.#contracts)) {
			const name = declareName(names, declared, "contract", c.loc)
			out[name] = { name, desc: c.desc, loc: c.loc, level: c.level }
		}
		return out
	}

	/**
	 * The canonical description: each level's relations by name, less those an equal lower declaration already holds,
	 * and its statements deduplicated in canonical order.
	 */
	#canonicalDesc(): SchemaDesc {
		const placed = new Set<string>()
		const canonicalLevel = (
			level: number,
			schema: SchemaDesc,
			below: SchemaDesc | undefined
		): SchemaDesc => {
			const relations = schema.relations
				.filter((r) => this.#relations.get(r.name)?.level === level && !placed.has(r.name))
				.toSorted((a, b) => compareStrings(a.name, b.name))
			for (const r of relations) {
				placed.add(r.name)
			}
			const statements = this.#statements
				.filter((s) => s.level === level)
				.toSorted((a, b) => compareStrings(a.identity, b.identity))
				.map((s) => s.desc)
			return schemaLevelDesc({
				name: schema.name,
				relations,
				statements,
				functions: canonicalFunctions(schema),
				bases: below === undefined ? [] : [below],
				loc: schema.loc
			})
		}
		const [root, ...above] = this.#levels
		let top = canonicalLevel(0, root, undefined)
		for (const [i, schema] of above.entries()) {
			top = canonicalLevel(i + 1, schema, top)
		}
		return top
	}
}

/** Every Owned that own() returned. An Owned is what own() built, never a value that merely has its keys. */
const owners = new WeakMap<object, Owned>()

/** The Owned that own() built, when `input` is one; undefined for any other value. */
export const ownedOf = (input: unknown): Owned | undefined =>
	typeof input === "object" && input !== null ? owners.get(input) : undefined

/**
 * Owns a schema description: one decoded at a boundary, or an Owned's own, each statement put in canonical form here.
 */
export const own = (desc: SchemaDesc): Result.Result<Owned, CompileError> =>
	ownWith(
		desc,
		mapNonEmpty(levelChain(desc), (level) => level.statements.map(everyRule.statement)),
		() => noDeclaredEntries,
		hashedLevels
	)

/** A schema value's built schema: its description and its content (levels.ts SchemaContent), read at its build. */
interface BuiltLevels {
	readonly desc: SchemaDesc
	readonly content: SchemaContent
}

/** Each level's statements in canonical form as a built schema's content carries them, root first (writtenOf). */
const writtenOf = (
	content: SchemaContent
): NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>> =>
	content.below === undefined
		? [content.canonical]
		: appendNonEmpty(writtenOf(content.below), content.canonical)

/**
 * The catalog entries a built schema's levels declare for the laws no statement states, every level's together
 * (levels.ts SchemaContent entries): two levels that declare two entries for one law are refused
 * (MalformedDescription), since one law has one name.
 */
const declaredOf = (built: BuiltLevels): DeclaredEntries => {
	const levels: Array<DeclaredEntries> = []
	for (let at: SchemaContent | undefined = built.content; at !== undefined; at = at.below) {
		levels.push(at.entries)
	}
	return mergedDeclared(levels, (what) =>
		fail(
			"MalformedDescription",
			built.desc.loc,
			`one catalog entry for ${what}: one law has one entry`
		)
	)
}

/**
 * own() of a schema schema(...) or schema.extend built: each level's statements read in the canonical form and text
 * its level content carries from their build (levels.ts SchemaContent.canonical), none put in canonical form again.
 */
export const ownBuilt = (built: BuiltLevels): Result.Result<Owned, CompileError> =>
	ownWith(built.desc, writtenOf(built.content), () => declaredOf(built), hashedLevels)

/**
 * ownBuilt(), each level's fingerprint taken from its installation's snapshot (`recorded`, root first) rather than
 * hashed: what DbLayer.make owns its login's base with, serving under the fingerprints `grizzle generate` recorded.
 */
export const ownServed = (
	built: BuiltLevels,
	recorded: ReadonlyArray<SchemaFingerprint>
): Result.Result<Owned, CompileError> =>
	ownWith(built.desc, writtenOf(built.content), () => declaredOf(built), recordedLevels(recorded))

/**
 * Owns `desc`, each level's statements in canonical form in `written` (root first, as levelChain gives its levels),
 * each level's fingerprint as `fingerprinted` gives it. A declared key whose index entry no index holds is owned all the
 * same and carried in the Owned's `unrepresentable`, refused where the compile ends (core/canonical.ts settled), or in
 * place of a refusal of another kind ownership meets after it (metFirst).
 */
const ownWith = (
	desc: SchemaDesc,
	written: NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>>,
	declared: () => DeclaredEntries,
	fingerprinted: LevelFingerprints
): Result.Result<Owned, CompileError> => {
	const keys = new KeyLedger([])
	return Result.map(
		keys.first(catchRefusal(() => new Owner(desc, written, keys, declared()).run(fingerprinted))),
		(owned) => {
			owners.set(owned, owned)
			return owned
		}
	)
}

/**
 * A role relation as ownership admitted it: a whole entry with the base's owned relation, or a query entry with its
 * decoded entry and the base relations and the contexts its definition reads.
 */
export type OwnedEntry =
	| {
			readonly kind: "whole"
			readonly name: DeclaredName
			readonly relation: OwnedRelation
			readonly loc: SourceLoc
	  }
	| OwnedWorldEntry

/** A role's query entry as ownership admitted it (OwnedEntry), a scoped entry's among them, whose view is its query's. */
export interface OwnedWorldEntry {
	readonly kind: "world"
	readonly name: DeclaredName
	readonly entry: Exclude<RoleEntryDesc, { readonly kind: "whole" }>
	readonly query: QueryDesc
	readonly reads: ReadonlyArray<string>
	readonly contexts: ReadonlyArray<string>
	readonly loc: SourceLoc
}

/**
 * One entry of a role's write list as ownership admitted it: "whole", a whole entry of an ordinary relation, which
 * writes its table as it is; "rows", a query entry the writable-entry analysis admits, with its analysis, whose writes
 * the table's row security holds to the entry's membership; "scoped", a scoped entry of an ordinary relation, which
 * writes its table as a whole entry does, behind the precheck and row security of its membership (its analysis,
 * EntryKeys scoped), under its scope.
 */
export type OwnedWrite =
	| {
			readonly kind: "whole"
			readonly name: string
			readonly relation: Extract<OwnedRelation, { readonly kind: "relation" }>
			readonly loc: SourceLoc
	  }
	| {
			readonly kind: "rows"
			readonly name: string
			readonly entry: OwnedWorldEntry
			readonly writable: WritableEntry<string, string>
			readonly loc: SourceLoc
	  }
	| {
			readonly kind: "scoped"
			readonly name: string
			readonly relation: Extract<OwnedRelation, { readonly kind: "relation" }>
			readonly entry: OwnedWorldEntry
			readonly writable: WritableEntry<string, string>
			readonly scope: Scope
			readonly loc: SourceLoc
	  }

/**
 * How the contexts a query entry matches stand against the contexts its role declares (RoleDesc.contexts), the only
 * ones its Db's claims hold facts of: the first it matches, in name order, that the role does not declare
 * (`undeclared`), or declares by another Description (`another`); none when it matches declared ones alone. Ownership
 * (ownRoleOf) and the builder (schema/world.ts admitRole) each refuse a break in their own error's form.
 */
type EntryContextBreak = {
	readonly kind: "undeclared" | "another"
	readonly context: string
}

export const entryContextBreak = (
	declared: ReadonlyArray<ContextDesc>,
	matched: ReadonlyMap<string, ContextDesc>
): EntryContextBreak | undefined => {
	for (const [name, c] of [...matched].toSorted(([a], [b]) => compareStrings(a, b))) {
		const held = declared.find((d) => d.name === name)
		if (held === undefined) {
			return { kind: "undeclared", context: name }
		}
		if (!sameContent(held, c)) {
			return { kind: "another", context: name }
		}
	}
	return undefined
}

/**
 * The owned role: its name, its base's Owned, its relations by name, its write list as admitted entries by name in name
 * order, the key that list was stated under (`insert`: the role holds INSERT and SELECT on what it writes, no DELETE
 * or UPDATE), its refresh list in name order, whether it holds every relation of its base whole (a full role, whose
 * base is among its levels), and the contexts it declares, by name, in name order: the facts its Db's claims hold, and
 * the only contexts its query entries and programs match.
 */
export interface OwnedRole {
	readonly name: DeclaredName
	readonly loc: SourceLoc
	readonly base: Owned
	readonly relations: Readonly<Record<string, OwnedEntry>>
	readonly writes: ReadonlyMap<string, OwnedWrite>
	readonly writing: RoleWritingKey
	readonly refresh: ReadonlyArray<string>
	readonly full: boolean
	readonly contexts: Readonly<Record<string, ContextDesc>>
	/** Each scoped entry's scope (scope.ts Scope), by its relation's name, in name order: its query entry's query. */
	readonly scoped: ReadonlyMap<string, Scope>
}

/** The owned login: its name, its base's Owned and its owned roles in name order. */
export interface OwnedLogin {
	readonly name: DeclaredName
	readonly loc: SourceLoc
	readonly base: Owned
	readonly roles: ReadonlyArray<OwnedRole>
}

const ownRoleOf = (desc: RoleDesc, base: Owned): OwnedRole => {
	const label = `role ${desc.name}`
	/** The role's refusal at `loc` for breaking `rule`. A function declaration, so control flow knows it never returns. */
	function broken(loc: SourceLoc, rule: RoleRule): never {
		failWith({ _tag: "RoleRefused", at: loc, role: desc.name, rule })
	}
	/** A role's name is a declared name: its PostgreSQL role and its schema are `<schema>__<name>`. Its login's
	 * ownership holds it apart from the login's other names. */
	const roleName = declareName(DeclaredNamespace.of("role"), desc.name, "role", desc.loc)
	const relations: Record<string, OwnedEntry> = {}
	const scoped = new Map<string, Scope>()
	/** The role's schema holds one view per relation, named by the relation's declared name. */
	const views = DeclaredNamespace.of(`${label}'s relation`)
	for (const e of desc.relations) {
		const entryName = declareName(views, e.name, "relation", e.loc)
		if (e.kind === "whole") {
			const relation = base.relations[e.name]
			if (relation === undefined) {
				failWith({
					_tag: "Refused",
					at: e.loc,
					refusal: "a whole entry is a relation of the base under its own name"
				})
			}
			if (relation.kind === "derived" && relation.desc.storage === "live") {
				failWith({
					_tag: "Refused",
					at: e.loc,
					refusal:
						"a whole entry is a relation PostgreSQL stores: a role reads a live derived relation through the relations its definition reads"
				})
			}
			relations[e.name] = { kind: "whole", name: entryName, relation, loc: e.loc }
			continue
		}
		if (e.query.stage.kind === "order") {
			broken(e.loc, { kind: "entryOrdered", entry: e.name })
		}
		const uses = queryUses(e.query)
		if (uses.inputs.size > 0) {
			broken(e.loc, {
				kind: "entryParameters",
				entry: e.name,
				parameters: [...uses.inputs].toSorted(compareStrings)
			})
		}
		for (const read of uses.relations) {
			if (base.relations[read] === undefined) {
				broken(e.loc, { kind: "entryOutsideBase", entry: e.name, relation: read })
			}
		}
		if (attachesHeading(e.query)) {
			broken(e.loc, { kind: "entryAttaches", entry: e.name })
		}
		if (approximates(e.query)) {
			broken(e.loc, { kind: "entryApproximate", entry: e.name })
		}
		const contextBreak = entryContextBreak(desc.contexts, uses.contexts)
		if (contextBreak?.kind === "undeclared") {
			broken(e.loc, { kind: "entryContext", entry: e.name, context: contextBreak.context })
		}
		if (contextBreak?.kind === "another") {
			failWith({
				_tag: "DuplicateIdentity",
				at: e.loc,
				duplicate: { kind: "context", name: contextBreak.context, earlier: desc.loc }
			})
		}
		relations[e.name] = {
			kind: "world",
			name: entryName,
			entry: e,
			query: e.query,
			reads: [...uses.relations].toSorted(compareStrings),
			contexts: [...uses.contexts.keys()].toSorted(compareStrings),
			loc: e.loc
		}
		if (e.kind === "scoped") {
			const scope = entryScope(base.desc, e.name, e.query)
			if (scope === undefined) {
				broken(e.loc, { kind: "entryScope", entry: e.name })
			}
			scoped.set(e.name, scope)
		}
	}
	const targets = new Map<string, string>()
	const target = (relation: string, entry: string): void => {
		const prior = targets.get(relation)
		if (prior !== undefined) {
			broken(desc.loc, { kind: "writeTwice", relation, entries: [prior, entry] })
		}
		targets.set(relation, entry)
	}
	const admitted = new Map<string, OwnedWrite>()
	for (const w of writtenNames(desc)) {
		const r = Object.hasOwn(relations, w) ? relations[w] : undefined
		if (r === undefined) {
			broken(desc.loc, { kind: "writeOutside", name: w })
		}
		if (r.kind === "whole") {
			const relation = r.relation
			if (relation.kind !== "relation") {
				broken(desc.loc, {
					kind: "writeKind",
					name: w,
					entryKind: relation.kind === "closedRelation" ? "closed" : relation.kind
				})
			}
			target(w, w)
			admitted.set(w, { kind: "whole", name: w, relation, loc: r.loc })
			continue
		}
		const scope = scoped.get(w)
		const analyzed = writableEntry(
			base.desc,
			r.entry,
			scope === undefined
				? { kind: "probed" }
				: { kind: "scoped", determines: (fields) => determines(scope, fields) }
		)
		if (!analyzed.ok) {
			broken(r.loc, { kind: "writeUnwritable", entry: w, why: analyzed.error.reason })
		}
		target(analyzed.value.target, w)
		if (scope === undefined) {
			admitted.set(w, { kind: "rows", name: w, entry: r, writable: analyzed.value, loc: r.loc })
			continue
		}
		const relation = base.relations[w]
		if (relation?.kind !== "relation") {
			broken(desc.loc, { kind: "writeKind", name: w, entryKind: "derived" })
		}
		admitted.set(w, {
			kind: "scoped",
			name: w,
			relation,
			entry: r,
			writable: analyzed.value,
			scope,
			loc: r.loc
		})
	}
	for (const f of desc.refresh) {
		const r = relations[f]
		if (r === undefined) {
			broken(desc.loc, { kind: "refreshOutside", name: f })
		}
		if (r.kind === "world") {
			broken(desc.loc, { kind: "refreshKind", name: f, entryKind: "query" })
		}
		if (r.relation.kind !== "derived") {
			broken(desc.loc, {
				kind: "refreshKind",
				name: f,
				entryKind: r.relation.kind === "closedRelation" ? "closed" : r.relation.kind
			})
		}
	}
	const full = Object.values(base.relations).every(
		(r) => !heldRelation(r.desc) || relations[r.name]?.kind === "whole"
	)
	const ownedContexts: Record<string, ContextDesc> = {}
	for (const c of [...desc.contexts].toSorted((a, b) => compareStrings(a.name, b.name))) {
		ownedContexts[c.name] = c
	}
	return {
		name: roleName,
		loc: desc.loc,
		base,
		relations,
		writes: new Map([...admitted].toSorted(([a], [b]) => compareStrings(a, b))),
		writing: "insert" in desc ? "insert" : "write",
		refresh: [...desc.refresh].toSorted(compareStrings),
		full,
		contexts: ownedContexts,
		scoped: new Map([...scoped].toSorted(([a], [b]) => compareStrings(a, b)))
	}
}

/**
 * Owns a role description, its base first.
 *
 * ownRole is ownership of a role: its base owned first, then every rule of a role's relations, write and refresh lists
 * checked against it, each a RoleRefused naming the rule it breaks (core/causes.ts RoleRule), or Refused for a rule the
 * types name too: a whole entry names a relation of the base under its own name; a query entry is a Query over the base that reads no parameter; a write entry is a whole ordinary
 * relation or a query entry the writable-entry analysis admits, at most one per base relation; a refresh entry is a
 * derived whole entry; and each context a query entry matches is one the role declares (entryContext), by the
 * declared descriptor (DuplicateIdentity). The relations' names are declared names of one namespace, the role's schema of views
 * (core/identity.ts DeclaredNamespace: MalformedDescription, or IdentifierCollision for two that convert alike). A
 * query entry's heading and types are the checker's, against the base (analysis/schema.ts checkedRoleOver), and its heading's
 * names are its view's columns (analysis/derived/world.ts). ownLogin owns each role and checks they share the login's
 * base (LoginRefused), under names that convert apart from each other's and the login's (IdentifierCollision), the login's
 * name kept to the declared-name rule (MalformedDescription), as each role's own is.
 */
export const ownRole = (desc: RoleDesc): Result.Result<OwnedRole, CompileError> =>
	Result.flatMap(own(desc.base), (base) => catchRefusal(() => ownRoleOf(desc, base)))

/**
 * A login over its owned base and its roles, each owned over that base: the login's name and its roles' are one
 * namespace of declared names, since each is the PostgreSQL role `<schema>__<name>`, each role's own name kept to the
 * rule by its ownership.
 */
const ownLoginOf = (
	desc: LoginDesc,
	base: Owned,
	ownRoles: () => ReadonlyArray<OwnedRole>
): OwnedLogin => {
	const label = `login ${desc.name}`
	const names = DeclaredNamespace.of(`${label}'s and its roles'`)
	const loginName = declareName(names, desc.name, "login", desc.loc)
	const roles = ownRoles()
	for (const r of roles) {
		declareName(names, r.name, "role", r.loc)
	}
	return {
		name: loginName,
		loc: desc.loc,
		base,
		roles: roles.toSorted((a, b) => compareStrings(a.name, b.name))
	}
}

/**
 * Owns a login description: its base, then each role over its own base, which must be the login's (LoginRefused): a
 * description from outside the builders, whose roles nothing has held to its base.
 */
export const ownLogin = (desc: LoginDesc): Result.Result<OwnedLogin, CompileError> =>
	Result.flatMap(own(desc.base), (base) =>
		catchRefusal(() =>
			ownLoginOf(desc, base, () =>
				desc.roles.map((d) => {
					const r = unwrap(ownRole(d))
					if (r.base.fingerprint !== base.fingerprint || r.base.name !== base.name) {
						failWith({
							_tag: "LoginRefused",
							at: r.loc,
							login: desc.name,
							rule: { kind: "roleBase", role: r.name, base: base.name }
						})
					}
					return r
				})
			)
		)
	)

/**
 * Owns the description of a login login(...) built over `base`, its base owned: login(...) held each of its roles to
 * that base, so each role is owned over it, and the base is owned once for the login and all its roles.
 */
export const ownBuiltLogin = (
	desc: LoginDesc,
	base: Owned
): Result.Result<OwnedLogin, CompileError> =>
	catchRefusal(() => ownLoginOf(desc, base, () => desc.roles.map((r) => ownRoleOf(r, base))))

/**
 * Owns the description of a role role(...) built over `base`, its base owned: role(...) built it over that base.
 */
export const ownBuiltRole = (desc: RoleDesc, base: Owned): Result.Result<OwnedRole, CompileError> =>
	catchRefusal(() => ownRoleOf(desc, base))

/**
 * The description of the full role `name` over a schema description: every relation of every level a role holds
 * whole (desc.ts heldRelation), writing its ordinary relations and refreshing its materialized derived ones, and
 * declaring no context.
 */
export const fullRoleDesc = (
	base: SchemaDesc,
	name: string,
	loc: SourceLoc
): Result.Result<RoleDesc, CompileError> =>
	Result.flatMap(own(base), (owned) => {
		const relations = Object.values(owned.relations)
			.filter((r) => heldRelation(r.desc))
			.toSorted((a, b) => compareStrings(a.name, b.name))
		const [first, ...rest] = relations.map((r): RoleEntryDesc => ({
			kind: "whole",
			name: r.name,
			loc
		}))
		if (first === undefined) {
			return Result.err(malformedDescription(loc, "a base with at least one relation"))
		}
		return decodeRoleOver(base, {
			name,
			relations: [first, ...rest],
			write: relations.filter((r) => r.kind === "relation").map((r) => r.name),
			refresh: relations.filter((r) => r.kind === "derived").map((r) => r.name),
			contexts: [],
			loc
		})
	})
