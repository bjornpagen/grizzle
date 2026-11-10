import type { Stream } from "effect"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { ConstraintName, GeneratedLawId, LawId } from "#compiler/core/ids.ts"
import type { Built, Delivering, delta, Phantom } from "#compiler/core/phantom.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import type { MonoidName, SideDesc, SlotsDesc } from "#compiler/ir/desc.ts"
import type { Patterns } from "#compiler/ir/scalar.ts"

/** One side of a law as an outcome names it: its statement's side, as its Description states it (ir/desc.ts). */
export type { SideDesc as LawSide } from "#compiler/ir/desc.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"
import type { Identical } from "#compiler/types/core/identical.ts"
import type {
	Carriers,
	DomainOf,
	Headed,
	InputTerm,
	Invariant,
	IsOneLiteral,
	IsRetyped,
	OnlyParams,
	ParamArg,
	Refusal,
	Simplify,
	SqlOfCarrier,
	Source
} from "#compiler/types/core/phantom.ts"
import type { UnwrittenField } from "#compiler/types/fields/field.ts"
import type {
	ContextsOf,
	Decoders,
	OneName,
	OrderedAt,
	ParamsOf,
	QueryAt
} from "#compiler/types/query/query.ts"
import type {
	AnyRelation,
	Fact,
	NameOf,
	ConflictsAtKey,
	KeyLawRefusal,
	SerialFieldsOf
} from "#compiler/types/schema/relation.ts"
import type {
	AnySchema,
	IsLevelOf,
	IsRelationOf,
	LevelsOf,
	RelationOf,
	RelationsOf,
	StatementsOf,
	UnderName
} from "#compiler/types/schema/schema.ts"
import type {
	AnyTerm,
	Counted,
	DrawnFieldOf,
	Fin,
	Key,
	Mutable,
	Ordered,
	Side,
	Tree
} from "#compiler/types/schema/statements.ts"
import type {
	AnyRole,
	AnyWorld,
	WorldSerialFields,
	WorldUnwrittenFields,
	WritableNameOf,
	WriteListOf
} from "#compiler/types/schema/world.ts"

/**
 * A member is an array of facts, a Stream of facts, or a query whose head is the relation's heading, or for an insert
 * the heading minus its serial fields. An array or a Stream is the query over a relation parameter the input binds.
 * Query is invariant in its head, so a query member is admitted at any head and MemberCheck compares the head by
 * assignability: a head literal such as `kind: "Manual"` is a value of its field, and a head that
 * supplies every serial field is an addition like an array that does. M is a const type
 * parameter: an array literal whose facts carry a literal-typed field (a closed relation's handle) would otherwise widen
 * that field, miss the constraint, and infer M as the constraint itself, whose query arm types the parameters `any`.
 * insert, delete and put constrain M to members of any facts, `Member<S, unknown>`, so M is always inferred as written
 * and MemberCheck alone decides which facts fit: a fact missing a field, holding one of another type or one its
 * relation lacks is refused with one Refusal, never by the constraint's elaboration, whose diagnostic varies with the
 * literal's shape.
 */
export type Member<S, F> = ReadonlyArray<F> | Stream.Stream<F> | QueryAt<LevelsOf<S>>

/**
 * Each arm of a member's facts must be one arm of F exactly: assignable to it and with no field beyond it, so an
 * insert's facts either omit every serial field or supply them all, and no fact carries a field its
 * relation lacks. An array or Stream member is an inferred type argument, so TypeScript runs no excess-property check
 * on its elements; the check is this one, as for a query member's head. A query member's head also writes each field
 * of R at the field's own type (MistypedFields), as the checker requires (check/member.ts checkMemberHeading): an exact
 * integer or exact money binds at a plain integer or money column (Meets), but is stored into one only through
 * Compute.cast. This is the one place a member's membership is decided, for insert, delete and put, an addition that
 * omits its serial fields and a world relation's entry alike.
 */
type MemberCheck<M, F, R> =
	M extends Phantom<{ readonly heading: infer H }>
		? [UnfitArms<H, F, never>] extends [never]
			? [MistypedFields<M, R>] extends [never]
				? unknown
				: Refusal<"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast">
			: Refusal<"the query's head is not a fact of the relation">
		: M extends ReadonlyArray<infer E> | Stream.Stream<infer E, unknown, unknown>
			? [UnfitArms<E, F, never>] extends [never]
				? ConflictsAtKey<M, PrimaryKeyOf<R>> extends true
					? KeyLawRefusal<NameOf<R>, PrimaryKeyOf<R>>
					: unknown
				: Refusal<"a member fact is not a fact of the relation">
			: unknown

/** A relation's primary key fields; a world relation, keyed by its definition's evidence, states none here. */
type PrimaryKeyOf<R> = R extends { readonly primaryKey: infer P extends ReadonlyArray<string> }
	? P
	: readonly []

/** The fields of R a query member's head delivers at a type other than the field's own (WritesAt). */
type MistypedFields<M, R> =
	M extends Headed<infer Hc>
		? R extends Headed<infer C>
			? {
					[K in keyof Hc & keyof C]-?: WritesAt<Hc[K], C[K]> extends true ? never : K
				}[keyof Hc & keyof C]
			: never
		: never

/**
 * Whether a head's carrier X writes the field F: a JavaScript value, which takes its field's type and stands as a
 * fact of the relation (MemberCheck), or a term of F's identity and SQL type exactly, whatever its values, facts and
 * language: the part of the checker's comparison of a member column with its field (check/member.ts
 * checkMemberHeading, ir/scalar.ts sameEnteredType) its type states. A numeric typmod, a computed numeric's bound and a
 * span's width are runtime values, which the checker compares alone.
 */
type WritesAt<X, F> =
	IsRetyped<X> extends true
		? true
		: [InputTerm<DomainOf<X>, unknown, unknown, SqlOfCarrier<X>>] extends [
					InputTerm<DomainOf<F>, unknown, unknown, SqlOfCarrier<F>>
			  ]
			? true
			: false

/**
 * The arms of a member's facts H that fit no arm of F (FitsAnArm). Facts of F itself fit, every arm being one of F's, so
 * a member typed by its relation's addition (InsertAllRowsOf) is admitted without a walk, at any depth of its nesting.
 */
type UnfitArms<H, F, Seen> = Identical<H, F> extends true ? never : ArmsUnfit<H, F, Seen>

/** The arms of H that fit no arm of F, each arm judged alone. */
type ArmsUnfit<H, F, Seen> = H extends unknown
	? [FitsAnArm<H, F, Seen>] extends [never]
		? H
		: never
	: never
type FitsAnArm<Ha, F, Seen> = F extends unknown
	? [Ha] extends [F]
		? [Exclude<SuppliedKeys<Ha>, keyof F>] extends [never]
			? [NestedUnfit<Ha, F, Seen>] extends [never]
				? true
				: never
			: never
		: never
	: never

