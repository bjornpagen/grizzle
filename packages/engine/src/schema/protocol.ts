import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import type * as Result from "#compiler/core/result.ts"
import { isValidText } from "#compiler/core/text.ts"
import {
	type ContextDesc,
	decodeDesc,
	type FieldDesc,
	type LoginDesc,
	type QueryDesc,
	type RoleDesc,
	type SchemaDesc,
	type SideDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { registerPredicate } from "#compiler/scalar/compute/term.ts"
import { type Described, describeField } from "#compiler/scalar/registry.ts"
import type {
	ClosedRelationDesc,
	DerivedDraft,
	OrdinaryRelationDesc
} from "#compiler/schema/relation.ts"
import type { AlternativesDesc, SelectionDesc } from "#compiler/schema/statements.ts"
import type { WorldDraft } from "#compiler/schema/world.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type {
	AlternativesBase,
	AnySide,
	Selection,
	Statement
} from "#compiler/types/schema/statements.ts"
import type { AnyContext, AnyLogin, AnyRole, AnyWorld } from "#compiler/types/schema/world.ts"

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
 * - Scalar terms and predicates (contract predicates, Compute, queries). A term is a value with an
 *   `expr` member holding its expression; a predicate also has `predicate: true`; a parameter is a value with a string
 *   `param` member and no `expr`. Terms and predicates are admitted by identity: every builder registers the value it
 *   made in scalar/compute/term.ts's registry, and termExpr and predicateExpr read that, never the members. Row checks
 *   (terms.ts) build and read terms this way, so a Compute expression over a row's fields composes with the row's own
 *   comparisons.
 * - Owned schema values. Every value this package builds (relations, closed and derived relations, statements, sides,
 *   selections, schemas, contexts, world relations, roles and logins) is frozen, carries its Description under a
 *   non-enumerable `desc`, and is registered here, so ownership trusts exactly the values the builders made and a
 *   JavaScript look-alike is decoded strictly.
 */
export const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
	if (typeof value !== "object" || value === null || isList(value)) {
		return false
	}
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/** A builder location: the label and the user's call site (core/loc.ts). */
export const builderLoc = (label: string, path: ReadonlyArray<string | number>): SourceLoc =>
	captureLoc(label, path)

/** A builder's refusal of the user's call: MalformedDescription at `label`, at the user's call site. */
export const malformed = (label: string, what: string): CompileError =>
	malformedDescription(builderLoc(label, []), what)

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

