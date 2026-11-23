import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { Stream } from "effect"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { ConstraintName, GeneratedLawId, LawId } from "#compiler/core/ids.ts"
import type { Built, Delivering, delta, Phantom, phantom } from "#compiler/core/phantom.ts"
import type { closedChangeRefusals, Refused } from "#compiler/core/refusals.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import type { MonoidName, SideDesc, SlotsDesc } from "#compiler/ir/desc.ts"

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
	LanguageOf,
	ArgumentOf,
	NoParamsArg,
	OnlyParams,
	ParamOrigin,
	ParamValue,
	ParamsContribution,
	ParamsOfTerm,
	PhantomOf,
	Refusal,
	Simplify,
	SqlOfCarrier,
	Source,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"
import type {
	InstantDomain,
	InstantField,
	LiteralOf,
	UnwrittenField
} from "#compiler/types/fields/field.ts"
import type {
	BindContexts,
	BoundOver,
	ContextsOf,
	Decoders,
	OneName,
	OrderedAt,
	ParamsOf,
	QueryAt,
	QueryRows
} from "#compiler/types/query/query.ts"
import type { HeadValue } from "#compiler/types/query/terms.ts"
import type {
	AnyRelation,
	Fact,
	NameOf,
	ConflictsAtKey,
	KeyLawRefusal
} from "#compiler/types/schema/relation.ts"
import type {
	AllFragmentsOf,
	AnyFragment,
	AnySchema,
	BelowOf,
	HigherLevel,
	IsLevelOf,
	IsRelationOf,
	LevelsOf,
	NameIn,
	RelationIn,
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
	KeyHeadsOf,
	Mutable,
	OrderedFamily,
	Side,
	Tree
} from "#compiler/types/schema/statements.ts"
import type {
	AnyRole,
	AnyWorld,
	RoleLeastOf,
	RoleLeastStated,
	WorldUnwrittenFields,
	WritableNameOf,
	WriteListOf
} from "#compiler/types/schema/world.ts"

/**
 * A member is an array of facts, a Stream of facts, or a query whose head is the relation's heading, or for an insert
 * the fields its caller writes. An array or a Stream is the query over a relation parameter the input binds.
 * Query is invariant in its head, so a query member is admitted at any head and MemberCheck compares the head by
 * assignability: a head literal such as `kind: "Manual"` is a value of its field. M is a const type
 * parameter: an array literal whose facts carry a literal-typed field (a closed relation's handle) would otherwise widen
 * that field, miss the constraint, and infer M as the constraint itself, whose query arm types the parameters `any`.
 * insert, delete and put constrain M to members of any facts, `Member<S, unknown>`, so M is always inferred as written
 * and MemberCheck alone decides which facts fit: a fact missing a field, holding one of another type or one its
 * relation lacks is refused with one Refusal, never by the constraint's elaboration, whose diagnostic varies with the
 * literal's shape.
 */
export type Member<S, F> = ReadonlyArray<F> | Stream.Stream<F> | QueryAt<LevelsOf<S>>

/**
 * Each arm of a member's facts must be one arm of F exactly: assignable to it and with no field beyond it, so no fact
 * carries a field its relation lacks. An array or Stream member is an inferred type argument, so TypeScript runs no excess-property check
 * on its elements; the check is this one, as for a query member's head. A query member's head also writes each field
 * of R at the field's own type (MistypedFields), as the checker requires (check/member.ts checkMemberHeading): an exact
 * integer or exact money binds at a plain integer or money column (Meets), but is stored into one only through
 * Type.cast. This is the one place a member's membership is decided, for insert, delete and put, and a world
 * relation's entry alike (MemberFit). An insert's or a put's literal facts are then
 * judged at R's primary key: two of them at one key that differ elsewhere are refused (MemberCheck).
 */
type MemberCheck<M, F, R> = MemberFit<M, F, R, true>

/**
 * A delete's facts, fit as every member's are (MemberFit) and judged at no key: a deletion is exact fact identity, so
 * two facts at one key that differ elsewhere delete at most the one stored (runtime/write/normalize.ts judges only
 * additions and puts at a key).
 */
type DeletedCheck<M, F, R> = MemberFit<M, F, R, false>

/**
 * A member's facts M as arms of F, the row type of R its op takes, then, where Keyed, its literal facts at R's key: a
 * query's head, read off its phantom, and an array's or a Stream's facts, each member of a union its own. A member is
 * told by its keys, and a query's head and carriers are read by key, never by a test of the query: a query holds its
 * schema, and a conditional the checker resolves instantiates its operands whole, every relation of the schema with
 * them, once for each member it tests. A member typed `any`, whose keys are every string, is checked by MemberShapeFit.
 */
type MemberFit<M, F, R, Keyed extends boolean> = M extends unknown
	? string extends keyof M
		? MemberShapeFit<M, F, R, Keyed>
		: typeof phantom extends keyof M
			? "heading" extends keyof PhantomOf<M>
				? HeadFit<PhantomOf<M>["heading" & keyof PhantomOf<M>], M, F, R>
				: MemberShapeFit<M, F, R, Keyed>
			: MemberShapeFit<M, F, R, Keyed>
	: never

/** A query member's head H as arms of F, then its carriers each at its field's type (MistypedFields). */
type HeadFit<H, M, F, R> =
	IsNone<UnfitArms<H, F, never>> extends true
		? IsNone<MistypedFields<M, R>> extends true
			? unknown
			: Refusal<"a member's head writes each field at its type: an exact value re-enters a plain field only by Type.cast">
		: Refusal<"the query's head is not a fact of the relation">

/**
 * MemberFit of a member with no head in its phantom, as its shape tells it: an array's or a Stream's facts, each an arm
 * of F, and anything else admitted, as a value typed `any` is.
 */
type MemberShapeFit<M, F, R, Keyed extends boolean> = M extends
	| ReadonlyArray<infer E>
	| Stream.Stream<infer E, unknown, unknown>
	? HostRowsOf<F, R> extends infer Fh
		? [Fh] extends [never]
			? Refusal<"a put or a delete states every instant of its rows from a stored instant: write it from a query">
			: IsNone<UnfitArms<E, Fh, never>> extends true
				? Keyed extends true
					? ConflictsAtKey<M, PrimaryKeyOf<R>> extends true
						? KeyLawRefusal<NameOf<R>, PrimaryKeyOf<R>>
						: unknown
					: unknown
				: Refusal<"a member fact is not a fact of the relation">
		: never
	: unknown

/**
 * The rows an array or a Stream of R states as F, the one type of a host row of R: F where R holds no instant; else,
 * where F leaves every instant optional, an insertion's, F with every instant left out, which the insert stamps, since
 * no host value is an instant; and none where F states one, a put's or a delete's, whose rows name every instant from a
 * stored one, which only a query holds (write/frontend/instants.ts). Every type of rows a host holds is this one: the
 * rows insertAll takes (InsertAllRowsOf), which factsDecoder decodes, and the facts a served workload's member takes
 * (ArrayFacts), each checked by MemberShapeFit against this same type.
 */
export type HostRowsOf<F, R> = [InstantFieldsOf<R>] extends [never]
	? F
	: F extends unknown
		? Partial<Pick<F, InstantFieldsOf<R> & keyof F>> extends Pick<F, InstantFieldsOf<R> & keyof F>
			? Omit<F, InstantFieldsOf<R>>
			: never
		: never

/**
 * Whether X is none. A test of a part read from S is written as this alias over the part, never as a tuple of it,
 * `[Part<S, R>] extends [never]`: a tuple whose element is an alias is a type reference the checker defers, holding the
 * aliases' arguments, S among them, and it instantiates that reference again, permissively and restrictively, at each
 * test it resolves, walking every relation and statement of S each time. Here the tuple holds X alone.
 */
type IsNone<X> = [X] extends [never] ? true : false

/** A relation's primary key fields; a world relation, keyed by its definition's evidence, states none here. */
type PrimaryKeyOf<R> = R extends { readonly primaryKey: infer P extends ReadonlyArray<string> }
	? P
	: readonly []

/**
 * The fields of R a query member's head delivers at a type other than the field's own (WritesAt): its carriers read by
 * key, as MemberFit reads its head.
 */
type MistypedFields<M, R> = "heading" extends keyof M
	? MistypedCarriers<M["heading" & keyof M], R>
	: never
type MistypedCarriers<Hc, R> =
	R extends Headed<infer C>
		? {
				[K in keyof Hc & keyof C]-?: WritesAt<Hc[K], C[K]> extends true ? never : K
			}[keyof Hc & keyof C]
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
		? [DomainOf<F>] extends [InstantDomain]
			? false
			: true
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
 * (a tree member's root fields, an ordered member's group) or one grizzle draws. Assignability alone checks no
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

/** A fact of R as its caller writes it, an addition: every field but those it never writes (UnwrittenFieldsOf). */
export type Addition<R> = Omit<Fact<R>, UnwrittenFieldsOf<R>>

/**
 * The instant fields of R (types/fields InstantField): each one an insert stamps where its rows leave it out, or a
 * query's row states from a stored instant, and no host row carries (write/frontend/instants.ts).
 */
export type InstantFieldsOf<R> = R extends { readonly fields: infer Fields }
	? { [K in keyof Fields]-?: Fields[K] extends InstantField ? K : never }[keyof Fields]
	: never

/**
 * R's insertion: its addition with every instant optional, which its rows leave out to have it stamped or state from a
 * stored instant, a query's term of the instant's type (MistypedFields); R's addition itself where it holds none.
 */
export type InsertionOf<R> = [InstantFieldsOf<R>] extends [never]
	? Addition<R>
	: Omit<Addition<R>, InstantFieldsOf<R>> & {
			readonly [K in InstantFieldsOf<R> & keyof Addition<R>]?: Addition<R>[K]
		}

