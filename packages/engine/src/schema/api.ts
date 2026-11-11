import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	closed as closedBuilder,
	closedRelation as closedRelationBuilder,
	generatedRelation,
	relation as relationBuilder
} from "#compiler/schema/relation.ts"
import { schema as schemaBuilder } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
	checkBuilder,
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	keyBuilder,
	mirrorsBuilder,
	monoids,
	mutableBuilder,
	onBuilder,
	orderedBuilder,
	predBuilder,
	selectBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import { context as contextBuilder, role as roleBuilder } from "#compiler/schema/world.ts"
import type { UnwrittenFieldsOf } from "#compiler/types/changeset/changeset.ts"
import type {
	MembersTyped,
	Parameterless,
	Predicate,
	Refusal,
	Simplify
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived, RuleReadDerived } from "#compiler/types/derived/derived.ts"
import type {
	FieldBase,
	GeneratedField,
	HandleOf,
	StoredOnlySql,
	WritingTag
} from "#compiler/types/fields/field.ts"
import type {
	AnyClosed,
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	ClosedIdFieldOf,
	ClosedRelation,
	DistinctFields,
	DistinctHandles,
	FactOfFields,
	KeyFieldOf,
	Relation,
	ConflictsAtKey,
	KeyLawRefusal,
	Roster
} from "#compiler/types/schema/relation.ts"

import type {
	AnySchema,
	DerivedAt,
	LevelsOf,
	Schema,
	StatementsBelow,
	StatementsByName,
	StatementsReadBack,
	StatementsWithin,
	UnderOwnNames
} from "#compiler/types/schema/schema.ts"

import type { MonoidName } from "#compiler/ir/desc.ts"
import type {
	Alternatives,
	AnyFamily,
	AnyFin,
	AnyMonoid,
	AnySide,
	ArmsApartFromParent,
	ArmsCompatible,
	ArmsOfRoster,
	AtLeastOneArm,
	Check,
	Containment,
	Counted,
	CountedMember,
	CountFieldIn,
	FamilySlots,
	DiscriminatorsOf,
	DistinctTerms,
	Fin,
	FinShows,
	Fold,
	FoldEnd,
	FoldStep,
	Key,
	KeyRef,
	MemberRelationOf,
	Mirrors,
	Monoid as MonoidOf,
	Mutable,
	NoSetKey,
	Ordered,
	OrderedMember,
	OverSlots,
	OwnerRelationOf,
	KeyShows,
	Pred,
	RowScalars,
	Selection,
	SelfFamily,
	WholeMember,
	Showing,
	ShowingKeyed,
	ShowingKind,
	Shows,
	Side,
	SideHosts,
	SideShows,
	SideShowsKeyed,
	SidesCompatible,
	SourceShowing,
	Statement,
	TermOf,
	Tree,
	TreeRootOf
} from "#compiler/types/schema/statements.ts"

import type {
	Context,
	ContextField,
	ContextFieldBases,
	ContextOptions,
	DistinctWrites,
	EntriesCheck,
	EntryContexts,
	EntryValue,
	RefreshableKeys,
	Role,
	RoleOptionRecord,
	RoleRelations,
	WritableKeys
} from "#compiler/types/schema/world.ts"

/**
 * The typed schema facade: relation, relation.generated, closed, closed.relation, schema, schema.extend, the statement
 * constructors, context and role under their precise public signatures (types/schema; login, which admits its
 * workloads, is program/workload/login.ts), each a view over the one builder of its value in this package
 * (relation.ts, schema.ts, statements.ts, world.ts), and the one module that exports the public names. A builder checks
 * a JavaScript caller's arguments through its admission core, records the Description, and owns the literal of its
 * arguments, frozen copies (protocol.ts ownValue), so the value has its public type by construction; its type
 * parameters are as wide as that value allows, and a view here narrows them to what the public signature states and
 * calls the builder with them. A list a builder copies is typed `readonly [...T]`, which is T itself for every list a
 * call writes. A JavaScript caller's extra argument is refused; the types admit none. The public barrel
 * public/schema.ts exports these; test/unit/schema pins the runtime behavior and test/types/schema the signatures.
 *
 * The third argument is the primary key: a required, nonempty list of the relation's own field names, each once, in
 * the order written. The value holds a frozen copy of it, `readonly [...PrimaryKey]`, which is PrimaryKey itself for
 * every key a call writes.
 */