/**
 * The nested members of an arm that fit no arm of their nesting: at each key where F nests its members, an array of
 * facts (AdditionIn), each member of Ha's array is held to the nesting's arms as a member fact is (UnfitArms), so a
 * member nested at any depth supplies no field beyond its relation's own written ones, such as one its nesting supplies
 * (a tree member's root field or parent, an ordered member's group) or one grizzle draws. Assignability alone checks no
 * excess field of a nested object. An array of values, a vector's, nests no fact and is no nesting.
 *
 * A member type of any depth, `children: ReadonlyArray<Member>`, meets the pair of its member type and its nesting's
 * arms again below itself. Seen holds the pairs whose check is in progress above: a pair met again is checked once,
 * where it was first met, so each pair a member type reaches is checked and the walk ends.
 */
type NestedUnfit<Ha, F, Seen> = {
	[K in keyof Ha & keyof F]-?: F[K] extends ReadonlyArray<infer Fe extends object>
		? Ha[K] extends ReadonlyArray<infer He>
			? Visited<readonly [He, Fe], Seen> extends true
				? never
				: UnfitArms<He, Fe, Seen | readonly [He, Fe]>
			: never
		: never
}[keyof Ha & keyof F]

/**
 * Whether a walk over a recursive type has met X already: X is one of the types in Seen, identical to it, not only
 * assignable to it, so a type with a field more is never taken for one met before.
 */
type Visited<X, Seen> = true extends (Seen extends unknown ? Identical<X, Seen> : never)
	? true
	: false

/**
 * The fields an arm supplies. An array literal of differently shaped objects is inferred as a union whose arms carry
 * each other's fields as `k?: undefined`; such a key supplies nothing.
 */
type SuppliedKeys<Ha> = {
	[K in keyof Ha]-?: [Ha] extends [Record<K, Ha[K]>] ? K : [Ha[K]] extends [undefined] ? never : K
}[keyof Ha]

/**
 * The relations a ChangeSet over S writes: its ordinary relations, and over a role the world relations its write list
 * names. Neither closed nor derived relations.
 */
export type WritableOf<S> =
	| Extract<RelationOf<S>, AnyRelation>
	| Extract<Extract<RelationOf<S>, AnyWorld>, { readonly name: WriteListOf<S> }>

/**
 * The same test for one relation, as membership in S's relations (IsRelationOf): members name an ordinary relation of
 * S, or a world relation S's write list names.
 */
type WritableCheck<S, R> =
	IsRelationOf<S, R> extends true
		? R extends AnyWorld
			? NameOf<R> extends WriteListOf<S>
				? unknown
				: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">
			: unknown
		: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">

/**
 * The fields of R its caller never writes: each field whose declaration says how it is written instead (types/fields
 * UnwrittenField), and over a world relation the head fields its definition takes from such a field of the base
 * (WorldUnwrittenFields). A fact keeps them: they are read as every field is.
 */
export type UnwrittenFieldsOf<R> =
	| (R extends { readonly fields: infer Fields }
			? {
					[K in keyof Fields]-?: Fields[K] extends UnwrittenField ? K : never
				}[keyof Fields]
			: never)
	| WorldUnwrittenFields<R>

/** A fact of R as its caller writes it: every field but those it never writes (UnwrittenFieldsOf). */
export type Written<R> = Omit<Fact<R>, UnwrittenFieldsOf<R>>

/**
 * An Addition omits every field its caller does not write (UnwrittenFieldsOf), and either all of its relation's serial
 * fields or none, and no other field: a world relation's serial fields are the head fields its definition takes from a
 * serial field of the base (WorldSerialFields).
 */
export type Addition<R> =
	| Written<R>
	| Omit<Fact<R>, UnwrittenFieldsOf<R> | SerialFieldsOf<R> | WorldSerialFields<R>>

/** Omit over each arm of a union, so an addition's two arms keep their own fields. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * S's sequences, its ordered families and trees, which a nesting reads: the families whose order is the caller's data.
 * A counted family is a law over rows whose group key names their owner, so no write nests it.
 */
type SequenceOf<S> = Extract<StatementsOf<S>[number], Ordered<unknown, unknown> | AnyTree>

/** Any tree: Tree is covariant in what it names. */
type AnyTree = Tree<unknown, unknown, string>

/**
 * S's sequences by owner, each under the name of the relation its slots count over and none under any other name:
 * built once per schema, in one pass over its sequences, so an owner's addition reads its own few sequences by name,
 * which it then maps by their count fields.
 */
type SequenceIndexOf<S> = {
	readonly [Fa in SequenceOf<S> as OwnerNameOf<Fa>]: Fa
} & { readonly [owner: string]: never }

/** The name of the relation a sequence's slots count over: its owner's. */
type OwnerNameOf<Fa> = Fa extends { readonly slots: Fin<infer O, string> } ? NameOf<O> : never

/** The sequences of S whose owner is R. */
type SequencesOwnedBy<S, R> = SequenceIndexOf<S>[NameOf<R>]

/** A family's member relation. */
type MemberRelationOf<Fa> = Fa extends { readonly family: Side<infer F> } ? F : never

/** What a member's nesting supplies: an ordered member's group, a tree member's parent and root field. */
type NestedOf<Fa> =
	Fa extends Ordered<
		Side<unknown, readonly [...infer G extends ReadonlyArray<string>, AnyTerm]>,
		unknown
	>
		? G[number]
		: Fa extends Tree<
					Side<unknown, readonly [infer P extends string, AnyTerm]>,
					unknown,
					infer Root
			  >
			? P | Root
			: never

/**
 * The parent field of R where R is a tree's: grizzle sets it, the root's to itself and a member's by its nesting. A
 * tree is a family of its relation over itself, so R's tree is among the sequences R owns.
 */
type TreeParentOf<S, R> = TreeParent<SequencesOwnedBy<S, R>>

/** A tree's parent field; of no tree, none. Distributive, so a relation that is no tree's omits nothing. */
type TreeParent<T> =
	T extends Tree<Side<unknown, readonly [infer P extends string, AnyTerm]>, unknown, string>
		? P
		: never

/**
 * R's addition in S: the row its caller writes (Addition<R>), and at each count field of a sequence R owns, an ordered
 * family's or a tree's, its members nested in slot order, each the member relation's addition in S less what the
 * nesting supplies. Order is the caller's data only in a sequence, so only a sequence nests: a counted family's owner
 * and its members are their rows, a member's group key naming its owner. A tree's parent is no caller's field. A
 * relation with no drawn field owns no family and is no tree, so its addition is Addition<R>, read off R alone: a
 * schema whose statements are generic still types it.
 */
export type AdditionIn<S, R> = [DrawnFieldOf<R>] extends [never]
	? Addition<R>
	: OmitEach<Addition<R>, TreeParentOf<S, R>> & {
			readonly [Fa in SequencesOwnedBy<S, R> as CountOf<Fa>]: ReadonlyArray<
				OmitEach<AdditionIn<S, MemberRelationOf<Fa>>, NestedOf<Fa>>
			>
		}

/** A sequence's count field, which its owner's addition nests its members at. */
type CountOf<Fa> = Fa extends { readonly slots: Fin<unknown, infer N extends string> } ? N : never

/**
 * The relations an addition of R in S writes besides R: the member relations of R's sequences, through every nesting.
 * Seen holds the relations walked, so the walk stops at a tree, a family of its relation over itself, as NestedUnfit's
 * stops at a member type met again.
 */