/**
 * S's sequences, its ordered families and trees, which a nesting reads: the families whose order is the caller's data.
 * A counted family is a law over rows whose group key names their owner, so no write nests it.
 */
type SequenceOf<S> = Extract<StatementsOf<S>[number], OrderedFamily<unknown, unknown> | AnyTree>

/** Any tree: Tree is covariant in what it names. */
type AnyTree = Tree<unknown, unknown, ReadonlyArray<string>>

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

/** What a member's nesting supplies: an ordered member's group, a tree member's root fields. */
type NestedOf<Fa> =
	Fa extends OrderedFamily<
		Side<unknown, readonly [...infer G extends ReadonlyArray<string>, AnyTerm]>,
		unknown
	>
		? G[number]
		: Fa extends Tree<unknown, unknown, infer Root extends ReadonlyArray<string>>
			? Root[number]
			: never

/**
 * R's addition in S: the row its caller writes (Addition<R>), and at each count field of a sequence R owns, an ordered
 * family's or a tree's, its members nested in slot order, each the member relation's addition in S less what the
 * nesting supplies. Order is the caller's data only in a sequence, so only a sequence nests: a counted family's owner
 * and its members are their rows, a member's group key naming its owner. A tree's parent, start and end are drawn,
 * so no addition states them. A relation with no drawn field owns no family and is no tree, so its addition is
 * Addition<R>, read off R alone: a schema whose statements are generic still types it. The addition holds the
 * sequences its nesting reaches (AdditionThrough), never S: the checker walks a type whole each time it instantiates it
 * again, as every test of an insert's facts does, and an addition holding S cost a walk of every relation and
 * statement of S for each relation an insertAll names.
 */
export type AdditionIn<S, R> = [DrawnFieldOf<R>] extends [never]
	? InsertionOf<R>
	: AdditionThrough<R, NestingSequences<S, R>>

/**
 * The sequences an addition of R in S nests, at every depth: R's own (SequencesOwnedBy), then each member relation's.
 * Seen holds the relations walked, so a tree, whose member is its own relation, ends the walk.
 */
type NestingSequences<S, R, Seen = never> =
	Visited<R, Seen> extends true
		? never
		: [DrawnFieldOf<R>] extends [never]
			? never
			: SequencesOwnedBy<S, R> extends infer Fa
				? Fa | (Fa extends unknown ? NestingSequences<S, MemberRelationOf<Fa>, Seen | R> : never)
				: never

/**
 * R's addition read from Fas, every sequence its nesting reaches (NestingSequences): the row its caller writes and, at
 * each count field of a sequence R owns, its members' additions nested in slot order (AdditionIn).
 */
type AdditionThrough<R, Fas> = [DrawnFieldOf<R>] extends [never]
	? Addition<R>
	: Addition<R> & {
			readonly [Fa in OwnedAmong<Fas, NameOf<R>> as CountOf<Fa>]: ReadonlyArray<
				Omit<AdditionThrough<MemberRelationOf<Fa>, Fas>, NestedOf<Fa>>
			>
		}

/** The sequences among Fas whose owner is named Owner, as SequencesOwnedBy reads them: none for a name no literal. */
type OwnedAmong<Fas, Owner> = string extends Owner
	? never
	: Fas extends unknown
		? OwnerNameOf<Fas> extends Owner
			? Fas
			: never
		: never

/** A sequence's count field, which its owner's addition nests its members at. */
type CountOf<Fa> = Fa extends { readonly slots: Fin<unknown, infer N extends string> } ? N : never

/**
 * The relations an addition of R in S writes besides R: the member relations of R's sequences, through every nesting.
 * Seen holds the relations walked, so the walk stops at a tree, a family of its relation over itself, as NestedUnfit's
 * stops at a member type met again.
 */
type NestedWrites<S, R, Seen = never> =
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
	MemberRelationOf<Extract<SequenceOf<S>, OrderedFamily<unknown, unknown>>>
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
 * array of its additions in S (AdditionIn) as a host holds them (HostRowsOf), every instant left out, each with its
 * sequences' members nested in order at its count fields, as insert takes them. A caller types the rows it inserts at
 * once by it, and factsDecoder decodes them.
 */
export type InsertAllRowsOf<S extends AnySchema> = {
	readonly [K in InsertableNameOf<S>]: ReadonlyArray<
		HostRowsOf<AdditionIn<S, InsertedRelation<S, K>>, InsertedRelation<S, K>>
	>
}

/** What insert requires of the relation it writes, as one type: unknown where it writes R. */
type InsertChecks<S, R, Done extends Strata, Last extends Stratum> = WritableCheck<S, R> &
	NotSequenceMember<S, R> &
	EditsOnce<Done, EditsWith<Last, S, R>>

/**
 * What insertAll and insertAllComputed require of their members at key K: a required key, since a key that may be
 * missing inserts nothing its type states; a key naming a relation the ChangeSet writes; then what insert requires of
 * that relation; then, for insertAllComputed, C its computed record, that relation computing every field of C
 * (ComputedRefusals); then its members, its facts (MemberCheck), each refused at the key: insertAll's rows, C never,
 * or rows leaving out every field of C.
 */
type InsertAt<
	S,
	Rows,
	K extends keyof Rows,
	Done extends Strata,
	Last extends Stratum,
	C
> = Rows extends { readonly [P in K]-?: unknown }
	? InsertOf<S, InsertedRelation<S, K>, Rows[K], Done, Last, C>
	: Refusal<"insertAll names each relation by a required key: an optional key may insert nothing">

/** InsertAt of a required key, once its relation is read. */
type InsertOf<S, R, M, Done extends Strata, Last extends Stratum, C> = [R] extends [never]
	? Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">
	: InsertChecks<S, R, Done, Last> extends infer Checked
		? unknown extends Checked
			? [C] extends [never]
				? MemberCheck<M, AdditionIn<S, R>, R>
				: [ComputedRefusals<C, R>] extends [never]
					? MemberCheck<M, ComputedRow<AdditionIn<S, R>, keyof C>, R>
					: ComputedRefusals<C, R>
			: Checked
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
 * insertAll's array members (ArrayAdded), inserts all, one for each key whose members are an array: that key's
 * relation's, in the stratum after the strata Done, over S; none where no key's members are an array.
 */
type InsertedArrays<S, Rows, Done extends Strata, Computed> = {
	[K in keyof Rows]-?: IsArrayMember<Rows[K]> extends true
		? MemberOf<"insert", InsertedRelation<S, K>, PositionOf<Done>, S, Computed>
		: never
}[keyof Rows]

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
 * compile.ts): a closed relation's, whose facts are inserted, never changed or deleted (ClosedChange); a tree's row,
 * since a tree is rewritten whole; a row whose key a field grizzle writes holds, since no fact states it; then a delete
 * of a member of an immutable owner's family, fixed when its owner was inserted; then a put or a delete of a family's
 * member that owns a sequence, whose members are nested under its rows (MemberOwningSequence); and last a delete whose
 * rows nest a closed relation's, which it would remove whole (ClosedBelow). A relation with no drawn field is no tree
 * and owns no family, and one whose caller writes every field states every key, so each test is read only where it can
 * hold: a schema whose statements are generic refuses nothing, and neither does a relation of no one name or no
 * ordinary relation, which WritableCheck refuses.
 */
type EditCheck<S, R, Op extends "put" | "delete"> = [R] extends [AnyRelation]
	? string extends NameOf<R>
		? unknown
		: EditOf<S, R, Op>
	: unknown

/** EditCheck of an ordinary relation of one name. */
type EditOf<S, R, Op extends "put" | "delete"> =
	IsClosed<S, NameOf<R>> extends true
		? Refusal<(typeof closedChangeRefusals)[Op]>
		: IsTreeRow<S, R> extends true
			? Op extends "delete"
				? IsFamilyMember<S, R> extends true
					? Refusal<"a tree whose nodes are another family's members is deleted with that family's owner">
					: ClosedBelow<S, R>
				: Refusal<"a tree is rewritten whole: insert its root with the whole tree nested">
			: UnstatedKey<S, R, Op> extends true
				? Refusal<"a put or a delete names its rows by their key, and no fact states a key field grizzle writes: key the relation by fields its caller writes">
				: Op extends "delete"
					? IsFixedMember<S, R> extends true
						? Refusal<"an immutable owner's family is fixed when its owner is inserted: declare the owner mutable to change it">
						: MemberOwningSequence<S, R> extends Refusal<Refused>
							? MemberOwningSequence<S, R>
							: ClosedBelow<S, R>
					: MemberOwningSequence<S, R>

/**
 * Whether S's statements leave the relations named N closed: they hold no Mutable of any, so their facts are inserted,
 * never changed or deleted. A schema whose statements are generic, which hold every Mutable, leaves none closed.
 */
type IsClosed<S, N> =
	Mutable<unknown> extends StatementsOf<S>[number]
		? false
		: IsNone<N> extends true
			? false
			: IsNone<Exclude<N, MutableName<S>>> extends true
				? false
				: true

/**
 * A delete of R whose rows nest rows of a closed relation through its families (UnitWrites), which removing them whole
 * would delete: refused, as the engine refuses a unit delete below its roots (write/frontend/compile.ts).
 */
type ClosedBelow<S, R> =
	IsClosed<S, UnitWrites<S, R>> extends true
		? Refusal<(typeof closedChangeRefusals)["delete"]>
		: unknown

/**
 * A put or a delete of a member of an ordered or a counted family of S that owns a sequence: its sequence's members are
 * nested under its rows, which a member's edit does not reach.
 */
