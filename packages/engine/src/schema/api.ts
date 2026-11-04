import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { closed as closedBuilder, relation as relationBuilder } from "#compiler/schema/relation.ts"
import { schema as schemaBuilder } from "#compiler/schema/schema.ts"
import {
	alternatives as alternativesBuilder,
	capacity as capacityBuilder,
	check as checkBuilder,
	contained as containedBuilder,
	key as keyBuilder,
	mirrors as mirrorsBuilder,
	mutable as mutableBuilder,
	on as onBuilder,
	duration as runtimeDuration,
	ref as runtimeRef,
	weigh as runtimeWeigh,
	within as runtimeWithin,
	select as selectBuilder
} from "#compiler/schema/statements.ts"
import { context as contextBuilder, role as roleBuilder } from "#compiler/schema/world.ts"
import type { Parameterless, Predicate } from "#compiler/types/core/phantom.ts"
import type { FieldBase, HandleOf } from "#compiler/types/fields/field.ts"
import type {
	AnyClosed,
	AnyRelation,
	DistinctFields,
	EnumClosed,
	Fact,
	Relation
} from "#compiler/types/schema/relation.ts"

import type {
	AnySchema,
	DerivedAt,
	LevelsOf,
	Schema,
	StatementsWithin
} from "#compiler/types/schema/schema.ts"

import type {
	Alternatives,
	AnySide,
	ArmsApartFromParent,
	ArmsCompatible,
	ArmsOfRoster,
	AtLeastOneArm,
	Capacity,
	CapacityRule,
	Check,
	Containment,
	DiscriminatorsOf,
	Duration,
	Key,
	KeyRef,
	Mirrors,
	Mutable,
	Ref,
	RelationOfKey,
	RowScalars,
	Selection,
	Side,
	SideHeading,
	SidesCompatible,
	Statement,
	Weight,
	WithinConstructor
} from "#compiler/types/schema/statements.ts"

import type {
	Context,
	ContextField,
	ContextOptions,
	EntriesCheck,
	EntryContexts,
	EntryValue,
	RefreshableKeys,
	Role,
	RoleOptions,
	RoleRelations,
	WritableKeys
} from "#compiler/types/schema/world.ts"

/**
 * The typed schema facade: relation, closed, schema, schema.extend, the statement constructors, context and role under
 * their precise public signatures (login, which admits its workloads, is program/workload/login.ts) (types/schema), each a view over the one builder of its value in this package
 * (relation.ts, schema.ts, statements.ts, world.ts). A builder checks a JavaScript caller's arguments through its admission core, records the
 * Description, and owns the literal of its arguments, frozen copies (protocol.ts ownValue), so the value has its public
 * type by construction; its type parameters are as wide as that value allows, and a view here narrows them to what the
 * public signature states and calls the builder with them. A list a builder copies is typed `readonly [...T]`, which is
 * T itself for every list a call writes. A JavaScript caller's extra argument is refused; the types admit none. The
 * public barrel public/schema.ts exports these; test/unit/schema pins the runtime behavior and test/types/schema the
 * signatures.
 *
 * The third argument is the primary key: a required, nonempty list of the relation's own field names, each once, in
 * the order written. The value holds a frozen copy of it, `readonly [...PrimaryKey]`, which is PrimaryKey itself for
 * every key a call writes.
 */
export const relation = <
	const Name extends string,
	const Fields extends Record<string, FieldBase>,
	const PrimaryKey extends readonly [keyof Fields & string, ...(keyof Fields & string)[]]
>(
	name: Name,
	fields: Fields,
	primaryKey: PrimaryKey & DistinctFields<PrimaryKey>,
	...extra: ReadonlyArray<never>
): Relation<Name, Fields, readonly [...PrimaryKey]> =>
	relationBuilder<Name, Fields, PrimaryKey>(name, fields, primaryKey, extra)

/**
 * closed(name, handles) is the enum-only form. Its `with(payload, facts)` builds a new closed relation of the same name
 * and roster with a typed payload fact for every handle; the enum-only form is that relation with the empty payload,
 * one Description. Every form's `handle(member)` is the typed head term of a member of its roster.
 */
export const closed = <
	const Name extends string,
	const Handles extends readonly [string, ...string[]]
>(
	name: Name,
	handles: Handles & NonEmptyReadonlyArray<Handles[number]>,
	...extra: ReadonlyArray<never>
): EnumClosed<Name, readonly [...Handles]> => closedBuilder<Name, Handles>(name, handles, extra)

/**
 * schema(name, relations, statements). The statements are a frozen copy, `readonly [...Statements]`, which is
 * Statements for every tuple a call writes.
 */
const rootSchema = <
	const Name extends string,
	const Relations extends Record<string, AnyRelation | AnyClosed>,
	const Statements extends ReadonlyArray<Statement>
>(
	name: Name,
	relations: Relations,
	statements: Statements & StatementsWithin<Statements, Relations>,
	...extra: ReadonlyArray<never>
): Schema<Name, Relations, readonly [...Statements]> =>
	schemaBuilder<Name, Relations, Statements>(name, relations, statements, extra)

/**
 * Adds relations, including derived relations over the base, and statements, under the same name.
 * A derived definition must be a query over the base or a lower level. Query is invariant in its schema, so a
 * query over this extension, which would read its own level, is no query over any level below it.
 */