export type NestedWrites<S, R, Seen = never> =
	Visited<R, Seen> extends true
		? never
		: [DrawnFieldOf<R>] extends [never]
			? never
			: MemberRelationOf<SequencesOwnedBy<S, R>> extends infer M
				? M extends unknown
					? NameOf<M> | NestedWrites<S, M, Seen | R>
					: never
				: never

/**
 * An ordered family's member relation is written under its owner, nested in order at the owner's count field: order
 * comes only through the nesting, so a direct insert would leave its members' order unsaid. A tree's relation is its
 * own owner, and a counted family's member is a row its group key places, inserted directly. An ordered member has its
 * drawn index, so the refusal is read only where R has a drawn field, and a relation with none is admitted whatever
 * S's statements are, a generic list's included.
 */
type NotSequenceMember<S, R> = [DrawnFieldOf<R>] extends [never]
	? unknown
	: NameOf<R> extends OrderedMemberName<S>
		? Refusal<"a sequence's member is written under its owner: nest it in order at the owner's count field">
		: unknown

/** The names of the member relations of S's ordered families. */
type OrderedMemberName<S> = NameOf<
	MemberRelationOf<Extract<SequenceOf<S>, Ordered<unknown, unknown>>>
>

/**
 * The relation an insertAll key names: the one S's record holds under that name, one literal, among the relations a
 * ChangeSet writes; none for a key that names no ordinary or world relation of S.
 */
type InsertedRelation<S, K> =
	IsOneLiteral<K> extends true
		? Extract<UnderName<RelationsOf<S>, K>, AnyRelation | AnyWorld>
		: never

/**
 * The names of the relations a ChangeSet over S inserts at its top level (insertableNamesOf): each relation S writes
 * whole (WritableNameOf) that insert takes alone, which is every one but an ordered family's member, written nested
 * under its owner (NotSequenceMember). A counted family's member is a row its group key places, and a tree's relation
 * is its own owner, so both are among them. One conditional per relation, so a schema of n relations costs n.
 */
export type InsertableNameOf<S extends AnySchema> = {
	[K in WritableNameOf<S>]-?: unknown extends NotSequenceMember<S, InsertedRelation<S, K>>
		? K
		: never
}[WritableNameOf<S>]

/**
 * The record insertAll takes over S's every top-level relation (InsertableNameOf): under each one's name its rows, an
 * array of its additions in S (AdditionIn), each with its sequences' members nested in order at its count fields, as
 * insert takes them. A caller types the rows it inserts at once by it.
 */
export type InsertAllRowsOf<S extends AnySchema> = {
	readonly [K in InsertableNameOf<S>]: ReadonlyArray<AdditionIn<S, InsertedRelation<S, K>>>
}

/** What insert requires of the relation it writes, as one type: unknown where it writes R. */
type InsertChecks<S, R, Done extends Strata, Last extends Stratum> = WritableCheck<S, R> &
	NotSequenceMember<S, R> &
	EditsOnce<Done, EditsWith<Last, S, R>>

/**
 * What insertAll requires of its members at key K: a required key, since a key that may be missing inserts nothing its
 * type states; a key naming a relation the ChangeSet writes; then what insert requires of that relation, and of its
 * members, its facts (MemberCheck), each refused at the key.
 */
type InsertAt<
	S,
	Rows,
	K extends keyof Rows,
	Done extends Strata,
	Last extends Stratum
> = Rows extends { readonly [P in K]-?: unknown }
	? InsertOf<S, InsertedRelation<S, K>, Rows[K], Done, Last>
	: Refusal<"insertAll names each relation by a required key: an optional key may insert nothing">

/** InsertAt of a required key, once its relation is read. */
type InsertOf<S, R, M, Done extends Strata, Last extends Stratum> = [R] extends [never]
	? Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">
	: InsertChecks<S, R, Done, Last> extends infer C
		? unknown extends C
			? MemberCheck<M, AdditionIn<S, R>, R>
			: C
		: never

/** The relations insertAll's members write: each key's relation and the members its insert nests (NestedWrites). */
type InsertedWrites<S, Rows> = {
	[K in keyof Rows]-?: NameOf<InsertedRelation<S, K>> | NestedWrites<S, InsertedRelation<S, K>>
}[keyof Rows]

/** The immutable owners whose families insertAll's members append to (FixedOwnerOf). */
type InsertedNeeds<S, Rows> = {
	[K in keyof Rows]-?: FixedOwnerOf<S, InsertedRelation<S, K>>
}[keyof Rows]

/** Whether the last stratum edits a family's members once insertAll's members are added to it (EditsWith). */
type InsertedEdits<Last extends Stratum, S, Rows> = boolean extends Last["edits"]
	? boolean
	: Last["edits"] extends true
		? true
		: true extends { [K in keyof Rows]-?: IsFamilyMember<S, InsertedRelation<S, K>> }[keyof Rows]
			? true
			: false

/**
 * insertAll's array members by relation, one for each key whose members are an array: that key's relation, with the
 * additions insert takes for it, in the stratum after the strata Done.
 */
type InsertedFacts<S, Rows, Done extends Strata> = {
	readonly [
		K in keyof Rows as [Rows[K]] extends [ReadonlyArray<unknown>]
			? NameOf<InsertedRelation<S, K>>
			: never
	]-?: ArrayFacts<InsertedRelation<S, K>, AdditionIn<S, InsertedRelation<S, K>>, PositionOf<Done>>
}

/** insertAll's array members (ArraysAdded), inserts all: none where no key's members are an array. */
type InsertedArrays<S, Rows, Done extends Strata> =
	InsertedFacts<S, Rows, Done> extends infer I
		? [keyof I] extends [never]
			? unknown
			: { readonly insert: I }
		: never

/**
 * The parameters insertAll's members need together: each member's map (ParamsOf), joined as successive inserts join
 * them, and unknown where none names one.
 */
type InsertedParams<Rows> = {
	[K in keyof Rows]-?: (params: ParamsOf<Rows[K]>) => void
}[keyof Rows] extends (params: infer P) => void
	? P
	: unknown

/**
 * A put or a delete of R in S that the engine cannot plan, in the order its front end refuses one (write/frontend/
 * compile.ts): a tree's row, since a tree is rewritten whole; a row whose key a field grizzle writes holds, since no
 * fact states it; then a delete of a member of an immutable owner's family, fixed when its owner was inserted, or a put
 * of an immutable family owner, whose put updates its row in place. A relation with no drawn field is no tree and owns
 * no family, and one whose caller writes every field states every key, so each test is read only where it can hold:
 * a schema whose statements are generic refuses nothing, and neither does a relation of no one name or no ordinary
 * relation, which WritableCheck refuses.
 */
type EditCheck<S, R, Op extends "put" | "delete"> = [R] extends [AnyRelation]
	? string extends NameOf<R>
		? unknown
		: EditOf<S, R, Op>
	: unknown