type MemberOwningSequence<S, R> =
	IsFamilyMember<S, R> extends true
		? IsNone<Extract<NameOf<R>, OwnerNameOf<SequenceOf<S>>>> extends true
			? unknown
			: Refusal<"a family's member that owns a sequence is written by inserting its owner with its rows nested">
		: unknown

/**
 * The facts a delete of R in S takes: a tree's root value, which names one tree, removed whole with every row nested
 * under its nodes, stated by its key heads (KeyHeadsOf: a root field that is a key generation by the fields its
 * generation reads); any other relation's row as its caller writes it (Addition), an owner's removed with every row
 * nested under it (UnitWrites).
 */
type DeletedRow<S, R> =
	IsTreeRow<S, R> extends true
		? Pick<Addition<R>, KeyHeadsOf<R, TreeRootOf<S, R>> & keyof Addition<R>>
		: Addition<R>

/** The root fields of R's tree in S: a tree is a family of its relation over itself, so it is among R's sequences. */
type TreeRootOf<S, R> =
	SequencesOwnedBy<S, R> extends infer T
		? T extends Tree<unknown, unknown, infer Root extends ReadonlyArray<string>>
			? Root[number]
			: never
		: never

/**
 * The relations a delete of R in S removes rows of besides R: the members of every family R owns, through every family
 * they own, a tree's relation its own family's member. Seen holds the relations walked, so the walk stops at a relation
 * met again.
 */
type UnitWrites<S, R, Seen = never> =
	Visited<R, Seen> extends true
		? never
		: [DrawnFieldOf<R>] extends [never]
			? never
			: MemberRelationOf<FamiliesOwnedBy<S, R>> extends infer M
				? M extends unknown
					? NameOf<M> | UnitWrites<S, M, Seen | R>
					: never
				: never

/** The families of S whose owner is R: its ordered and counted families and its tree. */
type FamiliesOwnedBy<S, R> =
	Extract<StatementsOf<S>[number], RowFamily | AnyTree> extends infer Fa
		? Fa extends unknown
			? OwnerNameOf<Fa> extends NameOf<R>
				? Fa
				: never
			: never
		: never

/** The relations a delete of R in S removes rows of besides R: none for a family's member, whose delete is an edit of
 * its family, and its units' relations below it for a tree or an owner (UnitWrites). */
type DeletedWrites<S, R> = IsFamilyMember<S, R> extends true ? never : UnitWrites<S, R>

/** Any ordered or counted family. */
type RowFamily = OrderedFamily<unknown, unknown> | Counted<unknown, unknown>

/** Whether R is a tree's relation in S. */
type IsTreeRow<S, R> = [DrawnFieldOf<R>] extends [never]
	? false
	: IsNone<
				Extract<NameOf<R>, NameOf<MemberRelationOf<Extract<SequenceOf<S>, AnyTree>>>>
		  > extends true
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
	OrderedFamily<unknown, unknown> | Counted<unknown, unknown>
>

/** Whether R is the member of an ordered or a counted family of S whose owner is immutable. */
type IsFixedMember<S, R> = IsNone<FixedOwnerOf<S, R>> extends true ? false : true

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
 * Done is its strata before the last and Last the stratum insert, delete and put write to (Stratum). Arrays is the
 * union of its array members, each held by name (ArrayMember), which ArraysOf reads as the record by op, then relation
 * name (ArrayFacts) of the facts a served workload's member takes with each call (FactsCheck). It is carried
 * contravariantly, so a ChangeSet of more array members is the narrower type, and none, never, is every ChangeSet's.
 *
 * What an applied ChangeSet's outcome reads back is a real member: `reads`, the decoder of the record of its
 * read-backs, each under its name the rows its query's immediate decoder delivers (schema/record.ts record of named
 * attachments). read adds one, and union and sequence merge their arguments' (core/decoder.ts merge), so Reads is the
 * type of the records that decoder assembles (ReadsOf).
 *
 * insert, insertAll, delete and put are functions over the ChangeSet they are called on, `this: ChangeSetOf<S, Params,
 * Writes, Reads, Cx, Done, Last, Arrays>`, declared once at the top level (ChangeSetInsert, ChangeSetInsertAll,
 * ChangeSetDelete, ChangeSetPut), as Rule's members are (types/query/rule.ts). The checker instantiates a method of a
 * generic interface in two steps, the interface's type arguments, then the call's own, and the second walks every
 * type the first put in: the schema, every relation and statement of it, at every type of the signature that holds
 * S, so a chain of n inserts over a schema of n relations cost n². A function that reads its ChangeSet from `this`
 * maps S to the schema without walking it. A member is called on its ChangeSet, as a method is, and on one ChangeSet
 * type, not a union of several. read and bind stay methods: each is called once on a ChangeSet, and a read on a
 * choice between two ChangeSets is one call.
 *
 * ChangeSetOf is the whole type, with every parameter; its public name, over S, Params, Writes and Reads, is
 * public/changeset.ts ChangeSet, the one module that names a ChangeSet's type and its constructors' value alike.
 */
export interface ChangeSetOf<
	S,
	Params = unknown,
	Writes extends string = never,
	Reads = unknown,
	Cx = never,
	Done extends Strata = Strata,
	Last extends Stratum = Stratum,
	Arrays = never
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
			readonly arrays: (members: Arrays) => void
		}> {
	/** The decoder of the outcome's read-backs, by name. */
	readonly reads: RowDecoder<Reads>
	/**
	 * Adds each member fact, with its sequences' members nested in order at its count fields (AdditionIn): every nested
	 * member relation is written too. A counted family's member is a row of its own relation, inserted directly, its
	 * group key naming its owner; grizzle draws every count, index, interval, copy and accumulator.
	 */
	readonly insert: ChangeSetInsert
	/**
	 * Adds the members of each relation the record names by its key, as one insert of each would: the members at each
	 * key are what insert takes for that relation, checked as insert checks them and refused at their key. Inserts within
	 * one stratum are one set, so the record's order is no part of the ChangeSet.
	 */
	readonly insertAll: ChangeSetInsertAll
	/**
	 * Adds the members of each relation the record names, as insertAll does, each an array or a Stream of rows leaving
	 * out every field `computed` names, which the call computes: under each field a term over the call's parameters, its
	 * clock reading and literals, written at the field's type, evaluated once for every row of each relation its
	 * stratum's host rows insert, in the statement that writes them; every relation the record names computes every
	 * field, refused at its key where it lacks one; a nested member whose group carries a computed field of its owner's
	 * key holds its owner's value.
	 */
	readonly insertAllComputed: ChangeSetInsertAllComputed
	/**
	 * Removes each member fact, stated as its caller writes it (Addition<R>): the fields PostgreSQL and grizzle write are
	 * no part of a fact's identity a caller states, so an insert and a delete of one fact state one row. A tree's delete
	 * states its root value, each one tree (DeletedRow). A tree, and an owner of a family that is no family's member,
	 * go with every row nested under them, through every family (UnitWrites), so a group goes whole. A row whose primary
	 * key holds a field grizzle writes, and a member of an immutable owner's family, are no delete's (EditCheck). Its
	 * facts are judged at no key (DeletedCheck): two at one key name at most the one stored. Its stratum puts none of
	 * the rows such a delete removes whole (PutBesideDoomed).
	 */
	readonly delete: ChangeSetDelete
	/**
	 * Removes, of each relation the record names by its key, the rows whose fields its record names equal what it equates
	 * them to, each a parameter (`param(name, descriptor)`) or a literal of the field's type: `DELETE FROM R WHERE f =
	 * $1 AND …`, the delete of a query matching R's rows by their own fields alone, which the planner holds as one (write/
	 * frontend/equal.ts). Each key is a delete of its relation, checked as delete checks one and refused at its key, and
	 * names only the fields its delete's rows state (DeletedRow): a tree's root fields, any other relation's written
	 * fields. A selection reads no other relation, no other field and no other comparison, so nothing but a query member
	 * writes such a delete. Deletes within one stratum are one set, so the record's order is no part of the ChangeSet.
	 */
	readonly deleteWhere: ChangeSetDeleteWhere
	/**
	 * After the change, R's fact at each member's key is that member, with the fields its caller does not write as
	 * PostgreSQL and grizzle write them. For every relation it is the row its caller writes (Addition<R>): an owner's put
	 * leaves its families as they are, and a member's put is an edit of its family, in place, a refill from its slot or
	 * a move between groups, which grizzle plans. A tree's row, a row a declared key of which holds a field grizzle
	 * writes, and an immutable family owner are no put's (EditCheck), nor a row its stratum deletes whole
	 * (PutBesideDoomed).
	 */
	readonly put: ChangeSetPut
	/**
	 * A query over the post-change state and the change's own delta, delivered in the outcome under `name`. It runs
	 * before COMMIT, so its rows are typed by immediate-constraint evidence only: they are the records its immediate
	 * decoder assembles. A read-back is read once, after the whole ChangeSet, so a name reads one query: a read of a
	 * name the ChangeSet already reads over the same query is that read-back, and over another query is refused (the
	 * types refuse one whose rows are of another type; the builder, one whose query is another).
	 */
	read<const Name extends string, Q extends QueryAt<LevelsOf<S>> | OrderedAt<LevelsOf<S>>, IHead>(
		name: ReadName<Name, Reads, IHead>,
		readBack: (delta: Delta<S>) => Q & Decoders<unknown, IHead>
	): ChangeSetOf<
		S,
		JointParams<Params, ParamsOf<Q>>,
		Writes,
		JointReads<Reads, { readonly [K in Name]: ReadonlyArray<IHead> }>,
		Cx | ContextsOf<Q>,
		Done,
		Last,
		Arrays
	>
	/**
	 * Closes the parameters `params` names, the others staying free: each scalar parameter with a value of its language,
	 * each relation parameter with its facts, or with a query or a bound query of its rows (BoundRows), which every member
	 * and read-back that uses the parameter reads in its own statement. The ChangeSet is then over the higher of S and
	 * those queries' schemas (BoundOver), reads their contexts, and needs their own parameters, each the one parameter of
	 * its name.
	 */
	bind<const Arg extends BindArgOf<Params>>(
		params: Arg & OnlyParams<Arg, Params> & BoundRows<Arg, Params, S>
	): ChangeSetOf<
		BoundOver<S, Arg, Params>,
		BoundParams<Params, Arg>,
		Writes,
		Reads,
		Cx | BindContexts<Arg>,
		Done,
		Last,
		Arrays
	>
}

