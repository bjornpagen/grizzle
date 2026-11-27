/**
 * The runtime protocols the schema builders read and write.
 *
 * Builders are pure and synchronous. They record Descriptions (ir/desc.ts) and never touch a database. A malformed
 * argument that the TypeScript signatures already forbid, from a JavaScript caller, throws CompileError
 * MalformedDescription synchronously; every semantic diagnostic is reported later, by ownership (own.ts).
 *
 * Three protocols cross package boundaries here:
 *
 * - Field descriptors, str.regex's included. A descriptor is an owned value carrying, beside its public
 *   members (its column among them), a non-enumerable `desc` holding its FieldDesc, aliases already normalized; a
 *   str.regex descriptor is read from its pattern. A descriptor a builder made is read from the registry
 *   (scalar/registry.ts), and a copy of one, an object spread that keeps the brand (core/phantom.ts) and the source's
 *   host type, is refused. Anything else, a JavaScript look-alike included, is refused: it has no column a builder
 *   made.
 * - Scalar terms and predicates (contract predicates, the scalar catalogue, queries). A term is a value with an
 *   `expr` member holding its expression; a predicate also has `predicate: true`; a parameter is a value with a string
 *   `param` member and no `expr`. Terms and predicates are admitted by identity: every builder registers the value it
 *   made in scalar/compute/term.ts's registry, and termExpr and predicateExpr read that, never the members. Row checks
 *   (terms.ts) build and read terms this way, so a scalar expression over a row's fields composes with the row's own
 *   comparisons.
 * - Owned schema values. Every value this package builds (relations, closed and derived relations, statements, the
 *   expansions of mirrors, sides, selections, schemas, fragments, contexts, world relations, roles and
 *   logins)
 *   is frozen, carries its Description under a non-enumerable `desc`, and is registered here, so ownership trusts
 *   exactly the values the builders made and a JavaScript look-alike is decoded strictly.
 */
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { type CompileError, malformedDescription, ruleRefused } from "#compiler/core/errors.ts"
import {
	admitDeclaredName,
	admitDerivedName,
	type DeclaredName,
	type DerivedName
} from "#compiler/core/identity.ts"
import { captureLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { isValidText } from "#compiler/core/text.ts"
import {
	type AdmittedClosedRelation,
	type ContextDesc,
	decodeDesc,
	type FieldDesc,
	type FunctionBodyDesc,
	type VariantSpellingDesc,
	type FunctionDesc,
	type HeadingDesc,
	type LoginDesc,
	type QueryDesc,
	type RoleDesc,
	type RosterDesc,
	type SchemaDesc,
	type SideDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { Roster as TypedRoster, ScalarType } from "#compiler/ir/scalar.ts"
import { registerPredicate, type TermCarrier } from "#compiler/scalar/compute/term.ts"
import { type Described, refusedField, registeredField } from "#compiler/scalar/registry.ts"
import type { BuiltSchemaContent } from "#compiler/schema/levels.ts"
import type { CanonicalStatement } from "#compiler/schema/own.ts"
import type { DerivedDraft, OrdinaryRelationDesc } from "#compiler/schema/relation.ts"
import type { FragmentContent, FragmentDesc } from "#compiler/schema/schema.ts"
import type { ExpansionDesc, SelectedDesc } from "#compiler/schema/statements.ts"
import type { BuiltRoleLevel, WorldDraft } from "#compiler/schema/world.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type {
	AnyFunction,
	AnyRow,
	AnyRows,
	FunctionBody,
	VariantSpelling
} from "#compiler/types/schema/function.ts"
import type { AnyClosedRelation, AnyRelation, AnyRoster } from "#compiler/types/schema/relation.ts"
import type { AnyFragment, AnySchema } from "#compiler/types/schema/schema.ts"
import type {
	AnySide,
	MirrorsBase,
	Selection,
	Statement
} from "#compiler/types/schema/statements.ts"
import type { AnyContext, AnyLogin, AnyRole, AnyWorld } from "#compiler/types/schema/world.ts"

/** A builder location: the label and the user's call site (core/loc.ts). */
export const builderLoc = (label: string, path: ReadonlyArray<string | number>): SourceLoc =>
	captureLoc(label, path)

/** A builder's refusal of the user's call: MalformedDescription at `label`, at the user's call site. */
export const malformed = (label: string, what: string): CompileError =>
	malformedDescription(builderLoc(label, []), what)

/** A builder's refusal of the user's call for a rule the types name too, `refusal`, at `label` and the call site. */
export const builderRefusal = (label: string, refusal: Refused): CompileError =>
	ruleRefused(builderLoc(label, []), refusal)

/** The throwing form of a Result, for builders. */
export const orThrow = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw result.error
	}
	return result.value
}