/** EditCheck of an ordinary relation of one name. */
type EditOf<S, R, Op extends "put" | "delete"> =
	IsTreeRow<S, R> extends true
		? Refusal<"a tree is rewritten whole: insert its root with the whole tree nested">
		: UnstatedKey<S, R, Op> extends true
			? Refusal<"a put or a delete names its rows by their key, and no fact states a key field grizzle writes: key the relation by fields its caller writes">
			: Op extends "delete"
				? IsFixedMember<S, R> extends true
					? Refusal<"an immutable owner's family is fixed when its owner is inserted: declare the owner mutable to change it">
					: unknown
				: IsImmutableOwner<S, R> extends true
					? Refusal<"an owner's put updates its row in place, which an immutable owner refuses: declare it mutable to put it">
					: unknown

/** Whether R is a tree's relation in S. */
type IsTreeRow<S, R> = [DrawnFieldOf<R>] extends [never]
	? false
	: [Extract<NameOf<R>, NameOf<MemberRelationOf<Extract<SequenceOf<S>, AnyTree>>>>] extends [never]
		? false
		: true

/**
 * The fields of R grizzle writes itself, which no fact determines: each drawn or accumulated field. A generated field is
 * PostgreSQL's, a function of the fields its fact states, which the statement that writes the fact computes as
 * PostgreSQL stores it.
 */
type GrizzleWrittenFieldsOf<R> = R extends { readonly fields: infer Fields }
	? {
			[K in keyof Fields]-?: Fields[K] extends { readonly writing: "drawn" | "accumulated" }
				? K
				: never
		}[keyof Fields]
	: never

/**
 * Whether a key of R that `op` names its rows by holds a field grizzle writes (GrizzleWrittenFieldsOf): a delete's
 * primary key, and a put's every declared key, which it compares its facts at.
 */
type UnstatedKey<S, R, Op extends "put" | "delete"> = [GrizzleWrittenFieldsOf<R>] extends [never]
	? false
	: [
				Extract<
					PrimaryKeyOf<R>[number] | (Op extends "put" ? CandidateKeyFieldOf<S, R> : never),
					GrizzleWrittenFieldsOf<R>
				>
		  ] extends [never]
		? false
		: true

/** The fields of R's candidate keys in S: each key statement over R whole. */
type CandidateKeyFieldOf<S, R> =
	Extract<StatementsOf<S>[number], Key<Side<R, ReadonlyArray<string>>>> extends infer K
		? K extends Key<Side<unknown, infer T extends ReadonlyArray<string>>>
			? T[number]
			: never
		: never

/** The names of the relations S declares mutable. */
type MutableName<S> =
	Extract<StatementsOf<S>[number], Mutable<unknown>> extends infer M
		? M extends Mutable<infer X>
			? NameOf<X>
			: never
		: never

/** S's families whose members are rows of their own: its ordered and counted families. */
type RowFamilyOf<S> = Extract<
	StatementsOf<S>[number],
	Ordered<unknown, unknown> | Counted<unknown, unknown>
>

/** Whether R is the member of an ordered or a counted family of S whose owner is immutable. */
type IsFixedMember<S, R> = [FixedOwnerOf<S, R>] extends [never] ? false : true

/** Whether R owns an ordered or a counted family of S and is immutable. */
type IsImmutableOwner<S, R> = [DrawnFieldOf<R>] extends [never]
	? false
	: [Extract<NameOf<R>, Exclude<OwnerNameOf<RowFamilyOf<S>>, MutableName<S>>>] extends [never]
		? false
		: true

/**
 * Params is carried invariantly as well as read through `params`, so a ChangeSet that still needs parameters is never
 * a bound one.
 * Any ChangeSet, and any ChangeSet over S: the members every runtime ChangeSet has. ChangeSet is invariant in its
 * schema and parameters, so no instance of it is universal.
 */
export interface AnyChangeSet extends Built {
	readonly reads: RowDecoder<unknown>
	bind(params: never): AnyChangeSet
}

interface ChangeSetOver<in out S>
	extends AnyChangeSet, Phantom<{ readonly schema: Invariant<S> }> {}
/** A ChangeSet over one of the levels L. */
export type ChangeSetAt<L> = L extends unknown ? ChangeSetOver<L> : never

/**
 * ChangeSets, deltas, outcomes and witnesses. packages/engine/src/write/changeset implements the sealed ChangeSet value, and
 * it is bound here.
 *
 * A ChangeSet carries S invariantly, like Query; db.apply accepts a ChangeSet over any level of the database's role.
 * Writes is the union of the relation names its members write; db.apply checks it against the role's write list. Over
 * a role a ChangeSet writes the world relations the role's write list names, besides ordinary relations. Cx is the union
 * of the contexts its members and read-backs match, which db.apply checks against the role's (WithinRoleContexts).
 * Done is its strata before the last and Last the stratum insert, delete and put write to (Stratum). Arrays is its array
 * members by op, then relation name (ArrayFacts), the facts a served workload's member takes with each call
 * (FactsCheck).
 *
 * What an applied ChangeSet's outcome reads back is a real member: `reads`, the decoder of the record of its
 * read-backs, each under its name the rows its query's immediate decoder delivers (schema/record.ts record of named
 * attachments). read adds one, and union and sequence merge their arguments' (core/decoder.ts merge), so Reads is the
 * type of the records that decoder assembles (ReadsOf).
 */
export interface ChangeSet<
	S,
	Params = unknown,
	Writes extends string = never,
	Reads = unknown,
	Cx = never,
	Done extends Strata = Strata,
	Last extends Stratum = Stratum,
	Arrays = unknown