/**
 * What ChangeSet.bind takes for each parameter of P it names: a scalar parameter's value of its language; a relation
 * parameter's facts, an array or a Stream, or a source of its rows, a query or a bound query (BoundRows), which refuses
 * a source for a scalar parameter by name. Each value is a ParamValue or a source by construction. A ChangeSet with no
 * parameters takes NoParamsArg, an object with no key, as the builder refuses a value that is no record
 * (write/changeset/value.ts bindParams).
 */
type BindArgOf<P> = [keyof P] extends [never]
	? NoParamsArg
	: {
			readonly [K in keyof P]?:
				| (ArgumentOf<P[K]> & ParamValue)
				| Source<P[K] extends ReadonlyArray<infer Row> | Stream.Stream<infer Row> ? Row : unknown>
		}

/**
 * What ChangeSet.bind holds of each query or bound query it binds a relation parameter of P to: the parameter's rows,
 * exactly its fields, over a level of S or a schema S is a level of (QueryRows); never a scalar parameter, which takes
 * one value where a query's rows are any number; and the query's own parameters, which join the ChangeSet's, each the
 * ChangeSet's free parameter of its name at its one type (AgreeingParams).
 */
type BoundRows<A, P, S> = {
	readonly [K in keyof A]: K extends keyof P
		? A[K] extends Phantom<{ readonly schema: unknown }>
			? P[K] extends ReadonlyArray<infer Row> | Stream.Stream<infer Row>
				? QueryRows<A[K], Row, S> & AgreeingParams<Omit<P, keyof A>, ParamsOf<A[K]>>
				: Refusal<"a query binds a relation parameter, whose rows are any number; a scalar parameter takes one value">
			: unknown
		: unknown
}

/** Whether every parameter of Q that P names too is P's at one type: one name is one parameter. */
type AgreeingParams<P, Q> = [
	{
		[K in keyof Q & keyof P]-?: [P[K]] extends [Q[K]] ? ([Q[K]] extends [P[K]] ? never : K) : K
	}[keyof Q & keyof P]
] extends [never]
	? unknown
	: Refusal<"a bound query's parameter is the ChangeSet's parameter of its name, at its one type">

/**
 * The parameters a ChangeSet bound with A needs: those of P that A leaves free, and those each program A binds a
 * relation parameter to needs (ParamsOf), a query's own, a bound query's those its bind map needs, which join them,
 * each folded as a contribution (ParamsContribution), so a value or facts, which need none, never erase them; none,
 * unknown, where none is left.
 */
type BoundParams<P, A> = FreeLeft<
	Omit<P, keyof A> &
		UnionToIntersection<{ [K in keyof A]-?: ParamsContribution<ParamsOf<A[K]>> }[keyof A]>
>
/** A map of parameters as one record, or unknown where it holds none. */
type FreeLeft<M> = [keyof M] extends [never] ? unknown : Simplify<M>

/** ChangeSet.insert over the ChangeSet it is called on (ChangeSet). */
type ChangeSetInsert = <
	S,
	Params,
	Writes extends string,
	Reads,
	Cx,
	Done extends Strata,
	Last extends Stratum,
	Arrays,
	R extends AnyRelation | AnyWorld,
	const M extends Member<S, unknown>
>(
	this: ChangeSetOf<S, Params, Writes, Reads, Cx, Done, Last, Arrays>,
	relation: R &
		WritableCheck<S, R> &
		NotSequenceMember<S, R> &
		EditsOnce<Done, EditsWith<Last, S, R>>,
	facts: M & MemberCheck<M, AdditionIn<S, R>, R>
) => ChangeSetOf<
	S,
	JointParams<Params, ParamsOf<M>>,
	Writes | NameOf<R> | NestedWrites<S, R>,
	Reads,
	Cx | ContextsOf<M>,
	Done,
	Stratum<
		Last["inserts"] | NameOf<R> | NestedWrites<S, R>,
		Last["needs"] | FixedOwnerOf<S, R>,
		EditsWith<Last, S, R>,
		Last["puts"],
		Last["doomed"]
	>,
	Arrays | ArrayAdded<"insert", R, M, S, Done>
>

/**
 * The rows an insert takes whose fields Computed its call computes: Row less those fields (ChangeSet.insertAllComputed),
 * Row itself where it computes none.
 */
type ComputedRow<Row, Computed> = [Computed] extends [never] ? Row : Omit<Row, Computed & keyof Row>

/**
 * What insertAllComputed computes of the host rows of R, a relation its record names, C: under each field a field of R
 * its caller writes, a term the call evaluates once, over its parameters, its clock reading and literals, that writes
 * the field at its own type (WritesAt), as a query member's head does: a JavaScript value of its language, or a term of
 * its identity and SQL type exactly, Type.cast making one of any other. The record is the head of a query member that
 * matches nothing, so a field its caller does not write, an instant among them, is refused as such a head's is. Each
 * field that is not so, by its refusal; never where every one is.
 */
type ComputedRefusals<C, R> = {
	[K in keyof C]-?: K extends Exclude<keyof Fact<R>, UnwrittenFieldsOf<R> | InstantFieldsOf<R>>
		? WritesAt<C[K], CarrierAt<R, K>> extends true
			? never
			: Refusal<"a member's head writes each field at its type: an exact value re-enters a plain field only by Type.cast">
		: Refusal<"the query's head is not a fact of the relation">
}[keyof C]

/** A computed record names at least one field: one that names none computes nothing, which is insertAll's. */
type ComputedSome<C> = [keyof C] extends [never]
	? Refusal<"a computed insert computes at least one field: insert writes rows that state every field">
	: unknown

/** The parameters an insert's computed fields need together, each term's (ParamsOfTerm), unknown where none names one. */
type ComputedParams<C> = {
	[K in keyof C]-?: (params: ParamsOfTerm<C[K]>) => void
}[keyof C] extends (params: infer P) => void
	? P
	: unknown

/** ChangeSet.insertAll over the ChangeSet it is called on (ChangeSet). */
type ChangeSetInsertAll = <
	S,
	Params,
	Writes extends string,
	Reads,
	Cx,
	Done extends Strata,
	Last extends Stratum,
	Arrays,
	const Rows extends { readonly [K in keyof Rows]: Member<S, unknown> }
>(
	this: ChangeSetOf<S, Params, Writes, Reads, Cx, Done, Last, Arrays>,
	rows: Rows & { readonly [K in keyof Rows]: InsertAt<S, Rows, K, Done, Last, never> }
) => ChangeSetOf<
	S,
	JointParams<Params, InsertedParams<Rows>>,
	Writes | InsertedWrites<S, Rows>,
	Reads,
	Cx | ContextsOf<Rows[keyof Rows]>,
	Done,
	Stratum<
		Last["inserts"] | InsertedWrites<S, Rows>,
		Last["needs"] | InsertedNeeds<S, Rows>,
		InsertedEdits<Last, S, Rows>,
		Last["puts"],
		Last["doomed"]
	>,
	Arrays | InsertedArrays<S, Rows, Done, never>
>

/** ChangeSet.insertAllComputed over the ChangeSet it is called on (ChangeSet): insertAll's, each key's rows an array or
 * a Stream that leave out every field C computes, which every relation the record names computes (InsertAt). */
type ChangeSetInsertAllComputed = <
	S,
	Params,
	Writes extends string,
	Reads,
	Cx,
	Done extends Strata,
	Last extends Stratum,
	Arrays,
	const Rows extends {
		readonly [K in keyof Rows]: ReadonlyArray<unknown> | Stream.Stream<unknown>
	},
	const C extends Readonly<Record<string, unknown>>
>(
	this: ChangeSetOf<S, Params, Writes, Reads, Cx, Done, Last, Arrays>,
	rows: Rows & { readonly [K in keyof Rows]: InsertAt<S, Rows, K, Done, Last, C> },
	computed: C & ComputedSome<C>
) => ChangeSetOf<
	S,
	JointParams<Params, ComputedParams<C>>,
	Writes | InsertedWrites<S, Rows>,
	Reads,
	Cx | ContextsOf<C[keyof C]>,
	Done,
	Stratum<
		Last["inserts"] | InsertedWrites<S, Rows>,
		Last["needs"] | InsertedNeeds<S, Rows>,
		InsertedEdits<Last, S, Rows>,
		Last["puts"],
		Last["doomed"]
	>,
	Arrays | InsertedArrays<S, Rows, Done, keyof C>
>

/** ChangeSet.delete over the ChangeSet it is called on (ChangeSet). */
type ChangeSetDelete = <
	S,
	Params,
	Writes extends string,
	Reads,
	Cx,
	Done extends Strata,
	Last extends Stratum,
	Arrays,
	R extends AnyRelation | AnyWorld,
	const M extends Member<S, unknown>