/**
 * A declared name: the semantic identity of a relation, field, check or identity. It is a nonempty storable string;
 * whether it converts to a PostgreSQL identifier is the naming door's (core/identity.ts parseDeclaredName).
 */
export const isName = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && isValidText(value)

export const requireName = (value: unknown, label: string, what: string): string => {
	if (!isName(value)) {
		throw malformed(label, `${what}: a nonempty storable string`)
	}
	return value
}

/**
 * A declared name a builder takes for an object grizzle installs under it (a relation's table, a roster's domain, a
 * derived relation's view, a schema's or a level's schema): requireName's, parsed by the declared-name rule where it is
 * written (core/identity.ts admitDeclaredName), so a name PostgreSQL would cut short is refused when it is built,
 * IdentifierTooLong naming `kind`, the name and its identifier's bytes, never where something reads it later.
 */
export const requireDeclaredName = (value: unknown, label: string, kind: string): DeclaredName => {
	const name = requireName(value, label, `a ${kind} name`)
	return orThrow(
		admitDeclaredName(name, `${kind} name ${JSON.stringify(name)}`, builderLoc(label, []))
	)
}

/**
 * A name a library derives for a relation or roster (core/identity.ts DerivedName): requireName's, parsed by the
 * derived-name rule where it is built (admitDerivedName), a declared name's characters at any length, since what it
 * installs is hashed over it, never named by its conversion.
 */
export const requireDerivedName = (value: unknown, label: string, kind: string): DerivedName => {
	const name = requireName(value, label, `a ${kind} name`)
	return orThrow(
		admitDerivedName(name, `${kind} name ${JSON.stringify(name)}`, builderLoc(label, []))
	)
}

/**
 * A nonempty list of distinct declared names, in the order written, which is meaningful: a name written twice is
 * `repeated`, a rule the types name too.
 */
export const requireNames = (
	value: unknown,
	label: string,
	what: string,
	repeated: Refused
): readonly [string, ...Array<string>] => {
	if (!isList(value) || value.length === 0) {
		throw malformed(label, `${what}: a nonempty list of field names`)
	}
	const seen = new Set<string>()
	for (const item of value) {
		if (!isName(item)) {
			throw malformed(label, `${what}: field names that are nonempty storable strings`)
		}
		if (seen.has(item)) {
			throw builderRefusal(label, repeated)
		}
		seen.add(item)
	}
	const [first, ...rest] = seen
	if (first === undefined) {
		throw malformed(label, `${what}: a nonempty list of field names`)
	}
	const names: readonly [string, ...Array<string>] = [first, ...rest]
	return Object.freeze(names)
}

/**
 * A field descriptor a builder made, as the registry reads it: its FieldDesc, ScalarType and column. A copy of a
 * descriptor and a JavaScript look-alike are refused (MalformedDescription) at the user's call site, whose stack is
 * read for the refusal alone.
 */
export const describedField = (value: unknown, label: string): Described =>
	orThrow(registeredField(value) ?? refusedField(value, builderLoc(label, [])))

/** The FieldDesc of a field descriptor a builder made. */
export const describedDesc = (value: unknown, label: string): FieldDesc =>
	describedField(value, label).desc

export interface PredicateValue extends Built {
	readonly predicate: true
	readonly expr: OpenExpr
}

export const isParam = (value: unknown): boolean =>
	hasProperties(value) && typeof value["param"] === "string" && value["expr"] === undefined

export const predicateValue = (expr: OpenExpr): PredicateValue =>
	registerPredicate(Object.freeze({ ...builtMark, predicate: true, expr }), expr)

/**
 * Queries: a query value carries its QueryDesc under `desc`, as every owned value does. A query value the builder made
 * yields the Description it registered, decoded where its parts were checked; any other value's `desc` is a
 * JavaScript caller's, decoded here.
 */
export const queryDescOf = (value: unknown, label: string): QueryDesc => {
	const owned = ownedEntry(value, "query")
	if (owned !== undefined) {
		return owned.desc()
	}
	if (hasProperties(value) && hasProperties(value["desc"])) {
		return orThrow(decodeDesc("query", value["desc"]))
	}
	throw malformed(label, "a query built by query(schema), carrying its description")
}

/**
 * What the builder knows of one field of a query value's heading: its ScalarType and its carrier, or nothing for a field
 * it could not type (a bare literal head, a query rebuilt from its Description alone).
 */
export type HeadingTyping =
	| { readonly kind: "typed"; readonly scalar: ScalarType; readonly carrier: TermCarrier }
	| { readonly kind: "untyped" }