>
	extends
		Delivering<Reads>,
		Phantom<{
			readonly params: Params
			readonly paramsInvariant: Invariant<Params>
			readonly writes: Writes
			readonly contexts: Cx
			readonly schema: Invariant<S>
			readonly strata: readonly [...Done, Last]
			readonly arrays: Arrays
		}> {
	/** The decoder of the outcome's read-backs, by name. */
	readonly reads: RowDecoder<Reads>
	/**
	 * Adds each member fact, with its sequences' members nested in order at its count fields (AdditionIn): every nested
	 * member relation is written too. A counted family's member is a row of its own relation, inserted directly, its
	 * group key naming its owner; grizzle draws every count, index, interval, copy and accumulator.
	 */
	insert<R extends AnyRelation | AnyWorld, const M extends Member<S, unknown>>(
		relation: R &
			WritableCheck<S, R> &
			NotSequenceMember<S, R> &
			EditsOnce<Done, EditsWith<Last, S, R>>,
		facts: M & MemberCheck<M, AdditionIn<S, R>, R>
	): ChangeSet<
		S,
		JointParams<Params, ParamsOf<M>>,
		Writes | NameOf<R> | NestedWrites<S, R>,
		Reads,
		Cx | ContextsOf<M>,
		Done,
		Stratum<
			Last["inserts"] | NameOf<R> | NestedWrites<S, R>,
			Last["needs"] | FixedOwnerOf<S, R>,
			EditsWith<Last, S, R>
		>,
		Arrays & ArraysAdded<"insert", R, M, AdditionIn<S, R>, Done>
	>
	/**
	 * Adds the members of each relation the record names by its key, as one insert of each would: the members at each
	 * key are what insert takes for that relation, checked as insert checks them and refused at their key. Inserts within
	 * one stratum are one set, so the record's order is no part of the ChangeSet.
	 */
	insertAll<const Rows extends { readonly [K in keyof Rows]: Member<S, unknown> }>(
		rows: Rows & { readonly [K in keyof Rows]: InsertAt<S, Rows, K, Done, Last> }
	): ChangeSet<
		S,
		JointParams<Params, InsertedParams<Rows>>,
		Writes | InsertedWrites<S, Rows>,
		Reads,
		Cx | ContextsOf<Rows[keyof Rows]>,
		Done,
		Stratum<
			Last["inserts"] | InsertedWrites<S, Rows>,
			Last["needs"] | InsertedNeeds<S, Rows>,
			InsertedEdits<Last, S, Rows>
		>,
		Arrays & InsertedArrays<S, Rows, Done>
	>
	/**
	 * Removes each member fact, stated as its caller writes it (Written<R>): the fields PostgreSQL and grizzle write are
	 * no part of a fact's identity a caller states, so an insert and a delete of one fact state one row. A tree's row, a
	 * row whose primary key holds a field grizzle writes, and a member of an immutable owner's family are no delete's
	 * (EditCheck).
	 */
	delete<R extends AnyRelation | AnyWorld, const M extends Member<S, unknown>>(
		relation: R &
			WritableCheck<S, R> &
			EditCheck<S, R, "delete"> &
			EditsOnce<Done, EditsWith<Last, S, R>>,
		facts: M & MemberCheck<M, Written<R>, R>
	): ChangeSet<
		S,
		JointParams<Params, ParamsOf<M>>,
		Writes | NameOf<R>,
		Reads,
		Cx | ContextsOf<M>,
		Done,
		Stratum<Last["inserts"], Last["needs"], EditsWith<Last, S, R>>,
		Arrays & ArraysAdded<"delete", R, M, Written<R>, Done>
	>
	/**
	 * After the change, R's fact at each member's key is that member, with the fields its caller does not write as
	 * PostgreSQL and grizzle write them. For every relation it is the row its caller writes (Written<R>): an owner's put
	 * leaves its families as they are, and a member's put is an edit of its family, in place, a refill from its slot or
	 * a move between groups, which grizzle plans. A tree's row, a row a declared key of which holds a field grizzle
	 * writes, and an immutable family owner are no put's (EditCheck).
	 */
	put<R extends AnyRelation | AnyWorld, const M extends Member<S, unknown>>(
		relation: R &
			WritableCheck<S, R> &
			EditCheck<S, R, "put"> &
			EditsOnce<Done, EditsWith<Last, S, R>>,
		facts: M & MemberCheck<M, Written<R>, R>
	): ChangeSet<
		S,
		JointParams<Params, ParamsOf<M>>,
		Writes | NameOf<R>,
		Reads,
		Cx | ContextsOf<M>,
		Done,
		Stratum<Last["inserts"], Last["needs"], EditsWith<Last, S, R>>,
		Arrays & ArraysAdded<"put", R, M, Written<R>, Done>
	>
	/**
	 * A query over the post-change state and the change's own delta, delivered in the outcome under `name`. It runs
	 * before COMMIT, so its rows are typed by immediate-constraint evidence only: they are the records its immediate
	 * decoder assembles.
	 */
	read<const Name extends string, Q extends QueryAt<LevelsOf<S>> | OrderedAt<LevelsOf<S>>, IHead>(
		name: ReadName<Name, Reads>,
		readBack: (delta: Delta<S>) => Q & Decoders<unknown, IHead>
	): ChangeSet<
		S,
		JointParams<Params, ParamsOf<Q>>,
		Writes,
		Simplify<Reads & { readonly [K in Name]: ReadonlyArray<IHead> }>,
		Cx | ContextsOf<Q>,
		Done,
		Last,
		Arrays
	>
	bind<const Arg>(
		params: ParamArg<Params> & Arg & OnlyParams<Arg, Params>
	): ChangeSet<S, unknown, Writes, Reads, Cx, Done, Last, Arrays>
}

/**
 * The parameters two parts of a program need together: one map of them, and unknown where neither names one, as an
 * empty ChangeSet's and a bound one's are, so every ChangeSet that needs none has one parameter type and a choice of
 * two of them is one program.
 */
type JointParams<A, B> = [keyof (A & B)] extends [never] ? unknown : Simplify<A & B>

/** The op a ChangeSet's array member is added by, which a call's facts key it under first: insertAll's are inserts. */
type ArrayOp = "insert" | "put" | "delete"

/**
 * An array member of a ChangeSet: the relation R it writes, the type of each of its facts, Row, the facts insert,
 * delete or put takes for R (AdditionIn for an insert, its sequences' members nested at its count fields, and Written
 * for a delete or a put), and its stratum's position, At, one element for each stratum before it. A served workload's
 * member takes an array member's facts with each call, in place of the array the ChangeSet was built with.
 */
interface ArrayFacts<R, Row, At extends ReadonlyArray<unknown>> {
	readonly relation: R
	readonly row: Row
	readonly at: At
}

/** A stratum's position: one element for each of the strata before it. */
type PositionOf<Before extends ReadonlyArray<unknown>> = { readonly [K in keyof Before]: unknown }

/**
 * The array members member M of R adds by Op, under Op and then R's name, in the stratum after the strata Done: one
 * where M is an array, none for a Stream or a query member, whose facts no call supplies. A ChangeSet's Arrays is the
 * intersection of every member's, and the array members of one op and one relation in one stratum are one member, their
 * facts one array, as the value holds them (write/changeset/value.ts); two in two strata meet with no position
 * (RepeatedArrays), which a workload refuses (types/db/workload.ts), as the engine refuses them in a served workload
 * (UnservedMember).
 */
type ArraysAdded<Op extends ArrayOp, R, M, Row, Done extends Strata> = [M] extends [
	ReadonlyArray<unknown>
]
	? { readonly [O in Op]: { readonly [N in NameOf<R>]: ArrayFacts<R, Row, PositionOf<Done>> } }
	: unknown

/** sequence's array members of b: each a stratum later by every stratum of a, `Before`. */
type Shifted<A, Before extends ReadonlyArray<unknown>> = [keyof A] extends [never]
	? unknown
	: {
			readonly [Op in keyof A]: {
				readonly [N in keyof A[Op]]: A[Op][N] extends ArrayFacts<
					infer R,
					infer Row,
					infer At extends ReadonlyArray<unknown>
				>
					? ArrayFacts<R, Row, readonly [...PositionOf<Before>, ...At]>
					: never
			}
		}

/** The length of an array member's position: never where two strata's members of one op and relation met. */
type PositionLength<F> = F extends { readonly at: infer P extends ReadonlyArray<unknown> }
	? P["length"]
	: never

/**
 * The relations a ChangeSet's array members A hold by one op in two strata, which a call's facts key alike: sequence
 * puts b's strata after a's and union aligns its arguments' by position, so two members of one op and relation meet in
 * one entry of A, their positions intersected; at one position they are one member, as one stratum's are, and at two
 * the position is none.
 */
export type RepeatedArrays<A> = {
	readonly [Op in keyof A]: {
		readonly [N in keyof A[Op]]: [PositionLength<A[Op][N]>] extends [never] ? N : never
	}[keyof A[Op]]
}[keyof A]

/** A ChangeSet's array members by op, then relation name (ArrayFacts), unknown for a program that holds none. */
export type ArraysOf<X> = X extends Phantom<{ readonly arrays: infer A }> ? A : unknown