>(
	this: ChangeSetOf<S, Params, Writes, Reads, Cx, Done, Last, Arrays>,
	relation: R &
		WritableCheck<S, R> &
		EditCheck<S, R, "delete"> &
		EditsOnce<Done, EditsWith<Last, S, R>> &
		PutBesideDoomed<Last["puts"], DoomedBy<S, R>>,
	facts: M & DeletedCheck<M, DeletedRow<S, R>, R>
) => ChangeSetOf<
	S,
	JointParams<Params, ParamsOf<M>>,
	Writes | NameOf<R> | DeletedWrites<S, R>,
	Reads,
	Cx | ContextsOf<M>,
	Done,
	Stratum<
		Last["inserts"],
		Last["needs"],
		EditsWith<Last, S, R>,
		Last["puts"],
		Last["doomed"] | DoomedBy<S, R>
	>,
	Arrays | ArrayAdded<"delete", R, M, S, Done>
>

/** ChangeSet.deleteWhere over the ChangeSet it is called on (ChangeSet). */
type ChangeSetDeleteWhere = <
	S,
	Params,
	Writes extends string,
	Reads,
	Cx,
	Done extends Strata,
	Last extends Stratum,
	Arrays,
	const Sel extends { readonly [K in keyof Sel]: { readonly [F in keyof Sel[K]]: unknown } }
>(
	this: ChangeSetOf<S, Params, Writes, Reads, Cx, Done, Last, Arrays>,
	selections: Sel & { readonly [K in keyof Sel]: SelectionAt<S, Sel, K, Last> }
) => ChangeSetOf<
	S,
	JointParams<Params, SelectedParams<Sel>>,
	Writes | SelectedWrites<S, Sel>,
	Reads,
	Cx,
	Done,
	Stratum<
		Last["inserts"],
		Last["needs"],
		Last["edits"],
		Last["puts"],
		Last["doomed"] | SelectedDoomed<S, Sel>
	>,
	Arrays
>

/**
 * What deleteWhere requires of its selection at key K: a required key, since a key that may be missing deletes nothing
 * its type states; a key naming a relation the ChangeSet writes; what delete requires of that relation; then of the
 * selection, each field one its delete's rows state (DeletedRow), equal to what it may equal (EqualedTo), each refused
 * at its key.
 */
type SelectionAt<S, Sel, K extends keyof Sel, Last extends Stratum> = Sel extends {
	readonly [P in K]-?: unknown
}
	? SelectionOf<S, InsertedRelation<S, K>, Sel[K], Last>
	: Refusal<"deleteWhere names each relation by a required key: an optional key may delete nothing">

/**
 * SelectionAt of a required key, once its relation is read: what delete requires of the relation, and no family's
 * member, whose delete grizzle plans from its rows on the host (write/frontend/compile.ts), which no selection states;
 * then its fields. Each requirement is read only where every one before it holds, so a key is refused by one refusal,
 * the first it breaks.
 */
type SelectionOf<S, R, Fields, Last extends Stratum> = [R] extends [never]
	? Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">
	: Holding<
			WritableCheck<S, R>,
			Holding<
				EditCheck<S, R, "delete">,
				Holding<
					SelectedMember<S, R>,
					Holding<
						PutBesideDoomed<Last["puts"], DoomedBy<S, R>>,
						SelectedFields<Fields, DeletedRow<S, R>, R>
					>
				>
			>
		>

/** Then where the requirement C holds, unknown; C, its refusal, otherwise. */
type Holding<C, Then> = unknown extends C ? Then : C

/** A selection of an ordered or a counted family's member, refused: a member's delete is its family's edit. */
type SelectedMember<S, R> =
	IsFamilyMember<S, R> extends true
		? Refusal<"deleteWhere deletes no family's member: grizzle edits a family from the rows a ChangeSet states, so delete a member from an array or a Stream">
		: unknown

/**
 * A selection's fields as its relation R takes them: each a field of the rows its delete names, Row, equal to what it
 * may equal at R's carrier for it (EqualedTo); any other refused.
 */
type SelectedFields<Fields, Row, R> = {
	readonly [F in keyof Fields]: F extends keyof Row
		? EqualedTo<CarrierAt<R, F>>
		: Refusal<"deleteWhere selects by the fields its delete's rows state: a tree's root fields, any other relation's written fields">
}

/** R's carrier for the field F, read by key: a relation's field, a world relation's head field. */
type CarrierAt<R, F> = "heading" extends keyof R
	? F extends keyof R["heading" & keyof R]
		? R["heading" & keyof R][F]
		: never
	: never

/**
 * What a selection equates a field of carrier C to: a parameter, a term of origin ParamOrigin (`param`, `r.param`) that
 * meets the field's type (Meets), the field's own domain and SQL type; or a JavaScript value of its language, a
 * string, number, bigint, boolean, Decimal or Money, which the checker types by the field it meets, as it types a head
 * literal. A variable, a typed constant and a scalar term are no parameter, so a selection reads nothing but the
 * relation's own fields and the values its caller names.
 */
type EqualedTo<C> =
	| Extract<LiteralOf<LanguageOf<C>>, HeadValue>
	| InputTerm<DomainOf<C>, never, ParamOrigin, SqlOfCarrier<C>>

/**
 * The parameters deleteWhere's selections need together: each field's parameter (ParamsOfTerm), joined as its deletes
 * join them, and unknown where none names one.
 */
type SelectedParams<Sel> = {
	[K in keyof Sel]-?: {
		[F in keyof Sel[K]]-?: (params: ParamsOfTerm<Sel[K][F]>) => void
	}[keyof Sel[K]]
}[keyof Sel] extends (params: infer P) => void
	? P
	: unknown

/** The relations deleteWhere's deletes write: each key's relation and the rows its delete removes whole (DeletedWrites). */
type SelectedWrites<S, Sel> = {
	[K in keyof Sel]-?: NameOf<InsertedRelation<S, K>> | DeletedWrites<S, InsertedRelation<S, K>>
}[keyof Sel]

/** The relations deleteWhere's deletes remove whole (DoomedBy). */
type SelectedDoomed<S, Sel> = {
	[K in keyof Sel]-?: DoomedBy<S, InsertedRelation<S, K>>
}[keyof Sel]

/** ChangeSet.put over the ChangeSet it is called on (ChangeSet). */
type ChangeSetPut = <
	S,
	Params,
	Writes extends string,
	Reads,
	Cx,
	Done extends Strata,
	Last extends Stratum,
	Arrays,
	R extends AnyRelation | AnyWorld,
	const M extends Member<S, unknown>
>(
	this: ChangeSetOf<S, Params, Writes, Reads, Cx, Done, Last, Arrays>,
	relation: R &
		WritableCheck<S, R> &
		EditCheck<S, R, "put"> &
		EditsOnce<Done, EditsWith<Last, S, R>> &
		PutBesideDoomed<NameOf<R>, Last["doomed"]>,
	facts: M & MemberCheck<M, Addition<R>, R>
) => ChangeSetOf<
	S,
	JointParams<Params, ParamsOf<M>>,
	Writes | NameOf<R>,
	Reads,
	Cx | ContextsOf<M>,
	Done,
	Stratum<
		Last["inserts"],
		Last["needs"],
		EditsWith<Last, S, R>,
		Last["puts"] | NameOf<R>,
		Last["doomed"]
	>,
	Arrays | ArrayAdded<"put", R, M, S, Done>
>

/**
 * The parameters two parts of a program need together, A those of the program so far and B a part's own: one map of
 * them, and unknown where neither names one, as an empty ChangeSet's and a bound one's are, so every ChangeSet that
 * needs none has one parameter type and a choice of two of them is one program.
 *
 * The map is the intersection of the parts' maps, which the checker keeps flat, one map per member however many came
 * before it, and reads where it is read (ParamsOf, ParamArg). A part that names none adds unknown, the identity of
 * intersection, so A is unknown or a map that names some, and the test reads B's keys alone. A map rebuilt over the one
 * before it at each member, a mapped type of a mapped type, was read through every member before it at each of its
 * keys: a relation parameter's rows, an array or a Stream, met that way once per member, were a union of every choice
 * of one or the other for each (TS2590 at 25 members, metis's assign; TS2589 at 50).
 */
type JointParams<A, B> = A & ([keyof B] extends [never] ? unknown : B)

/** The op a ChangeSet's array member is added by, which a call's facts key it under first: insertAll's are inserts. */
type ArrayOp = "insert" | "put" | "delete"

/**
 * An array member of a ChangeSet: the relation R it writes, the type of each of its facts, Row, the facts insert,
 * delete or put takes for R (AdditionIn for an insert, its sequences' members nested at its count fields, and Addition
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
 * An array member of a ChangeSet held by name, as a schema holds its statements: the op that adds it, the relations it
 * writes, each spelled by its name where its level's record holds it under its literal name and as itself otherwise
 * (NameIn), its stratum's position At, and the level whose relations and additions it reads by its address
 * (LevelAddress): a schema's or a role's depth, the number of levels below it, or a fragment's mark, the fragment among
 * the levels that holds the relation it spells. No row and no relation the record holds rides in it, so a ChangeSet's
 * members are names the checker never instantiates again, and a builder's call adds one in constant cost; ArraysOf
 * reads each back as the relation and the row its op takes. A ChangeSet carries its members contravariantly, and each
 * member its parts, so a ChangeSet of more members, and of members known more exactly, is the narrower type, as one of
 * known strata is narrower than one whose strata are not known.
 */
interface ArrayMember<in Op, in Spelled, in At, in Address, in Computed> {
	readonly member: (op: Op, spelled: Spelled, at: At, address: Address, computed: Computed) => void
}

/**
 * The levels below S, one element each: none below a root schema, and below an extension or a role the level it is
 * defined over and every level below that one. Every level of a schema lies at a depth of its own, so a member names
 * its level by its depth, whatever the levels' names.
 */
type DepthOf<S> = S extends unknown ? DepthBelow<BelowOf<S>> : never

/** DepthOf the level below, B: none below a root schema. */
type DepthBelow<B> = [B] extends [never] ? readonly [] : readonly [unknown, ...DepthOf<B>]