const ordinaryRelation = <
	const Name extends string,
	const Fields extends Record<string, FieldBase>,
	const PrimaryKey extends readonly [KeyFieldOf<Fields>, ...KeyFieldOf<Fields>[]]
>(
	name: Name,
	fields: Fields,
	primaryKey: PrimaryKey & DistinctFields<PrimaryKey>,
	...extra: ReadonlyArray<never>
): Relation<Name, Fields, readonly [...PrimaryKey]> =>
	relationBuilder<Name, Fields, PrimaryKey>(name, fields, primaryKey, extra)

/** A relation's generated fields are named apart from its written ones: a field is written one way. */
type GeneratedApart<Written, G> = [keyof Written & keyof G] extends [never]
	? unknown
	: Refusal<"a generated field is named apart from the relation's written fields">

/**
 * The row a generation expression reads: its relation's fields as a row check reads them, less every field its caller
 * never writes (UnwrittenFieldsOf), a drawn or an accumulated one, which grizzle writes on the host: PostgreSQL
 * generates a column from the caller's fields alone.
 */
type GenerationRow<R extends Shows<string, unknown>> = Omit<RowScalars<R>, UnwrittenFieldsOf<R>>

/**
 * relation.generated(name, written, primaryKey, (row) => ({ f: generated(type, term), ... })): a relation whose
 * written fields its caller writes and whose generated fields PostgreSQL writes, each a STORED generated column whose
 * term reads `row`, the row of the fields its caller writes alone (GenerationRow): a generation expression reads no
 * generated column, and no drawn or accumulated field. The primary key is over written fields. Its fields are both, and
 * its facts hold both; its additions hold only the written.
 */
const generated = <
	const Name extends string,
	const Written extends Record<string, FieldBase>,
	const PrimaryKey extends readonly [KeyFieldOf<Written>, ...KeyFieldOf<Written>[]],
	const G extends Record<string, GeneratedField<FieldBase>>
>(
	name: Name,
	written: Written,
	primaryKey: PrimaryKey & DistinctFields<PrimaryKey>,
	generate: (
		row: GenerationRow<Relation<Name, Written, readonly [...PrimaryKey]>>
	) => G & GeneratedApart<Written, G>,
	...extra: ReadonlyArray<never>
): Relation<Name, Simplify<Written & G>, readonly [...PrimaryKey]> =>
	generatedRelation<Name, Written, PrimaryKey, G>(name, written, primaryKey, generate, extra)

export const relation: typeof ordinaryRelation & { readonly generated: typeof generated } =
	Object.freeze(Object.assign(ordinaryRelation, { generated }))

/** A closed relation's fields are closed ids, and open-typed values that are no serial, span, set, vector or bytes. */
type ClosedFieldsCheck<Fields> = [
	{
		[K in keyof Fields]-?: Fields[K] extends
			| { readonly writing: WritingTag }
			| { readonly sql: "range" | "vector" | "bits" | StoredOnlySql }
			? K
			: never
	}[keyof Fields]
] extends [never]
	? unknown
	: Refusal<"a closed relation's field is a closed id, or a value of a type that is no serial, span, set, vector or bytes">

/**
 * closed(name, handles): a roster, the handles it introduces, each once, in declared order, which is their codes'
 * order and comparison order. Its `handle(member)` is the typed constant of a member.
 */
const closedRoster = <
	const Name extends string,
	const Handles extends readonly [string, ...string[]]
>(
	name: Name,
	handles: Handles & NonEmptyReadonlyArray<Handles[number]> & DistinctHandles<Handles>,
	...extra: ReadonlyArray<never>
): Roster<Name, readonly [...Handles]> => closedBuilder<Name, Handles>(name, handles, extra)

/**
 * closed.relation(name, fields, key, rows): a closed relation, its rows fixed when the schema compiles. The key is
 * required, a nonempty list of its closed-id fields, each once; a set lists every field. Its rows are facts of its
 * fields, no two of one key. `at` and `row` are its closed reads. Its migration states each of its constants as one hex
 * literal; no argument chooses another form.
 */
const closedRelation = <
	const Name extends string,
	const Fields extends Record<string, FieldBase>,
	const KeyFields extends readonly [ClosedIdFieldOf<Fields>, ...ClosedIdFieldOf<Fields>[]],
	const Rows extends ReadonlyArray<FactOfFields<Fields>>