/**
 * One op's facts in F checked against the array members A of that op: each relation's checked as the member A holds
 * for it checks its own (MemberCheck), exactly an arm of its row type each, no field beyond it, and no two literal facts
 * at one primary key; a member's relation F leaves out required at its row type; and a key naming no array member's
 * relation of the op refused.
 */
type OpFactsCheck<F, A> = {
	readonly [N in keyof A | keyof F]: N extends keyof A
		? A[N] extends { readonly relation: infer R; readonly row: infer Row }
			? N extends keyof F
				? MemberCheck<F[N], Row, R>
				: ReadonlyArray<Row>
			: never
		: Refusal<"a served ChangeSet's facts name, under each op, only the relations of its array members of that op">
}

/**
 * What a served member's facts F must be for the array members A: under each op of A, an array under each relation of
 * that op's members, checked as insert, delete and put check their own (OpFactsCheck); an op F leaves out required; and
 * a key naming no op of an array member refused, as the engine refuses one (runtime/write/members.ts memberFactsOf), so
 * a misspelt op or relation drops no rows. F is inferred from the facts alone, apart from their rows' types, as
 * insert's members are, and checked here after.
 */
export type FactsCheck<F, A> = {
	readonly [Op in keyof A | keyof F]: Op extends keyof A
		? Op extends keyof F
			? OpFactsCheck<F[Op], A[Op]>
			: OpFactsCheck<unknown, A[Op]>
		: Refusal<"a served ChangeSet's facts name only the ops of its array members: insert, put and delete">
}

/**
 * What one stratum of a ChangeSet writes, as the engine's front end plans it (write/frontend/compile.ts): the relations
 * it inserts, each with every sequence member its nesting reaches (`inserts`); the immutable owners whose families its
 * inserts append to, which an owner's family takes only from an insert of the owner in the same stratum (`needs`); and
 * whether it writes a member of an ordered or a counted family, an edit the engine plans from one read before the
 * ChangeSet's writes, so in one stratum alone (`edits`). Each is a type argument, so a builder's call states the
 * stratum it makes from the one before in constant depth, however long its chain.
 */
export interface Stratum<
	out Inserts extends string = string,
	out Needs extends string = string,
	out Edits extends boolean = boolean
> {
	readonly inserts: Inserts
	readonly needs: Needs
	readonly edits: Edits
}

/** A ChangeSet's strata before its last in order: a tuple where they are known, which every builder keeps. */
export type Strata = ReadonlyArray<Stratum>

/** The stratum an empty ChangeSet holds, and a stratum no member has written. */
export type Unwritten = Stratum<never, never, false>

/**
 * Whether a stratum edits a family's members once a write of R is added to it: a stratum not known to edit or not stays
 * not known, so a ChangeSet whose strata are not known is a supertype of every one whose strata are.
 */
type EditsWith<Last extends Stratum, S, R> = boolean extends Last["edits"]
	? boolean
	: Last["edits"] extends true
		? true
		: IsFamilyMember<S, R>

/** union's strata: its arguments' position by position, each pair one stratum. */
type Aligned<A extends Strata, B extends Strata> = A extends readonly [
	infer Ah extends Stratum,
	...infer At extends Strata
]
	? B extends readonly [infer Bh extends Stratum, ...infer Bt extends Strata]
		? readonly [
				Stratum<
					Ah["inserts"] | Bh["inserts"],
					Ah["needs"] | Bh["needs"],
					Ah["edits"] extends true ? true : Bh["edits"]
				>,
				...Aligned<At, Bt>
			]
		: A
	: B

/** The strata before the last of strata that end in one; strata not known as a tuple stay unknown. */
type Leading<St> = St extends readonly [...infer D extends Strata, Stratum] ? D : Strata
/** The last stratum of strata that end in one; strata not known as a tuple leave it unknown. */
type Final<St> = St extends readonly [...Strata, infer L extends Stratum] ? L : Stratum

/** Whether more than one of the strata edits a family's members, one walk over them. */
type EditsTwice<St, Seen extends boolean = false> = St extends readonly [
	infer H extends Stratum,
	...infer T
]
	? H["edits"] extends true
		? Seen extends true
			? true
			: EditsTwice<T, true>
		: EditsTwice<T, Seen>
	: false

/** A family's members are written in one stratum: the engine plans each stratum's edits from one read before its writes. */
type EditsRefusal<Twice> = Twice extends true
	? Refusal<"a ChangeSet writes a family's members in one stratum: each stratum's edits are planned from one read before the ChangeSet's writes">
	: unknown
type EditsInOneStratum<St> = EditsRefusal<EditsTwice<St>>
/** A last stratum that edits, after strata of which none may. */
type EditsOnce<Done extends Strata, E> = [E] extends [true]
	? EditsRefusal<DoneEdits<Done>>
	: unknown
/**
 * Whether strata known as a tuple hold one that edits a family's members, read off the union of their flags in one
 * step: strata not known as a tuple hold none known to.
 */
type DoneEdits<D extends Strata> = number extends D["length"]
	? false
	: true extends D[number]["edits"]
		? true
		: false
/** Whether some stratum of a ChangeSet is known to edit a family's members. */
type EditsIn<D extends Strata, L extends Stratum> =
	DoneEdits<D> extends true ? true : L["edits"] extends true ? true : false
/**
 * union's refusal: its arguments both edit, at positions that align into two strata. Only then are their strata walked,
 * so a union of ChangeSets of which at most one edits costs no walk.
 */
type UnionEdits<D1 extends Strata, L1 extends Stratum, D2 extends Strata, L2 extends Stratum> = [
	EditsIn<D1, L1>,
	EditsIn<D2, L2>
] extends [true, true]
	? EditsInOneStratum<Aligned<readonly [...D1, L1], readonly [...D2, L2]>>
	: unknown

/**
 * Whether each stratum inserts every immutable owner its appends need: an immutable owner's family takes an append only
 * beside the owner's insert, in one stratum. Strata not known as a tuple are judged by no stratum.
 */
type AppendsMet<St> = St extends readonly [infer H extends Stratum, ...infer T]
	? [Exclude<H["needs"], H["inserts"]>] extends [never]
		? AppendsMet<T>
		: false
	: true

/**
 * What compiling a ChangeSet requires of its strata, which db.apply, db.compile, db.explain and a workload check where
 * they compile it: every append to an immutable owner's family beside an insert of the owner in its stratum.
 */
export type AppendsBeside<St> =
	AppendsMet<St> extends true
		? unknown
		: Refusal<"an immutable owner's family takes an append only beside an insert of its owner in the same stratum: insert the owner with it, or declare it mutable">

/**
 * AppendsBeside of a program's strata, every member's where the program is a union of ChangeSets: a program that is no
 * ChangeSet requires nothing.
 */
export type PlannedStrata<X> = AppendsBeside<
	X extends Phantom<{ readonly strata: infer St }> ? St : readonly []
>

/**
 * The owners of S's ordered and counted families under the name of their member relation, a member of several families
 * once with all their owners, and none under any other name: built once per schema, in one pass over its families, so
 * a member's owners are one property read, as SequenceIndexOf reads an owner's sequences.
 */