/**
 * The level of S at the depth Depth: S itself, or the level below it at that depth, each read off its phantom by key
 * (BelowOf), so a member's level is found in a step for each level, none of which reads a level whole.
 */
type LevelAt<S, Depth> = DepthOf<S>["length"] extends Depth ? S : LevelAt<BelowOf<S>, Depth>

/**
 * Where a ChangeSet over S finds its member's level among the levels of any ChangeSet it joins: a schema's or a role's
 * depth (DepthOf), its place in the chain of levels every schema above it extends; a fragment's mark, since a fragment
 * is a level of every schema that lists it, at whatever depth lists it, and of no chain (LevelOfMember).
 */
type LevelAddress<S> = S extends AnyFragment ? "fragment" : DepthOf<S>["length"]

/**
 * The level of S at a member's address, the member spelling its relation Spelled: at a depth, the level at that depth
 * (LevelAt); at a fragment's mark, the fragment among S and the fragments S's levels list that holds the relation, one
 * name naming one relation across a schema's levels and the fragments they list. Its caller passes it on as an
 * argument and never binds it by `infer`: a level is a schema, and a bound type the checker reads again in a branch it
 * instantiates whole, every relation of the schema with it, once for each member.
 */
type LevelOfMember<S, Address, Spelled> = Address extends "fragment"
	? Extract<
			Extract<S, AnyFragment> | AllFragmentsOf<S>,
			{ readonly relations: { readonly [N in NameOfSpelled<Spelled>]: unknown } }
		>
	: LevelAt<S, Address>

/**
 * The array member of the relations R over S, each spelled as S's record names it, none where R is no relation. Its
 * parts are bound by `infer` first, each alone, so the member is no type reference the checker defers, which it would
 * instantiate again at every call that adds a member after it, and the test that binds them holds no tuple of S's
 * parts (IsNone).
 */
type MemberOf<Op extends ArrayOp, R, At extends ReadonlyArray<unknown>, S, Computed = never> = [
	R
] extends [never]
	? never
	: NameIn<R, RelationsOf<S>> extends infer Spelled
		? LevelAddress<S> extends infer Address
			? ArrayMember<Op, Spelled, At, Address, Computed>
			: never
		: never

/**
 * The array member member M of R adds by Op over S, in the stratum after the strata Done: one where M is an array, none
 * for a Stream or a query member, whose facts no call supplies. A ChangeSet's Arrays is the union of every member's, and
 * the array members of one op and one relation in one stratum are one member, their facts one array, as the value holds
 * them (write/changeset/value.ts); two in two strata meet with no position (RepeatedArrays), which a workload refuses
 * (types/db/workload.ts), as the engine refuses them in a served workload (UnservedMember).
 */
type ArrayAdded<Op extends ArrayOp, R, M, S, Done extends Strata, Computed = never> =
	IsArrayMember<M> extends true ? MemberOf<Op, R, PositionOf<Done>, S, Computed> : never

/**
 * Whether every member of the union M is an array, true for none: told by its keys, as MemberFit tells it, so a query
 * member is never tested whole. A member typed `any`, whose keys are every string, is one, as `[any]` is an array's.
 */
type IsArrayMember<M> = ArrayArm<M> extends true ? true : false
type ArrayArm<M> = M extends unknown
	? string extends keyof M
		? true
		: typeof phantom extends keyof M
			? false
			: M extends ReadonlyArray<unknown>
				? true
				: false
	: never

/** sequence's array members of b: each a stratum later by every stratum of a, `Before`, bound as MemberOf binds. */
type Shifted<A, Before extends ReadonlyArray<unknown>> =
	A extends ArrayMember<
		infer Op,
		infer Spelled,
		infer At extends ReadonlyArray<unknown>,
		infer Address,
		infer Computed
	>
		? readonly [...PositionOf<Before>, ...At] extends infer Later
			? ArrayMember<Op, Spelled, Later, Address, Computed>
			: never
		: never

/**
 * The array member A of a ChangeSet over S as the record of its facts by op, then relation name (ArrayFacts), one
 * record for each member, as each call that adds one adds it: its relation is the one its spelling names in its level,
 * and its row the facts its op takes for that relation over that level (RowOfOp) as a host holds them (HostRowsOf). The relation and the row are bound by
 * `infer`, so the record holds ArrayFacts itself, as the call wrote it, and no alias of it; the level is passed on, never
 * bound (LevelOfMember).
 */
type RecordOf<S, A> =
	A extends ArrayMember<
		infer Op extends ArrayOp,
		infer Spelled,
		infer At extends ReadonlyArray<unknown>,
		infer Address,
		infer Computed
	>
		? RelationIn<Spelled, RelationsOf<LevelOfMember<S, Address, Spelled>>> extends infer R
			? HostRowsOf<
					RowOfOp<Op, LevelOfMember<S, Address, Spelled>, R, Computed>,
					R
				> extends infer Row
				? {
						readonly [O in Op]: {
							readonly [N in NameOfSpelled<Spelled>]: ArrayFacts<R, Row, At>
						}
					}
				: never
			: never
		: never

/** The facts Op takes for R over its level L: an insert's addition, less the fields Computed its insert computes
 * (ComputedRow), a delete's row, a put's written fact. */
type RowOfOp<Op, L, R, Computed> = Op extends "insert"
	? ComputedRow<AdditionIn<L, R>, Computed>
	: Op extends "delete"
		? DeletedRow<L, R>
		: Addition<R>

/** The name of a spelled relation: the name it is spelled by, or the name of the relation spelled as itself. */
type NameOfSpelled<Spelled> = Spelled extends string ? Spelled : NameOf<Spelled>

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

/**
 * The relations a ChangeSet X's array members hold by one op in two strata, RepeatedArrays of its array members (ArraysOf)
 * read from their positions alone: whether two members meet is their op, their relation's name and their position, never
 * their rows, so a workload's check of its ChangeSets (types/db/workload.ts ArraysOnce) builds no member's row.
 */
export type RepeatedArraysOf<X> =
	X extends Phantom<{
		readonly schema: Invariant<infer _S>
		readonly arrays: (members: infer A) => void
	}>
		? RepeatedArrays<UnionToIntersection<PositionOfMember<A>>>
		: never

/** An array member's position under its op and its relation's name, as its record in ArraysOf holds it (RecordOf). */
type PositionOfMember<A> =
	A extends ArrayMember<
		infer Op extends ArrayOp,
		infer Spelled,
		infer At extends ReadonlyArray<unknown>,
		infer _Address,
		infer _Computed
	>
		? { readonly [O in Op]: { readonly [N in NameOfSpelled<Spelled>]: { readonly at: At } } }
		: never

/**
 * A ChangeSet's array members by op, then relation name (ArrayFacts), read back from the members it holds by name: the
 * records of its members (RecordOf), met, and unknown for a program that holds none.
 */
export type ArraysOf<X> =
	X extends Phantom<{
		readonly schema: Invariant<infer S>
		readonly arrays: (members: infer A) => void
	}>
		? UnionToIntersection<RecordOf<S, A>>
		: unknown

/**
 * One op's facts in F checked against the array members A of that op: each relation's checked as the op checks its own
 * (MemberFit), exactly an arm of its row type each, no field beyond it, and, Keyed, an insert's and a put's, no two
 * literal facts at one primary key (MemberCheck), a delete's at no key (DeletedCheck); a member's relation F leaves out
 * required at its row type; and a key naming no array member's relation of the op refused. A member's relation and row
 * are read off its ArrayFacts by key (FactsRelation, FactsRow), never bound by matching it: a bound relation and row
 * are instantiated again, whole, in the branch that reads them, a relation's every field with it, for each relation the
 * facts name.
 */
type OpFactsCheck<F, A, Keyed extends boolean> = {
	readonly [N in keyof A | keyof F]: N extends keyof A
		? N extends keyof F
			? MemberFit<F[N], FactsRow<A[N]>, FactsRelation<A[N]>, Keyed>
			: ReadonlyArray<FactsRow<A[N]>>
		: Refusal<"a served ChangeSet's facts name, under each op, only the relations of its array members of that op">
}

/** The relation an array member's facts write (ArrayFacts), read by key: none for anything else. */
type FactsRelation<A> = A["relation" & keyof A]

/** The row an array member's facts each are (ArrayFacts), read by key: none for anything else. */
export type FactsRow<A> = A["row" & keyof A]

/** Whether an op's facts are judged at their relation's key: an insert's and a put's, never a delete's (DeletedCheck). */
type KeyedOp<Op> = Op extends "delete" ? false : true

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
			? OpFactsCheck<F[Op], A[Op], KeyedOp<Op>>
			: OpFactsCheck<unknown, A[Op], KeyedOp<Op>>
		: Refusal<"a served ChangeSet's facts name only the ops of its array members: insert, put and delete">
}

/**
 * What one stratum of a ChangeSet writes, as the engine's front end plans it (write/frontend/compile.ts): the relations
 * it inserts, each with every sequence member its nesting reaches (`inserts`); the immutable owners whose families its
 * inserts append to, which an owner's family takes only from an insert of the owner in the same stratum (`needs`);
 * whether it writes a member of an ordered or a counted family, an edit the engine plans from one read before the
 * ChangeSet's writes, so in one stratum alone (`edits`); the relations it puts (`puts`); and the relations its deletes
 * remove whole, each tree's or family owner's deleted with every relation nested under it (`doomed`, DoomedBy), none of
 * which it puts. Each is a type argument, so a builder's call states the stratum it makes from the one before in
 * constant depth, however long its chain.
 */
export interface Stratum<
	out Inserts extends string = string,
	out Needs extends string = string,
	out Edits extends boolean = boolean,
	out Puts extends string = string,
	out Doomed extends string = string