>(
	name: Name,
	fields: Fields & ClosedFieldsCheck<Fields>,
	key: KeyFields & DistinctFields<KeyFields>,
	rows: Rows & DistinctRows<Name, Rows, KeyFields>,
	...extra: ReadonlyArray<never>
): ClosedRelation<Name, Fields, readonly [...KeyFields]> =>
	closedRelationBuilder<Name, Fields, KeyFields>(name, fields, key, rows, extra)

/**
 * A closed relation's rows are a set by identity: a row written twice is one row, and two written out with one key and
 * different values break its key law (ConflictsAtKey).
 */
type DistinctRows<Name, Rows, KeyFields extends ReadonlyArray<string>> =
	ConflictsAtKey<Rows, KeyFields> extends true ? KeyLawRefusal<Name, KeyFields> : unknown

export const closed: typeof closedRoster & { readonly relation: typeof closedRelation } =
	Object.freeze(Object.assign(closedRoster, { relation: closedRelation }))

/**
 * schema(name, relations, statements). Each relation sits under its own name, so the record is the schema's index by
 * name. The statements are a frozen copy, held by name (StatementsByName) and read back whole, so `statements` is the
 * tuple the call writes: every tuple of statements reads back as itself (StatementsReadBack). A relation or statement
 * typed `any` is refused (UnderOwnNames, StatementsWithin).
 */
const rootSchema = <
	const Name extends string,
	const Relations extends Record<string, AnyRelation | AnyClosed>,
	const Statements extends ReadonlyArray<Statement>
>(
	name: Name,
	relations: Relations & UnderOwnNames<Relations>,
	statements: Statements &
		StatementsWithin<Statements, Relations> &
		StatementsReadBack<Statements, Relations>,
	...extra: ReadonlyArray<never>
): Schema<Name, Relations, StatementsByName<Statements, Relations>> =>
	schemaBuilder<Name, Relations, Statements>(name, relations, statements, extra)

/**
 * schema.extend(base, name, relations, statements): a level of its own name over `base`, with relations, derived
 * relations over the base among them, each under its own name, and statements. Its relations install in a PostgreSQL
 * schema of its own, beside the base's, in one installation with every level below it. A derived definition must be a
 * query over the base or a lower level. Query is invariant in its schema, so a query over this level, which would read
 * its own relations, is no query over any level below it. Its statements are the base's, then its own, held by name
 * over the base's relations and its own. A relation or statement typed `any` is refused (UnderOwnNames,
 * StatementsWithin).
 */
const extend = <
	Base extends AnySchema,
	const Name extends string,
	const Relations extends Record<string, AnyRelation | AnyClosed | DerivedAt<LevelsOf<Base>>>,
	const Statements extends ReadonlyArray<Statement>
>(
	base: Base & { readonly statements: StatementsBelow<Base> },
	name: Name,
	relations: Relations & UnderOwnNames<Relations>,
	statements: Statements &
		StatementsWithin<Statements, Base["relations"] & Relations> &
		StatementsReadBack<Statements, Base["relations"] & Relations>,
	...extra: ReadonlyArray<never>
): Schema<
	Name,
	Base["relations"] & Relations,
	StatementsByName<Statements, Base["relations"] & Relations>,
	Base
> =>
	schemaBuilder.extend<Base, Name, Relations, Statements>(base, name, relations, statements, extra)

export const schema: typeof rootSchema & { readonly extend: typeof extend } = Object.freeze(
	Object.assign(rootSchema, { extend })
)

/**
 * key(side): no two of the side's facts share its terms, UNIQUE NULLS DISTINCT. Over a whole relation and its fields
 * it is a candidate key; over a selection or a pred term it constrains only the facts the side reads. A roster is keyed
 * by its handle and a closed relation by its declared key, so no side of either is keyed.
 */
export const key = <
	S extends Side<AnyRelation | AnyDerived | Selection<AnyRelation | AnyDerived>>,
	N extends string,
	C
>(
	side: S & SideShows<N, C> & NoSetKey<C, S["terms"]>
): Key<S> => keyBuilder<S>(side)

/**
 * Opt in to in-place change. Without it a relation is immutable: facts are added and deleted, never changed. The
 * default is pinned.
 */
export const mutable = <R extends AnyRelation>(target: R): Mutable<R> => mutableBuilder<R>(target)

export const check = <
	const Name extends string,
	R extends AnyRelation | RuleReadDerived,
	N extends string,
	C,
	Pr extends Predicate<never>