type RowOwnerIndexOf<S> = {
	readonly [Fa in RowFamilyOf<S> as NameOf<MemberRelationOf<Fa>>]: OwnerNameOf<Fa>
} & { readonly [member: string]: never }

/**
 * The immutable owners of the ordered and counted families R is a member of in S: one read of the schema's index
 * (RowOwnerIndexOf), so insertAll's keys cost one each, however many families the schema holds.
 */
type FixedOwnerOf<S, R> =
	string extends NameOf<R> ? never : Exclude<RowOwnerIndexOf<S>[NameOf<R>], MutableName<S>>

/** Whether R is a member of an ordered or a counted family of S, whose every write the engine plans as an edit. */
type IsFamilyMember<S, R> =
	string extends NameOf<R>
		? false
		: [Extract<NameOf<R>, NameOf<MemberRelationOf<RowFamilyOf<S>>>>] extends [never]
			? false
			: true

/**
 * Deltas name an ordinary relation of S, or any world relation of S: a world relation the ChangeSet writes nothing of
 * has an empty delta, a writable one written only through itself its target's projected onto its head, and any other
 * is refused by the write front end, which reads the ChangeSet's writes.
 */
type DeltaCheck<S, R> =
	IsRelationOf<S, R> extends true
		? unknown
		: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">

export interface Delta<S> {
	/** Facts of R this application made present. */
	added<R extends (AnyRelation | AnyWorld) & Headed<Carriers>>(
		relation: R & DeltaCheck<S, R>
	): DeltaSource<R>
	/** Facts of R this application made absent. */
	removed<R extends (AnyRelation | AnyWorld) & Headed<Carriers>>(
		relation: R & DeltaCheck<S, R>
	): DeltaSource<R>
}

/**
 * A delta of R: a source of R's facts whose heading is R's own, so its variables are minted over R's fields. It names no
 * relation, so its variables carry no origin; it holds R's facts, so it is keyed by R's keys, which a fold over it reads
 * (under `delta`, a phantom no value carries and no caller spells).
 */
export interface DeltaSource<R extends Headed<Carriers>>
	extends Source<Fact<R>>, Headed<R["heading"]> {
	readonly [delta]?: Invariant<R> | undefined
}

/** The writes and the read-backs of a ChangeSet: Reads is its reads decoder's records. */
export type WritesOf<C> = C extends Phantom<{ readonly writes: infer W }> ? W : never
export type ReadsOf<C> = C extends { readonly reads: RowDecoder<infer R> } ? R : never

/**
 * A ChangeSet over a level of the other's schema combines with it, as db.apply accepts either: the result
 * is over the higher of the two schemas. Levels form one chain, so of two schemas either one is a level of the other
 * or they do not combine.
 */
type HigherLevel<A, B> = IsLevelOf<A, B> extends true ? A : IsLevelOf<B, A> extends true ? B : never
type LevelCheck<H> = [H] extends [never]
	? Refusal<"the ChangeSets' schemas are not levels of one another">
	: unknown

/**
 * Read-back names are distinct across a whole ChangeSet, its strata and unions included: a read whose name is already
 * a read-back, and a union or sequence of ChangeSets that share one, are type errors.
 */
type ReadNameCheck<Name extends string, Reads> = Name extends keyof Reads
	? Refusal<"read-back names are distinct: this ChangeSet already has a read-back of this name">
	: unknown
/** A read-back's name: one literal, the key of its rows in the outcome's record, and no read-back's name already. */
export type ReadName<Name extends string, Reads> = OneName<Name> & ReadNameCheck<Name, Reads>
type DisjointReads<A, B> = [keyof A & keyof B] extends [never]
	? unknown
	: Refusal<"read-back names are distinct: the ChangeSets share a read-back name">

export interface ChangeSetConstructor {
	empty<S extends AnySchema | AnyRole>(
		schema: S
	): ChangeSet<S, unknown, never, unknown, never, readonly [], Unwritten>
	/** The commutative combination: one add-wins transition, its strata combined position by position. */
	union<
		SA,
		SB,
		P1,
		P2,
		W1 extends string,
		W2 extends string,
		R1,
		R2,
		C1,
		C2,
		D1 extends Strata,
		D2 extends Strata,
		L1 extends Stratum,
		L2 extends Stratum,
		A1,
		A2
	>(
		a: ChangeSet<SA, P1, W1, R1, C1, D1, L1, A1>,
		b: ChangeSet<SB, P2, W2, R2, C2, D2, L2, A2> &
			LevelCheck<HigherLevel<SA, SB>> &
			DisjointReads<R1, R2> &
			UnionEdits<D1, L1, D2, L2>
	): ChangeSet<
		HigherLevel<SA, SB>,
		JointParams<P1, P2>,
		W1 | W2,
		Simplify<R1 & R2>,
		C1 | C2,
		Leading<Aligned<readonly [...D1, L1], readonly [...D2, L2]>>,
		Final<Aligned<readonly [...D1, L1], readonly [...D2, L2]>>,
		A1 & A2
	>
	/**
	 * Strata: b is evaluated against the state a produced. The result is over the higher of the two schemas, each of
	 * which is a level of it. Strata are associative, so three are sequence(sequence(a, b), c).
	 */
	sequence<
		SA,
		SB,
		P1,
		P2,
		W1 extends string,
		W2 extends string,
		R1,
		R2,
		C1,
		C2,
		D1 extends Strata,
		D2 extends Strata,
		L1 extends Stratum,
		L2 extends Stratum,
		A1,
		A2
	>(
		a: ChangeSet<SA, P1, W1, R1, C1, D1, L1, A1>,
		b: ChangeSet<SB, P2, W2, R2, C2, D2, L2, A2> &
			LevelCheck<HigherLevel<SA, SB>> &
			DisjointReads<R1, R2> &
			EditsRefusal<[EditsIn<D1, L1>, EditsIn<D2, L2>] extends [true, true] ? true : false>
	): ChangeSet<
		HigherLevel<SA, SB>,
		JointParams<P1, P2>,
		W1 | W2,
		Simplify<R1 & R2>,
		C1 | C2,
		readonly [...D1, L1, ...D2],
		L2,
		A1 & Shifted<A2, readonly [...D1, L1]>
	>
}

/** A key value a witness may carry: a vector field may be a key field. */
export type KeyHost =
	| string
	| number
	| bigint
	| boolean
	| Decimal
	| Money
	| Span<number>
	| Span<bigint>
	| Span<CalendarDate>
	| Vector

/**
 * What a law's refusal names: the violating fact's key, or why it names none.
 *
 * - `key`: one violating fact's relation and its key values, never a payload column. A write statement's refusal names
 *   the key you submitted, in the fields you wrote it in, a collision with a fact outside the written entry included.
 * - `unreported`: every law is a native constraint, and a violation PostgreSQL raised itself states its key only in
 *   its message, which the runtime neither forwards nor parses: where the host finds no row the ChangeSet states that
 *   breaks it, or cannot tell which of several did, as two family owners the write inserts without reading them, either
 *   of which may be a stored one inserted again.
 */
export type Witness =
	| {
			readonly kind: "key"
			readonly relation: string
			readonly values: Readonly<Record<string, KeyHost>>
	  }
	| { readonly kind: "unreported" }

