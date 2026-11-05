import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { closed as closedBuilder, relation as relationBuilder } from "#compiler/schema/relation.ts"
import { schema as schemaBuilder } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
	capacityBuilder,
	checkBuilder,
	containedBuilder,
	keyBuilder,
	mirrorsBuilder,
	mutableBuilder,
	onBuilder,
	predBuilder,
	runtimeDuration,
	runtimeRef,
	runtimeWeigh,
	runtimeWithin,
	selectBuilder
} from "#compiler/schema/statements.ts"
import { context as contextBuilder, role as roleBuilder } from "#compiler/schema/world.ts"
import type { Parameterless, Predicate } from "#compiler/types/core/phantom.ts"
import type { FieldBase, HandleOf } from "#compiler/types/fields/field.ts"
import type {
	AnyClosed,
	AnyRelation,
	DistinctFields,
	DistinctTerms,
	EnumClosed,
	Relation
} from "#compiler/types/schema/relation.ts"

import type {
	AnySchema,
	DerivedAt,
	LevelsOf,
	Schema,
	StatementsWithin,
	UnderOwnNames
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
	Pred,
	Ref,
	RelationOfKey,
	RowScalars,
	Selection,
	Side,
	SidesCompatible,
	Statement,
	TermOf,
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
 * their precise public signatures (types/schema; login, which admits its workloads, is program/workload/login.ts),
 * each a view over the one builder of its value in this package (relation.ts, schema.ts, statements.ts, world.ts),
 * and the one module that exports the public names. A builder checks a JavaScript caller's arguments through its
 * admission core, records the Description, and owns the literal of its arguments, frozen copies (protocol.ts
 * ownValue), so the value has its public type by construction; its type parameters are as wide as that value allows,
 * and a view here narrows them to what the public signature states and calls the builder with them. A list a builder
 * copies is typed `readonly [...T]`, which is T itself for every list a call writes. A JavaScript caller's extra
 * argument is refused; the types admit none. The public barrel public/schema.ts exports these; test/unit/schema pins
 * the runtime behavior and test/types/schema the signatures.
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
 * schema(name, relations, statements). Each relation sits under its own name, so the record is the schema's index by
 * name. The statements are a frozen copy, `readonly [...Statements]`, which is Statements for every tuple a call
 * writes.
 */
const rootSchema = <
	const Name extends string,
	const Relations extends Record<string, AnyRelation | AnyClosed>,
	const Statements extends ReadonlyArray<Statement>
>(
	name: Name,
	relations: Relations & UnderOwnNames<Relations>,
	statements: Statements & StatementsWithin<Statements, Relations>,
	...extra: ReadonlyArray<never>
): Schema<Name, Relations, readonly [...Statements]> =>
	schemaBuilder<Name, Relations, Statements>(name, relations, statements, extra)

/**
 * Adds relations, including derived relations over the base, and statements, under the same name, each relation
 * under its own name. A derived definition must be a query over the base or a lower level. Query is invariant in its
 * schema, so a query over this extension, which would read its own level, is no query over any level below it.
 */
const extend = <
	Base extends AnySchema,
	const Relations extends Record<string, AnyRelation | AnyClosed | DerivedAt<LevelsOf<Base>>>,
	const Statements extends ReadonlyArray<Statement>
>(
	base: Base,
	relations: Relations & UnderOwnNames<Relations>,
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

/**
 * key(side): no two of the side's facts share its terms, UNIQUE NULLS DISTINCT. Over a whole relation and its fields
 * it is a candidate key; over a selection or a pred term it constrains only the facts the side reads. A closed relation
 * is keyed by its handle alone, so no side of one is keyed.
 */
export const key = <S extends Side<AnyRelation | Selection<AnyRelation>>>(side: S): Key<S> =>
	keyBuilder<S>(side)

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

/**
 * A side reads at least one term of its source, each once (ir/desc.ts SideDesc): a field, or pred of a natural field,
 * whose fact has no tuple on the side where the field is zero.
 */
export const on = <
	R extends AnyRelation | AnyClosed | Selection<AnyRelation | AnyClosed>,
	const T extends readonly [TermOf<R>, ...TermOf<R>[]]
>(
	source: R,
	...terms: T & DistinctTerms<T>
): Side<R, readonly [...T]> => {
	const list: T = terms
	return onBuilder<R, T>(source, list)
}

/** pred(field): a natural field's value less one, defined only above zero; on(...) takes it as a term. */
export const pred = <const F extends string>(field: F): Pred<F> => predBuilder<F>(field)

/**
 * select(R, (row) => predicate): the facts of R a row predicate over their own fields holds of, in the row-check
 * language, the one spelling of a selection.
 */
export const select = <R extends AnyRelation | AnyClosed, Pr extends Predicate>(
	target: R,
	predicate: (row: RowScalars<R>) => Pr & Parameterless<Pr>
): Selection<R> => selectBuilder<R>(target, predicate)

export const contained = <L extends AnySide, R extends AnySide>(
	left: L,
	right: R & SidesCompatible<L, R>
): Containment<L, R> => containedBuilder<L, R>(left, right)

/** mirrors(a, b): sugar for contained(a, b) and contained(b, a), which the schema states in its place. */
export const mirrors = <L extends AnySide, R extends AnySide>(
	left: L,
	right: R & SidesCompatible<L, R>
): Mirrors<L, R> => mirrorsBuilder<L, R>(left, right)

export const alternatives = <
	PK extends AnyRelation | Key<Side<AnyRelation, ReadonlyArray<string>>>,
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