> {
	readonly inserts: Inserts
	readonly needs: Needs
	readonly edits: Edits
	readonly puts: Puts
	readonly doomed: Doomed
}

/** A ChangeSet's strata before its last in order: a tuple where they are known, which every builder keeps. */
export type Strata = ReadonlyArray<Stratum>

/** The stratum an empty ChangeSet holds, and a stratum no member has written. */
export type Unwritten = Stratum<never, never, false, never, never>

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
					Ah["edits"] extends true ? true : Bh["edits"],
					Ah["puts"] | Bh["puts"],
					Ah["doomed"] | Bh["doomed"]
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

/**
 * A family's members are written in one stratum, as write/frontend/compile.ts refuses (`editingStrata`): each stratum's
 * family statements are drawn from the state the strata before it leave, which no property of grizzle's holds beside
 * another stratum's edits of a family's members yet (TODO.md, "One stratum per family's members").
 */
type EditsRefusal<Twice> = Twice extends true
	? Refusal<"a ChangeSet writes a family's members in one stratum: each stratum's family statements are proved against one stratum's edits alone">
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
 * The relations a delete of R in S removes whole: R and every relation nested under its rows (UnitWrites), where R is a
 * tree's relation or a family's owner and no other family's member; none for any other delete, which removes the rows
 * it names alone.
 */
type DoomedBy<S, R> =
	IsNone<DeletedWrites<S, R>> extends true ? never : NameOf<R> | DeletedWrites<S, R>

/** Whether a stratum puts one of the relations it removes whole: neither side refuses where it is not known. */
type PutMeetsDoomed<Put extends string, Doomed extends string> = string extends Put
	? false
	: string extends Doomed
		? false
		: [Extract<Put, Doomed>] extends [never]
			? false
			: true

/** A stratum puts no row its deletes remove whole, as the engine plans a stratum's unit deletes before its puts. */
type DoomedRefusal<Meets> = Meets extends true
	? Refusal<"a stratum puts no row its deletes remove whole: a delete of a tree or of a family's owner removes every row nested under it, so put in another stratum (ChangeSet.sequence), or insert the rows again whole">
	: unknown

/**
 * A put's or a delete's check of its stratum: `Put` the relations put, `Doomed` those removed whole, one of them the
 * call's own and the other its stratum's so far.
 */
type PutBesideDoomed<Put extends string, Doomed extends string> = DoomedRefusal<
	PutMeetsDoomed<Put, Doomed>
>

/** Whether one of the strata puts a relation it removes whole, one walk over them. */
type PutsDoomed<St> = St extends readonly [infer H extends Stratum, ...infer T]
	? PutMeetsDoomed<H["puts"], H["doomed"]> extends true
		? true
		: PutsDoomed<T>
	: false

/**
 * union's refusal: a stratum of its aligned strata that puts a row another of its arguments removes whole there. The
 * strata are walked only where a delete removes rows whole, so a union of ChangeSets of which none does costs no walk.
 */
type UnionDoomed<D1 extends Strata, L1 extends Stratum, D2 extends Strata, L2 extends Stratum> = [
	(D1[number] | L1 | D2[number] | L2)["doomed"]
] extends [never]
	? unknown
	: DoomedRefusal<PutsDoomed<Aligned<readonly [...D1, L1], readonly [...D2, L2]>>>

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
 * What compiling a ChangeSet requires of its strata, which db.apply, db.compile and a workload check where they compile
 * it: every append to an immutable owner's family beside an insert of the owner in its stratum.
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
		: IsNone<Extract<NameOf<R>, NameOf<MemberRelationOf<RowFamilyOf<S>>>>> extends true
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

/**
 * delta.met names what delta.added and delta.removed name but a family's members, whose additions their family
 * statement writes, so no insertion of them meets a stored fact at an arbiter key. A relation whose primary key holds a
 * span is refused where the ChangeSet compiles: its exclusion constraint arbitrates by ON CONFLICT DO NOTHING ON
 * CONSTRAINT alone, so no statement tells a fact an insertion met from one it made.
 */
type MetCheck<S, R> =
	IsFamilyMember<S, R> extends true
		? Refusal<"delta.met names no family's members: their additions are their family statement's, which meets no stored fact at an arbiter key">
		: DeltaCheck<S, R>

export interface Delta<S> {
	/** Facts of R this application made present. */
	added<R extends (AnyRelation | AnyWorld) & Headed<Carriers>>(
		relation: R & DeltaCheck<S, R>
	): DeltaSource<R>
	/** Facts of R this application made absent. */
	removed<R extends (AnyRelation | AnyWorld) & Headed<Carriers>>(
		relation: R & DeltaCheck<S, R>
	): DeltaSource<R>
	/**
	 * Stored facts of R this application's insertions met at their arbiter key and did not refuse, each whole as stored:
	 * an exact repeat, equal to the inserted fact at every field it states, a field the database draws taken from the
	 * stored fact. A fact an earlier write of the application added is added, never met.
	 */
	met<R extends (AnyRelation | AnyWorld) & Headed<Carriers>>(
		relation: R & MetCheck<S, R>
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
 * is over the higher of the two schemas (HigherLevel). Levels form one chain, so of two schemas either one is a level
 * of the other or they do not combine.
 */
type LevelCheck<H> = [H] extends [never]
	? Refusal<"the ChangeSets' schemas are not levels of one another">
	: unknown

/** A ChangeSet over S taken over the role whose least level is X (ChangeSet.over): S is one of X's levels. */
type OverCheck<X, S> =
	IsLevelOf<X, S> extends true
		? unknown
		: Refusal<"ChangeSet.over takes a ChangeSet over a level of its role">

/** Whether two read-backs' rows are of one type: each assignable to the other. */
type SameRows<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * A read-back name reads one query across a whole ChangeSet, its strata and unions included, the builder's read-back
 * set (write/changeset/value.ts readBackSet): a read of a name the ChangeSet already reads, and a union or sequence of
 * ChangeSets that read one name, are one read-back where the queries are one. The types see a query's rows, never its
 * identity, so they refuse one name over rows of two types; the builder refuses one name over two queries.
 */
type ReadNameCheck<Name extends string, Reads, IHead> = Name extends keyof Reads
	? SameRows<Reads[Name], ReadonlyArray<IHead>> extends true
		? unknown
		: Refusal<"a read-back name reads one query: this ChangeSet already reads this name, over rows of another type">
	: unknown
/** A read-back's name: one literal, the key of its rows in the outcome's record, and a name the ChangeSet reads already
 * only over rows of the same type. */
export type ReadName<Name extends string, Reads, IHead> = OneName<Name> &
	ReadNameCheck<Name, Reads, IHead>
/**
 * The read-backs of two ChangeSets, or of a ChangeSet and one read, as one set: every name either reads, a name both
 * read once, at the first's rows, which are the second's (ReadNameCheck, OneQueryReads).
 */
export type JointReads<A, B> = Simplify<A & Omit<B, keyof A>>
/** The names two ChangeSets both read whose rows are of two types. */
type ClashingReads<A, B> = {
	readonly [K in keyof A & keyof B]: SameRows<A[K], B[K]> extends true ? never : K
}[keyof A & keyof B]
type OneQueryReads<A, B> = [ClashingReads<A, B>] extends [never]
	? unknown
	: Refusal<"a read-back name reads one query: the ChangeSets read one name over rows of two types">

export interface ChangeSetConstructor {
	empty<S extends AnySchema | AnyFragment | AnyRole>(
		schema: S
	): ChangeSetOf<S, unknown, never, unknown, never, readonly [], Unwritten>
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
		a: ChangeSetOf<SA, P1, W1, R1, C1, D1, L1, A1>,
		b: ChangeSetOf<SB, P2, W2, R2, C2, D2, L2, A2> &
			LevelCheck<HigherLevel<SA, SB>> &
			OneQueryReads<R1, R2> &
			UnionEdits<D1, L1, D2, L2> &
			UnionDoomed<D1, L1, D2, L2>
	): ChangeSetOf<
		HigherLevel<SA, SB>,
		JointParams<P1, P2>,
		W1 | W2,
		JointReads<R1, R2>,
		C1 | C2,
		Leading<Aligned<readonly [...D1, L1], readonly [...D2, L2]>>,
		Final<Aligned<readonly [...D1, L1], readonly [...D2, L2]>>,
		A1 | A2
	>
	/**
	 * A ChangeSet over a level of a role, as one over the role: the empty ChangeSet over `role` unioned with `cs`, its
	 * strata, parameters, writes and read-backs `cs`'s, as union builds it. The role may be a parameter, for a program a
	 * library applies through whatever role over its level it is given, bounded by that level,
	 * `<W extends RoleOver<typeof Level>>(role: W) => ChangeSet.over(role, program)`: the call checks `cs`'s schema a
	 * level of the bound's least level (Least, read off the bound's `least` member, RoleLeastStated), the one level the
	 * call knows, where union's HigherLevel waits on the parameter; over a built role, a level of the role itself, so a
	 * role of which it is no level is refused (OverCheck). A union or sequence of ChangeSets over a role parameter waits on
	 * it as union's does, so a library builds its program over its level and takes it over the role last.
	 */
	over<
		W extends AnyRole,
		S,
		P,
		Wr extends string,
		R,
		C,
		D extends Strata,
		L extends Stratum,
		A,
		Least extends AnySchema | AnyFragment = never
	>(
		role: W & RoleLeastStated<Least>,
		cs: ChangeSetOf<S, P, Wr, R, C, D, L, A> & OverCheck<RoleLeastOf<W, Least>, S>
	): ChangeSetOf<W, P, Wr, R, C, D, L, A>
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
		a: ChangeSetOf<SA, P1, W1, R1, C1, D1, L1, A1>,
		b: ChangeSetOf<SB, P2, W2, R2, C2, D2, L2, A2> &
			LevelCheck<HigherLevel<SA, SB>> &
			OneQueryReads<R1, R2> &
			EditsRefusal<[EditsIn<D1, L1>, EditsIn<D2, L2>] extends [true, true] ? true : false>
	): ChangeSetOf<
		HigherLevel<SA, SB>,
		JointParams<P1, P2>,
		W1 | W2,
		JointReads<R1, R2>,
		C1 | C2,
		readonly [...D1, L1, ...D2],
		L2,
		A1 | Shifted<A2, readonly [...D1, L1]>
	>
}