/**
 * Which laws an `invariant-rejected` outcome names, each with its identity and the object that refused it (RefusedLaw),
 * and how grizzle decided them:
 *
 * - `every`: what grizzle decides refused the write, each rule judged broken. For a CHECK that refused a row the
 *   ChangeSet states, every rule of that row's table's CHECKs the row breaks as the write fills it, each once, in the
 *   schema's canonical order of its rules (its primary keys', then its statements' in canonical order), whichever CHECK
 *   PostgreSQL tried first; for a domain that refused a value of a row the ChangeSet states, the rule of each column of
 *   that row it types whose value it refuses, in its columns' canonical order, where the host judges every such column;
 *   for any other refusal, the one rule its PostgreSQL object discharges among those the statement can break (a
 *   domain's, of the columns it types in the tables the statement writes).
 * - `first`: a CHECK that refused a row the ChangeSet does not state, a row only PostgreSQL computes, as a query's, a
 *   stated row one of whose table's CHECKs reads a value the host does not hold, or one of several stated rows the host
 *   cannot tell apart: the rules of the CHECK PostgreSQL tried first, which it orders by the CHECKs' installed names,
 *   an order no version of grizzle keeps. The row may break others too.
 * - `some`: one PostgreSQL object that discharges every rule here refused the write, and nothing grizzle holds decides
 *   which of them the row broke: at least one, maybe more. A family's foreign key carries every containment merged into
 *   it, and a domain every rule of the columns it types in the tables the statement writes, where the host judges no
 *   stated row whole. Two rules at least: an object of one rule is `every`, so `some` never names a decided rule.
 */
export type Refused =
	| { readonly kind: "every" | "first"; readonly laws: readonly [RefusedLaw, ...Array<RefusedLaw>] }
	| {
			readonly kind: "some"
			readonly laws: readonly [RefusedLaw, RefusedLaw, ...Array<RefusedLaw>]
	  }

/**
 * A law of a schema with its identity: the law as the schema states it (`law`) and its identity (`id`), a theory law's
 * or a text pattern's the key of the snapshot's theory.laws and a generated field's the one its derived facts hold.
 * lawIdsOf lists a schema's, and a refusal names each law it breaks as one (RefusedLaw).
 */
export interface IdentifiedLaw {
	readonly law: Law
	readonly id: LawId | GeneratedLawId
}

/** One law a refusal names: the law with its identity (IdentifiedLaw), and the installed object that refused it (`by`). */
export interface RefusedLaw extends IdentifiedLaw {
	readonly by: RefusingObject
}

/**
 * The installed object that refused a law, as the snapshot's constraintToLaw names it. A refusal the host decides, a
 * same-key conflict or a NULL a generated column would hold, names the object PostgreSQL would have refused with.
 *
 * - `constraint`: a table's CHECK, key, foreign key or exclusion constraint, by its table's installed name and its
 *   own;
 * - `domain`: a domain's CHECK, by the domain's installed name and the constraint's;
 * - `statement`: a write statement or a rule over a query's trigger, which raises the law under its identity and
 *   installs no constraint for it;
 * - `notNull`: a generated column's NOT NULL, the generated law, by its table's and its column's installed names.
 */
export type RefusingObject =
	| { readonly kind: "constraint"; readonly table: string; readonly name: ConstraintName }
	| { readonly kind: "domain"; readonly domain: string; readonly name: ConstraintName }
	| { readonly kind: "statement" }
	| { readonly kind: "notNull"; readonly table: string; readonly column: string }

/**
 * A law as the schema states it, which an `invariant-rejected` outcome names: an application matches on it directly.
 *
 * - `primaryKey`: a relation's primary key, by its fields (a span field makes it a nonoverlap key);
 * - `key`: a key statement, key(side), by its side: a candidate key of the relation when the side reads every fact
 *   and its terms are fields (a span field makes it a nonoverlap key), and otherwise a key over the facts the side
 *   reads. A side (ir/desc.ts SideDesc, the public LawSide) is its relation, its terms in the order the statement pairs
 *   them, each a field or pred of a natural field, and its selection's conjuncts, each a row predicate in its
 *   canonical form (schema/own.ts canonicalPredicate), in canonical order: none reads every fact;
 * - `check`: a relation's row check, by its name;
 * - `contained`: a containment, a foreign key included, from its source side into its target side (a mirrors is two);
 * - `coverage`: a containment whose sides pair a span field, the source's span covered by the target's;
 * - `family`: an ordered or counted family, by its member side and its owner's slots: each owner's members indexed by
 *   exactly 0 … n − 1 (an alternatives law states plain containments, each a `contained` law);
 * - `tree`: a tree, by its member side, its slots and its root field: each root field's rows one tree in pre-order;
 * - `fold`: a fold, by its family's slots, its monoid and its step and end sides: each owner's ends its members'
 *   combination;
 * - `contract`: a contract's predicate, by its name;
 * - `pattern`: a stored field's text refinement (str.regex, str.and), by its relation and field, with its patterns
 *   spelled as that field declares them, one for str.regex and every joined one in order for str.and: one law per
 *   field, so two fields of one language, which share one domain, are two laws, and a refusal names the field whose
 *   value broke it. A conjunction is one law, as its domain is one CHECK testing every pattern, which PostgreSQL
 *   refuses as a whole: no refusal tells which pattern a value missed;
 * - `generated`: a generated field, by its relation and field: its term has a value at every row, which a closed read
 *   `C.at` at a key its closed relation holds no row at does not, so PostgreSQL refuses the row by the column's NOT NULL.
 * - `above`: a law of `level`, a level above the schema a Db is over, as that level states it (`law`): a Db over a lower
 *   level holds none of the code of the levels above it, so a refusal by one of their laws, a foreign key into its
 *   relations or a rule over a query reading them, names the level that states it. Every other law an outcome over a
 *   schema S names is one of `lawsOf(S)`.
 */
export type Law =
	| {
			readonly kind: "primaryKey"
			readonly relation: string
			readonly fields: ReadonlyArray<string>
	  }
	| { readonly kind: "key"; readonly side: SideDesc }
	| { readonly kind: "check"; readonly relation: string; readonly name: string }
	| { readonly kind: "contained"; readonly from: SideDesc; readonly to: SideDesc }
	| { readonly kind: "coverage"; readonly from: SideDesc; readonly to: SideDesc }
	| {
			readonly kind: "family"
			readonly order: "ordered" | "counted"
			readonly member: SideDesc
			readonly slots: SlotsDesc
	  }
	| {
			readonly kind: "tree"
			readonly member: SideDesc
			readonly slots: SlotsDesc
			readonly root: string
	  }
	| {
			readonly kind: "fold"
			readonly family: SlotsDesc
			readonly monoid: MonoidName
			readonly step: SideDesc
			readonly end: SideDesc
	  }
	| { readonly kind: "contract"; readonly contract: string }
	| {
			readonly kind: "pattern"
			readonly relation: string
			readonly field: string
			readonly patterns: Patterns
	  }
	| { readonly kind: "generated"; readonly relation: string; readonly field: string }
	| { readonly kind: "above"; readonly level: string; readonly law: Law }