/**
 * A query value's heading as the builder typed it (query/build/state.ts registerQuery): what a check's and a
 * selection's row over a derived relation is typed by. A value the builder did not make carries none.
 */
export const queryHeadingOf = (value: unknown): ReadonlyMap<string, HeadingTyping> | undefined =>
	ownedEntry(value, "query")?.content.heading

/**
 * The schema or role a query value the builder made is over, which role admission reads to refuse a query entry built
 * over anything but its base or one of its levels; none for any other value.
 */
export const querySchemaOf = (value: unknown): object | undefined =>
	ownedEntry(value, "query")?.content.schema

/**
 * Each kind of owned value: the value a builder returns, at the widest of its public type, the Description it carries,
 * and the content it was built with, read once at its build: the roster a roster's handles type (relation.ts
 * closedBuilder), a statement's canonical form and text (own.ts CanonicalStatement) and the relations it was built over
 * (statements.ts relationsOver), a mirrors' its two containments' and its relations, a schema's content
 * (levels.ts SchemaContent) and the schema owned once, at its build (BuiltSchemaContent), a fragment's content with its
 * declarations and statements (schema.ts FragmentContent), a role's level and the role owned once, at its build
 * (world.ts BuiltRoleLevel), and nothing for any other kind: a relation's identity
 * is its Description, compared by structure (core/canonical.ts sameContent). A mirrors is sugar, owned as an expansion,
 * the two containments it states, never as a statement.
 */
interface OwnedKinds {
	readonly relation: {
		readonly value: AnyRelation
		readonly desc: OrdinaryRelationDesc
		readonly content: undefined
	}
	readonly closed: {
		readonly value: AnyRoster
		readonly desc: RosterDesc
		readonly content: TypedRoster
	}
	readonly closedRelation: {
		readonly value: AnyClosedRelation
		readonly desc: AdmittedClosedRelation
		readonly content: undefined
	}
	readonly derived: {
		readonly value: AnyDerived
		readonly desc: DerivedDraft
		readonly content: undefined
	}
	readonly statement: {
		readonly value: Exclude<Statement, MirrorsBase>
		readonly desc: StatementDesc
		readonly content: {
			readonly canonical: CanonicalStatement
			readonly over: ReadonlyArray<unknown>
		}
	}
	readonly expansion: {
		readonly value: MirrorsBase
		readonly desc: ExpansionDesc
		readonly content: {
			readonly canonical: readonly [CanonicalStatement, CanonicalStatement]
			readonly over: ReadonlyArray<unknown>
		}
	}
	readonly side: { readonly value: AnySide; readonly desc: SideDesc; readonly content: undefined }
	readonly selection: {
		readonly value: Selection<unknown>
		readonly desc: SelectedDesc
		readonly content: undefined
	}
	readonly schema: {
		readonly value: AnySchema
		readonly desc: SchemaDesc
		readonly content: BuiltSchemaContent
	}
	readonly fragment: {
		readonly value: AnyFragment
		readonly desc: FragmentDesc
		readonly content: FragmentContent
	}
	readonly context: {
		readonly value: AnyContext
		readonly desc: ContextDesc
		readonly content: undefined
	}
	readonly world: {
		readonly value: AnyWorld
		readonly desc: WorldDraft
		readonly content: undefined
	}
	readonly role: {
		readonly value: AnyRole
		readonly desc: RoleDesc
		readonly content: BuiltRoleLevel
	}
	readonly login: {
		readonly value: AnyLogin
		readonly desc: LoginDesc
		readonly content: undefined
	}
	readonly query: {
		readonly value: object
		readonly desc: () => QueryDesc
		readonly content: {
			readonly schema: object
			readonly heading: ReadonlyMap<string, HeadingTyping>
		}
	}
	readonly function: {
		readonly value: AnyFunction
		readonly desc: FunctionDesc
		readonly content: undefined
	}
	readonly rows: {
		readonly value: AnyRows
		readonly desc: HeadingDesc
		readonly content: undefined
	}
	readonly row: {
		readonly value: AnyRow
		readonly desc: HeadingDesc
		readonly content: undefined
	}
	readonly body: {
		readonly value: FunctionBody
		readonly desc: FunctionBodyDesc
		readonly content: undefined
	}
	readonly spelling: {
		readonly value: VariantSpelling
		readonly desc: VariantSpellingDesc
		readonly content: undefined
	}
}

export type OwnedKind = keyof OwnedKinds