/**
 * A key value a witness may carry: a vector field may be a key field, and a digest's 32 bytes (public/fields.ts Sha256),
 * which a key holds by content, its key text its one text (core/digest.ts sha256Text).
 */
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
	| Uint8Array

/**
 * What a law's refusal names: the violating fact's key, or why it names none.
 *
 * - `key`: one violating fact's relation and its key values, never a payload column. A write statement's refusal names
 *   the key you submitted, in the fields you wrote it in, a collision with a fact outside the written entry included. A
 *   deferred foreign key's refusal at COMMIT names the primary key of the least row it leaves unmatched, which the
 *   write's statements sent again in a transaction that rolls back leave (README "Errors and outcomes", Witness).
 * - `unreported`: every law is a native constraint, and a violation PostgreSQL raised itself states its key only in
 *   its message, which the runtime neither forwards nor parses: where the host finds no row the ChangeSet states that
 *   breaks it, or cannot tell which of several did, as two family owners the write inserts without reading them, either
 *   of which may be a stored one inserted again; and a deferred foreign key's refusal at COMMIT on a table the write
 *   does not change, or one the role reads, or whose target it reads, through a query or scoped entry alone.
 * - `unreproduced`: a deferred foreign key refused the write at COMMIT, and the write's statements sent again in a
 *   transaction that rolls back left no row that key leaves unmatched: another transaction's commit changed the state
 *   between the two, so the key the refusal met is gone, and none is guessed.
 */
export type Witness =
	| {
			readonly kind: "key"
			readonly relation: string
			readonly values: Readonly<Record<string, KeyHost>>
	  }
	| { readonly kind: "unreported" }
	| { readonly kind: "unreproduced" }

/**
 * Which laws an `invariant-rejected` outcome names, each with its identity and the object that refused it (RefusedLaw),
 * and how grizzle decided them. `every`, `first` and `some` name only laws of the Db's own levels, PostgreSQL having
 * named one of them, and a table's CHECKs are its own levels' CHECKs, whatever a level above installs on it:
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
 * - `above`: PostgreSQL named an object of a level above the Db's own, which the Db's host holds no predicate of, and
 *   `above` is every law of those levels it serves, each once, in code point order of their identities: one where it
 *   serves one, and where it serves several (a key's index under a count's fold and its family's counted law), at least
 *   one of them the row broke, as `some` says of the Db's own, and nothing is said of any other law above. `own` is what
 *   the host finds of its own levels' CHECKs on the rows the refused statement states of that table: `every`, `laws`,
 *   every rule of them the first stated row that breaks one breaks, each judged, as the refusal would name them were no
 *   law above installed, that row the witness; `none`, every row the statement writes is a stated one and holds every
 *   one of them; `unjudged`, nothing is said of them: a refusal at COMMIT, by a foreign key or a rule over a query
 *   above, a row the ChangeSet does not state, or a CHECK the host cannot evaluate there. Only `every` holds `laws`.
 */
export type BrokenLaws =
	| { readonly kind: "every" | "first"; readonly laws: readonly [RefusedLaw, ...Array<RefusedLaw>] }
	| {
			readonly kind: "some"
			readonly laws: readonly [RefusedLaw, RefusedLaw, ...Array<RefusedLaw>]
	  }
	| {
			readonly kind: "above"
			readonly own: "every"
			readonly above: readonly [AboveRefusedLaw, ...Array<AboveRefusedLaw>]
			readonly laws: readonly [RefusedLaw, ...Array<RefusedLaw>]
	  }
	| {
			readonly kind: "above"
			readonly own: "none" | "unjudged"
			readonly above: readonly [AboveRefusedLaw, ...Array<AboveRefusedLaw>]
	  }

/**
 * A law of a schema with its identity: the law as the schema states it (`law`) and its identity (`id`), a theory law's
 * or a text pattern's the key of the snapshot's theory.laws and a generated field's the one its derived facts hold.
 * lawsOf lists a schema's, and a refusal names each law it breaks as one (RefusedLaw).
 */
export interface IdentifiedLaw<L extends Law = Law> {
	readonly law: L
	readonly id: LawId | GeneratedLawId
}

/**
 * One law a refusal names: the law with its identity (IdentifiedLaw), and the installed object that refused it (`by`).
 * L is a law of the Db's own levels, or, for a law of a level above the object PostgreSQL named serves, that law (AboveRefusedLaw).
 */
export interface RefusedLaw<L extends Law = OwnLaw> extends IdentifiedLaw<L> {
	readonly by: RefusingObject
}

/** The law of a level above the Db's own that PostgreSQL named refusing a write (BrokenLaws `above`). */
export type AboveRefusedLaw = RefusedLaw<AboveLaw>

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
 * What a law states, as the schema states it: its identity, which an application matches on directly, and which OwnLaw
 * names with its catalog entry (LawEntry).
 *
 * - `primaryKey`: a relation's primary key, by its fields (a span field makes it a nonoverlap key);
 * - `key`: a key statement, key(side), by its side: a candidate key of the relation when the side reads every fact
 *   and its terms are fields (a span field makes it a nonoverlap key), and otherwise a key over the facts the side
 *   reads. A side (ir/desc.ts SideDesc, the public LawSide) is its relation, its terms in the order the statement pairs
 *   them, each a field or pred of a natural field, and its selection's conjuncts, each a row predicate in its
 *   canonical form (schema/own.ts canonicalSelection), in canonical order: none reads every fact;
 * - `check`: a relation's row check, by its name;
 * - `contained`: a containment, a foreign key included, from its source side into its target side (a mirrors is two);
 * - `coverage`: a containment whose sides pair a span field, the source's span covered by the target's;
 * - `family`: an ordered or counted family, by its member side and its owner's slots: each owner's members indexed by
 *   exactly 0 … n − 1 (an alternatives law states plain containments, each a `contained` law);
 * - `tree`: a tree, by its member side, its slots and its root fields: the rows of each value of its root fields one
 *   tree in pre-order;
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
 *
 * Two laws of one schema state the same exactly when they are one law.
 */
export type StatedLaw =
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
			readonly root: NonEmptyReadonlyArray<string>
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

/**
 * A law's catalog entry: the name an application calls the law by and the source its statement comes from, a required
 * part of every law, outside its identity: its LawId, the schema's fingerprint and the installation read none of it, so
 * an entry changed is no migration, only the artifacts that record it written again.
 *
 * - `declared`: the schema's author states it at the law's statement, `law({ name, source }, statement)`, each text as
 *   written: a catalog's name for the law, say, and the specification section it reads;
 * - `derived`: the schema's author states none, and grizzle derives both from the law's declaration as its statement
 *   states it (runtime/law-entry.ts derivedEntry): `name` the law as grizzle names it, a check and a contract by their
 *   own names, and `source` the statement that states it, as grizzle spells it.
 */
export interface LawEntry {
	readonly kind: "declared" | "derived"
	readonly name: string
	readonly source: string
}

/** A catalog entry the schema's author declares (LawEntry `declared`). */
export type DeclaredEntry = LawEntry & { readonly kind: "declared" }

/**
 * What a statement's author states of the catalog entry (types/changeset LawEntry) of the laws it states: the entry,
 * `law({ name, source }, statement)`'s, or none, so each law's entry is derived. A law is named where it is read (runtime/law-entry.ts): an
 * author's entry rides beside what the law states (RecordedLaw), and every other law's is derived there, from what the
 * law states, wherever the law is read, lawsOf, a preview's refusal and a Db's refusal naming each by namedLaw, so a
 * recorded law and the law an application reads differ by a derived entry alone, which no artifact holds.
 */
export type StatedEntry = DeclaredEntry | { readonly kind: "derived" }

/**
 * A law as the schema states it and names it, which an `invariant-rejected` outcome names: what it states (StatedLaw),
 * which an application matches on directly, and its catalog entry (`entry`), the same arm shape for every kind.
 *
 * Every law of a schema S is one of `lawsOf(S)`, with the same entry. A Db over S names these as its own; a law of a
 * level above S, it names as an AboveLaw.
 */
export type OwnLaw = StatedLaw & { readonly entry: LawEntry }

/**
 * A law as grizzle's artifacts record it, snapshot.json's level laws and a served file's key laws: what it states, with
 * its entry only where its schema's author declares one. A derived entry is derived again wherever the law
 * is read (runtime/law-entry.ts namedLaw) and never written, so a schema whose author declares none records its laws
 * exactly as they state themselves.
 */
export type RecordedLaw = StatedLaw | (StatedLaw & { readonly entry: DeclaredEntry })

/**
 * A law of `level`, a level above the schema a Db is over, as that level states and names it (`law`): a Db over a lower
 * level holds none of the code of the levels above it, so a refusal by one of their laws, a row check over one of its
 * relations, a foreign key into its relations or a rule over a query reading them, names the level that states it. A
 * served file records it with the law as recorded (`L` RecordedLaw), and an outcome names it with its entry.
 */
export interface AboveLaw<L extends RecordedLaw = OwnLaw> {
	readonly kind: "above"
	readonly level: string
	readonly law: L
}

/** A law an outcome names: one of the Db's own levels' (OwnLaw), or one of a level above them (AboveLaw). */
export type Law = OwnLaw | AboveLaw