const extend = <
	Base extends AnySchema,
	const Relations extends Record<string, AnyRelation | AnyClosed | DerivedAt<LevelsOf<Base>>>,
	const Statements extends ReadonlyArray<Statement>
>(
	base: Base,
	relations: Relations,
	statements: Statements & StatementsWithin<Statements, Base["relations"] & Relations>,
	...extra: ReadonlyArray<never>
): Schema<
	Base["name"],
	Base["relations"] & Relations,
	readonly [...Base["statements"], ...Statements],
	Base
> => schemaBuilder.extend<Base, Relations, Statements>(base, relations, statements, extra)

export const schema: typeof rootSchema & { readonly extend: typeof extend } = Object.freeze(
	Object.assign(rootSchema, { extend })
)

/** An additional candidate key; lowers to UNIQUE. */
export const key = <
	R extends AnyRelation,
	const K extends readonly [keyof Fact<R> & string, ...(keyof Fact<R> & string)[]]
>(
	target: R,
	fields: K & DistinctFields<K>
): Key<R, readonly [...K]> => keyBuilder<R, K>(target, fields)

/**
 * Opt in to in-place change. Without it a relation is immutable: facts are added and deleted, never changed. The
 * default is pinned.
 */
export const mutable = <R extends AnyRelation>(target: R): Mutable<R> => mutableBuilder<R>(target)

export const check = <const Name extends string, R extends AnyRelation, Pr extends Predicate>(
	name: Name,
	target: R,
	predicate: (row: RowScalars<R>) => Pr & Parameterless<Pr>
): Check<Name, R> => checkBuilder<Name, R>(name, target, predicate)

/** A side names at least one field of its source, each once (ir/desc.ts SideDesc). */
export const on = <
	R extends AnyRelation | AnyClosed | Selection<unknown, unknown>,
	const F extends readonly [keyof SideHeading<R> & string, ...(keyof SideHeading<R> & string)[]]
>(
	side: R,
	...fields: F & DistinctFields<F>
): Side<R, readonly [...F]> => {
	const list: F = fields
	return onBuilder<R, F>(side, list)
}

export const select = <R extends AnyRelation | AnyClosed, const B extends Partial<Fact<R>>>(
	target: R,
	bindings: B
): Selection<R, B> => selectBuilder<R, B>(target, bindings)

export const contained = <L extends AnySide, R extends AnySide>(
	left: L,
	right: R & SidesCompatible<L, R>
): Containment<L, R> => containedBuilder<L, R>(left, right)

export const mirrors = <L extends AnySide, R extends AnySide>(
	left: L,
	right: R & SidesCompatible<L, R>
): Mirrors<L, R> => mirrorsBuilder<L, R>(left, right)

export const alternatives = <
	PK extends AnyRelation | Key<AnyRelation, ReadonlyArray<string>>,
	C extends AnyClosed,
	const D extends DiscriminatorsOf<RelationOfKey<PK>, C>,
	const Arms extends Partial<{ readonly [H in HandleOf<C>]: KeyRef<AnyRelation> }>
>(
	parent: PK,
	discriminator: D,
	roster: C,
	arms: Arms &
		ArmsCompatible<PK, Arms> &
		ArmsOfRoster<C, Arms> &
		ArmsApartFromParent<PK, Arms> &
		AtLeastOneArm<Arms>
): Alternatives<PK, D, C, Arms> =>
	alternativesBuilder<PK, D, C, Arms>(parent, discriminator, roster, arms)

export const capacity = <T extends AnySide, F extends AnySide>(
	target: T,
	rule: CapacityRule<F>
): Capacity<T, F> => capacityBuilder<T, F>(target, rule)

export const ref: (field: string) => Ref = runtimeRef
export const weigh: (field: string | Duration) => Weight = runtimeWeigh
export const duration: (spanField: string) => Duration = runtimeDuration
export const within: WithinConstructor = runtimeWithin

/**
 * The session's relation parameters: a source of at most one fact, matched by a rule of any query over any schema.
 * `claim` names the nested claim object the fields are read from; without it they are the payload's own top-level
 * claims.
 */
export const context = <
	const Name extends string,
	const Fields extends Readonly<Record<string, ContextField>>
>(
	name: Name,
	fields: Fields,
	...options: ContextOptions
): Context<Name, Fields> => contextBuilder<Name, Fields>(name, fields, ...options)

/**
 * A schema whose relations are defined over the base: whole relations of the base, each under its own name, and
 * queries over it. `write` names role relations, `refresh` derived whole entries.
 */
export const role = <
	Base extends AnySchema,
	const Name extends string,
	const Rs extends Readonly<Record<string, EntryValue>>,
	const W extends ReadonlyArray<WritableKeys<Rs>> = readonly [],
	const F extends ReadonlyArray<RefreshableKeys<Rs>> = readonly []
>(
	base: Base,
	name: Name,
	relations: Rs & EntriesCheck<Base, Rs>,
	...options: RoleOptions<W, F>
): Role<Base, Name, RoleRelations<Rs>, W[number], F[number], EntryContexts<Rs>> =>
	roleBuilder<Base, Name, Rs, W, F>(base, name, relations, ...options)