>(
	name: Name,
	target: R & Showing<N, C>,
	predicate: (row: RowScalars<Shows<N, C>>) => Pr & Parameterless<Pr>
): Check<Name, R> => checkBuilder<Name, R>(name, target, predicate)

/**
 * A side reads at least one term of its source, each once (ir/desc.ts SideDesc): a field, or pred of a natural field,
 * whose fact has no tuple on the side where the field is zero.
 */
export const on = <
	R extends
		| AnyRelation
		| AnyClosed
		| RuleReadDerived
		| Selection<AnyRelation | AnyClosed | RuleReadDerived>,
	C,
	const T extends readonly [TermOf<C>, ...TermOf<C>[]]
>(
	source: R & SourceShowing<string, C>,
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
export const select = <
	R extends AnyRelation | AnyClosed | RuleReadDerived,
	N extends string,
	C,
	Pr extends Predicate<never>
>(
	target: R & Showing<N, C>,
	predicate: (row: RowScalars<Shows<N, C>>) => Pr & Parameterless<Pr>
): Selection<R> => selectBuilder<R>(target, predicate)

/**
 * contained(source, target): every tuple of the source side is one of the target side's. A target selected by
 * equalities that fix fields beyond its terms, `on(select(T, (t) => t.and(t.eq(t.kind, "x"), t.eq(t.root, t.id))),
 * "id")`, meets the source's tuples there.
 */
export const contained = <
	L extends AnySide,
	R extends AnySide,
	NL extends string,
	CL,
	NR extends string,
	CR
>(
	left: L & SideShows<NL, CL>,
	right: R &
		SideShows<NR, CR> &
		SidesCompatible<SideHosts<CL, L["terms"]>, SideHosts<CR, R["terms"]>>
): Containment<L, R> => containedBuilder<L, R>(left, right)

/** mirrors(a, b): sugar for contained(a, b) and contained(b, a), which the schema states in its place. */
export const mirrors = <
	L extends AnySide,
	R extends AnySide,
	NL extends string,
	CL,
	NR extends string,
	CR
>(
	left: L & SideShows<NL, CL>,
	right: R &
		SideShows<NR, CR> &
		SidesCompatible<SideHosts<CL, L["terms"]>, SideHosts<CR, R["terms"]>>
): Mirrors<L, R> => mirrorsBuilder<L, R>(left, right)

export const alternatives = <
	PK extends AnyRelation | Key<Side<AnyRelation, ReadonlyArray<string>>>,
	PN extends string,
	PC,
	PF,
	C extends AnyRoster,
	const D extends DiscriminatorsOf<PC, C>,
	const Arms extends Partial<{ readonly [H in HandleOf<C>]: KeyRef<AnyRelation> | AnyDerived }>
>(
	parent: PK & (ShowingKeyed<PN, PC, PF> | KeyShows<PN, PC, PF>),
	discriminator: D,
	roster: C,
	arms: Arms &
		ArmsCompatible<SideHosts<PC, PF>, Arms> &
		ArmsOfRoster<C, Arms> &
		ArmsApartFromParent<PN, Arms> &
		AtLeastOneArm<Arms>
): Alternatives<PK, D, C, Arms> =>
	alternativesBuilder<PK, D, C, Arms>(parent, discriminator, roster, arms)

/**
 * fin(O, n): the slots of O's count n: over an ordinary O, its drawn count, a family's second argument; over a closed O,
 * its natural field, which a closed relation's slot field reads (slot). Never a side, never a schema member.
 */
export const fin = <
	O extends AnyRelation | AnyClosedRelation,
	ON extends string,
	OC,
	K,
	const N extends CountFieldIn<K, OC>
>(
	owner: O & ShowingKind<ON, OC, K>,
	count: N
): Fin<O, N> => finBuilder<O, N>(owner, count)

/**
 * ordered(on(F, g…, i), fin(O, n)): each owner's members, its group g… paired with O's primary key, indexed by their
 * drawn index i exactly 0 … n − 1, in order.
 */
export const ordered = <
	F extends Side<AnyRelation | Selection<AnyRelation>>,
	Fi,
	N extends string,
	C,
	ON extends string,
	OC,
	OK extends ReadonlyArray<string>,
	Kind
>(
	family: F & SideShows<N, C> & WholeMember & OverSlots<Kind, OrderedMember<C, F["terms"], OC, OK>>,
	slots: Fi & FinShows<ON, OC, OK, Kind> & FamilySlots<Kind>
): Ordered<F, Fi> => orderedBuilder<F, Fi>(family, slots)

/** counted(on(F, g…), fin(O, n)): each owner's n members, their index hidden. */
export const counted = <
	F extends Side<AnyRelation | Selection<AnyRelation>>,
	Fi,
	N extends string,
	C,
	ON extends string,
	OC,
	OK extends ReadonlyArray<string>,
	Kind
>(
	family: F & SideShows<N, C> & WholeMember & OverSlots<Kind, CountedMember<C, F["terms"], OC, OK>>,
	slots: Fi & FinShows<ON, OC, OK, Kind> & FamilySlots<Kind>
): Counted<F, Fi> => countedBuilder<F, Fi>(family, slots)

/**
 * tree(on(T, "parent", "at"), fin(T, "children"), { root: r }): the ordered family of T over itself, every row but its
 * self-parented root a member, with T's drawn `start` and `end` its pre-order interval and r the caller's field each
 * tree's rows share.
 */
export const tree = <
	F extends Side<AnyRelation | Selection<AnyRelation>>,
	Fi extends AnyFin,
	const Root extends string,
	N extends string,
	C,
	K
>(
	family: F &
		SideShowsKeyed<N, C, K> &
		WholeMember &
		(
			| Side<Fi["owner"]>
			| Side<Selection<unknown>>
			| Refusal<"a tree is a family of T over itself, on(T, parent, at), with drawn start and end">
		) &
		SelfFamily<C, K, F["terms"], Fi["count"]>,
	slots: Fi,
	root: { readonly root: Root & TreeRootOf<C, Root> }
): Tree<F, Fi, Root> => treeBuilder<F, Fi, Root>(family, slots, root)

/**
 * fold(family, Monoid.m, step, end): the family's members' step values combined by the monoid in slot order, each
 * owner's result in its end fields. `step` is on(member | select(member, φ), g…, x, …accumulators): the group, the
 * value (none for count), then none or one accumulated (before, after) pair per plane; `end` is on(owner, k…, …ends),
 * one accumulated field per plane. The step is read per member row, each member once by its key in the family, never as
 * the set of its projected tuples: two members of one step value both step, so a sum counts the value twice.
 */
export const fold = <
	Fa extends AnyFamily,
	M extends AnyMonoid,
	S extends Side<AnyRelation | Selection<AnyRelation>>,
	E extends Side<AnyRelation>,
	SN extends string,
	SC,
	EN extends string,
	EC,
	EK
>(
	family: Fa,
	monoid: M,
	step: S &
		SideShows<SN, SC> &
		(
			| Side<MemberRelationOf<Fa> | Selection<MemberRelationOf<Fa>>>
			| Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">
		) &
		FoldStep<Fa, M, SC, S["terms"]>,
	end: E &
		SideShowsKeyed<EN, EC, EK> &
		(
			| Side<OwnerRelationOf<Fa>>
			| Refusal<"a fold's end names one accumulated field of the owner per plane">
		) &
		FoldEnd<Fa, M, EC, EK, E["terms"], SC, S["terms"]>
): Fold<Fa, M, S, E> => foldBuilder<Fa, M, S, E>(family, monoid, step, end)

/** The closed set of monoids a fold combines by: count, sum, or, twos (two planes) and max. */
export const Monoid: { readonly [M in MonoidName]: MonoidOf<M> } = monoids

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
	fields: Fields & ContextFieldBases<Fields>,
	...options: ContextOptions
): Context<Name, Fields> => contextBuilder<Name, Fields>(name, fields, ...options)

/**
 * Relations defined over the base, a schema: whole relations of the base, each under its own name, and queries over
 * it. `write` names role relations, each once, `refresh` derived whole entries. A repeat in the write list is read
 * against the options object beside its `write`, as login reads its workloads' shared names, so the call's diagnostic
 * names the refusal. An entry, or a member of either list, typed `any` is refused (MembersTyped).
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
	relations: Rs & EntriesCheck<Base, Rs> & MembersTyped<Rs>,
	...options:
		| readonly []
		| readonly [
				options: RoleOptionRecord<W, F> & DistinctWrites<W> & MembersTyped<W> & MembersTyped<F>
		  ]
): Role<Base, Name, RoleRelations<Rs>, W[number], F[number], EntryContexts<Rs>> =>
	roleBuilder<Base, Name, Rs, W, F>(base, name, relations, ...options)