/** An owned value of kind K: its kind, the value, its Description and the content it was built with. */
interface OwnedEntry<K extends OwnedKind> {
	readonly kind: K
	readonly value: OwnedKinds[K]["value"]
	readonly desc: OwnedKinds[K]["desc"]
	readonly content: OwnedKinds[K]["content"]
}

/** Each kind's owned entry, by kind. */
type OwnedEntries = {
	readonly [K in OwnedKind]: OwnedEntry<K>
}

/** An owned value of any kind: its entry, whose kind says which. */
export type AnyOwnedEntry = OwnedEntries[OwnedKind]

/**
 * The values this package built, each under its entry, whose kind is the kind it was built as. A WeakMap holds nothing
 * alive and is never enumerated, so it is no cache.
 */
const owned = new WeakMap<object, AnyOwnedEntry>()

/**
 * Registers `entry`'s value as an owned value of its kind: defines its Description as a non-enumerable `desc`, freezes
 * it, and returns it. Freezing leaves every member non-writable and non-configurable.
 */
export const ownValue = <E extends AnyOwnedEntry>(entry: E): E["value"] => {
	Object.defineProperty(entry.value, "desc", {
		value: entry.desc,
		enumerable: false,
		writable: false,
		configurable: false
	})
	Object.freeze(entry.value)
	owned.set(entry.value, entry)
	return entry.value
}

/**
 * A copy of an owned statement, mirrors or relation `value`, owned as `entry`: law(...)'s value (law-entries.ts
 * lawBuilder), its entry the one `value` is owned as, a statement's and a mirrors' but for its content, which holds the
 * catalog entry its author declares. The copy
 * holds `value`'s own members, so every reader of a statement reads it as it reads `value`, and `value` stays as it
 * was: its entry's `value` is `value` itself, whose members are the copy's.
 */
export const ownedCopy = <S extends object>(
	value: S,
	entry: OwnedEntries["statement"] | OwnedEntries["expansion"] | OwnedEntries["relation"]
): S => {
	const copy: S = { ...value }
	Object.defineProperty(copy, "desc", {
		value: entry.desc,
		enumerable: false,
		writable: false,
		configurable: false
	})
	Object.freeze(copy)
	owned.set(copy, entry)
	return copy
}

/**
 * Registers a query value the builder made (query/build/query.ts defineDesc): the schema or role it is over, its
 * Description, read where it is asked for, and its heading as the builder typed it. The builder defines the value's
 * `desc` and freezes it.
 */
export const ownQuery = (
	query: object,
	desc: () => QueryDesc,
	content: { readonly schema: object; readonly heading: ReadonlyMap<string, HeadingTyping> }
): void => {
	owned.set(query, { kind: "query", value: query, desc, content })
}

/** The entry of an owned value, its kind among it; undefined for any value the builders did not make. */
export const ownedEntryOf = (value: unknown): AnyOwnedEntry | undefined =>
	hasProperties(value) ? owned.get(value) : undefined

/** The kind of an owned value, undefined for any value the builders did not make. */
export const ownedKind = (value: unknown): OwnedKind | undefined => ownedEntryOf(value)?.kind

/** Whether an owned entry is of `kind`: its kind says so, since an entry is its kind's. */
const isOfKind = <K extends OwnedKind>(entry: AnyOwnedEntry, kind: K): entry is OwnedEntries[K] =>
	entry.kind === kind

/** The value and Description of an owned value of `kind`, or undefined when the value is not one. */
export const ownedEntry = <K extends OwnedKind>(
	value: unknown,
	kind: K
): OwnedEntries[K] | undefined => {
	const entry = ownedEntryOf(value)
	return entry !== undefined && isOfKind(entry, kind) ? entry : undefined
}

/** The Description of an owned value of `kind`, or undefined when the value is not one. */
export const ownedDesc = <K extends OwnedKind>(
	value: unknown,
	kind: K
): OwnedKinds[K]["desc"] | undefined => ownedEntry(value, kind)?.desc

/**
 * A frozen shallow copy of an array or record a caller handed in, so a later mutation of the caller's value cannot
 * reach an owned description, typed as what was copied, for the typed builders. A tuple's copy is typed `readonly
 * [...T]`, which is T itself for every concrete tuple. A record's copy keeps its own enumerable string-keyed members in
 * order.
 */
export const frozenTuple = <T extends ReadonlyArray<unknown>>(items: T): readonly [...T] => {
	const copy: readonly [...T] = [...items]
	Object.freeze(copy)
	return copy
}

export const frozenCopy = <T extends object>(record: T): T => {
	const copy = { ...record }
	for (const key of Object.getOwnPropertySymbols(copy)) {
		Reflect.deleteProperty(copy, key)
	}
	Object.freeze(copy)
	return copy
}