/** A nonempty list of distinct declared names, in the order written, which is meaningful. */
export const requireNames = (
	value: unknown,
	label: string,
	what: string
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
			throw malformed(label, `${what}: distinct field names, ${JSON.stringify(item)} repeats`)
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
 * descriptor and a JavaScript look-alike are refused (MalformedDescription).
 */
export const describedField = (value: unknown, label: string): Described =>
	orThrow(describeField(value, builderLoc(label, [])))

/** The FieldDesc of a field descriptor a builder made. */
export const fieldDescOf = (value: unknown, label: string): FieldDesc =>
	describedField(value, label).desc

/**
 * The handles of the roster a closedId descriptor references, when it carries the closed relation (the field
 * builder keeps it as `roster`), through any depth of contracts (a contract keeps its base descriptor as `base`);
 * undefined when only its Description is known.
 */
export const rosterHandlesOf = (value: unknown): ReadonlyArray<string> | undefined => {
	if (!hasProperties(value)) {
		return undefined
	}
	if (!hasProperties(value["roster"])) {
		return value["base"] === undefined ? undefined : rosterHandlesOf(value["base"])
	}
	const handles = value["roster"]["handles"]
	return isList(handles) && handles.every(isName) ? handles : undefined
}

/** A closed handle becomes a PostgreSQL enum label, which holds at most NAMEDATALEN - 1 bytes (pg_enum.h). */
export const maxEnumLabelBytes = 63

export interface PredicateValue extends Built {
	readonly predicate: true
	readonly expr: OpenExpr
}

export const isParam = (value: unknown): boolean =>
	hasProperties(value) && typeof value["param"] === "string" && value["expr"] === undefined

export const predicateValue = (expr: OpenExpr): PredicateValue =>
	registerPredicate(Object.freeze({ ...builtMark, predicate: true, expr }), expr)

/** Queries: a query value carries its QueryDesc under `desc`, as every owned value does. */
export const queryDescOf = (value: unknown, label: string): QueryDesc => {
	if (hasProperties(value) && hasProperties(value["desc"])) {
		return orThrow(decodeDesc("query", value["desc"]))
	}
	throw malformed(label, "a query built by query(schema), carrying its description")
}

/**
 * The schema or role value each query value the builder made over one is over, registered by the builder
 * (query/build/query.ts): what role admission reads to refuse a query entry built over anything but its base or one of
 * its levels. A query rebuilt from its Description alone carries none.
 */
const querySchemas = new WeakMap<object, object>()

export const registerQuerySchema = (query: object, schema: object): void => {
	querySchemas.set(query, schema)
}

export const querySchemaOf = (value: unknown): object | undefined =>
	hasProperties(value) ? querySchemas.get(value) : undefined

/**
 * Each kind of owned value: the value a builder returns, at the widest of its public type, and the Description it
 * carries. An alternatives law is owned as its own kind, never as a statement.
 */
interface OwnedKinds {
	readonly relation: { readonly value: AnyRelation; readonly desc: OrdinaryRelationDesc }
	readonly closed: { readonly value: AnyClosed; readonly desc: ClosedRelationDesc }
	readonly derived: { readonly value: AnyDerived; readonly desc: DerivedDraft }
	readonly statement: {
		readonly value: Exclude<Statement, AlternativesBase>
		readonly desc: StatementDesc
	}
	readonly alternatives: { readonly value: AlternativesBase; readonly desc: AlternativesDesc }
	readonly side: { readonly value: AnySide; readonly desc: SideDesc }
	readonly selection: { readonly value: Selection<unknown, unknown>; readonly desc: SelectionDesc }
	readonly schema: { readonly value: AnySchema; readonly desc: SchemaDesc }
	readonly context: { readonly value: AnyContext; readonly desc: ContextDesc }
	readonly world: { readonly value: AnyWorld; readonly desc: WorldDraft }
	readonly role: { readonly value: AnyRole; readonly desc: RoleDesc }
	readonly login: { readonly value: AnyLogin; readonly desc: LoginDesc }
}

export type OwnedKind = keyof OwnedKinds

const ownedKinds: ReadonlyArray<OwnedKind> = [
	"relation",
	"closed",
	"derived",
	"statement",
	"alternatives",
	"side",
	"selection",
	"schema",
	"context",
	"world",
	"role",
	"login"
]

interface OwnedEntry<K extends OwnedKind> {
	readonly value: OwnedKinds[K]["value"]
	readonly desc: OwnedKinds[K]["desc"]
}

/**
 * The values this package built, one registry per kind. A WeakMap holds nothing alive and is never enumerated, so it
 * is no cache.
 */
const owned: { readonly [K in OwnedKind]: WeakMap<object, OwnedEntry<K>> } = {
	relation: new WeakMap(),
	closed: new WeakMap(),
	derived: new WeakMap(),
	statement: new WeakMap(),
	alternatives: new WeakMap(),
	side: new WeakMap(),
	selection: new WeakMap(),
	schema: new WeakMap(),
	context: new WeakMap(),
	world: new WeakMap(),
	role: new WeakMap(),
	login: new WeakMap()
}

/**
 * Defines `value`'s Description as a non-enumerable `desc`, freezes it, registers it as an owned value of `kind`, and
 * returns it. Freezing leaves every member non-writable and non-configurable.
 */
export const ownValue = <K extends OwnedKind, V extends OwnedKinds[K]["value"]>(
	value: V,
	kind: K,
	desc: OwnedKinds[K]["desc"]
): V => {
	Object.defineProperty(value, "desc", {
		value: desc,
		enumerable: false,
		writable: false,
		configurable: false
	})
	Object.freeze(value)
	const entry: OwnedEntry<K> = { value, desc }
	owned[kind].set(value, entry)
	return value
}

/** The kind of an owned value, undefined for any value the builders did not make. */
export const ownedKind = (value: unknown): OwnedKind | undefined =>
	hasProperties(value) ? ownedKinds.find((kind) => owned[kind].has(value)) : undefined

/** The value and Description of an owned value of `kind`, or undefined when the value is not one. */
export const ownedEntry = <K extends OwnedKind>(
	value: unknown,
	kind: K
): OwnedEntry<K> | undefined => (hasProperties(value) ? owned[kind].get(value) : undefined)

/** The Description of an owned value of `kind`, or undefined when the value is not one. */
export const ownedDesc = <K extends OwnedKind>(
	value: unknown,
	kind: K
): OwnedKinds[K]["desc"] | undefined => ownedEntry(value, kind)?.desc

/**
 * A frozen shallow copy of an array or record a caller handed in, so a later mutation of the caller's value cannot
 * reach an owned description.
 */
export const frozenArray = <A>(items: ReadonlyArray<A>): ReadonlyArray<A> =>
	Object.freeze([...items])

/**
 * The typed forms of frozenArray and frozenRecord, for the typed builders: the same copies, typed as what was copied.
 * A tuple's copy is typed `readonly [...T]`, which is T itself for every concrete tuple. A record's copy keeps its own
 * enumerable string-keyed members in order, as frozenRecord's Object.entries reads them.
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

/**
 * A frozen copy of a record of records whose members are frozen copies too, typed as what was copied. Its keys follow
 * `order` (a closed relation's facts follow its roster), and any key `order` does not list follows them.
 */
export const frozenCopies = <T extends Readonly<Record<string, object>>>(
	record: T,
	order: ReadonlyArray<string>
): T => {
	const copy = { ...record }
	const members = new Map(Object.entries(copy))
	for (const key of members.keys()) {
		Reflect.deleteProperty(copy, key)
	}
	const keys = [
		...order.filter((key) => members.has(key)),
		...[...members.keys()].filter((key) => !order.includes(key))
	]
	for (const key of keys) {
		const member = members.get(key)
		if (member !== undefined) {
			Object.defineProperty(copy, key, {
				value: frozenCopy(member),
				enumerable: true,
				writable: true,
				configurable: true
			})
		}
	}
	for (const key of Object.getOwnPropertySymbols(copy)) {
		Reflect.deleteProperty(copy, key)
	}
	Object.freeze(copy)
	return copy
}

export const frozenRecord = <A>(
	record: Readonly<Record<string, A>>
): Readonly<Record<string, A>> => {
	const out: Record<string, A> = {}
	for (const [key, value] of Object.entries(record)) {
		Object.defineProperty(out, key, {
			value,
			enumerable: true,
			writable: false,
			configurable: false
		})
	}
	return Object.freeze(out)
}
