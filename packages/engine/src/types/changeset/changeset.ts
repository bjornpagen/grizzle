import type { Stream } from "effect"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type { MonoidName, SideDesc, SlotsDesc } from "#compiler/ir/desc.ts"

/** One side of a law as an outcome names it: its statement's side, as its Description states it (ir/desc.ts). */
export type { SideDesc as LawSide } from "#compiler/ir/desc.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"
import type {
	Carriers,
	DomainOf,
	Headed,
	InputTerm,
	Invariant,
	IsRetyped,
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
	StatementsOf
} from "#compiler/types/schema/schema.ts"
import type {
	AnyTerm,
	DrawnFieldOf,
	Fin,
	Ordered,
	Side,
	Tree
} from "#compiler/types/schema/statements.ts"
import type {
	AnyWorld,
	WorldSerialFields,
	WorldUnwrittenFields,
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
		? [UnfitArms<H, F>] extends [never]
			? [MistypedFields<M, R>] extends [never]
				? unknown
				: Refusal<"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast">
			: Refusal<"the query's head is not a fact of the relation">
		: M extends ReadonlyArray<infer E> | Stream.Stream<infer E, unknown, unknown>
			? [UnfitArms<E, F>] extends [never]
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
 * fact of the relation (MemberCheck), or a term of F's identity and SQL type exactly, as the checker compares a member
 * column with its field (scalar/compute/types.ts compatible), whatever its values, facts and language.
 */
type WritesAt<X, F> =
	IsRetyped<X> extends true
		? true
		: [InputTerm<DomainOf<X>, unknown, unknown, SqlOfCarrier<X>>] extends [
					InputTerm<DomainOf<F>, unknown, unknown, SqlOfCarrier<F>>
			  ]
			? true
			: false

type UnfitArms<H, F> = H extends unknown ? ([FitsAnArm<H, F>] extends [never] ? H : never) : never
type FitsAnArm<Ha, F> = F extends unknown
	? [Ha] extends [F]
		? [Exclude<SuppliedKeys<Ha>, keyof F>] extends [never]
			? [NestedUnfit<Ha, F>] extends [never]
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
 */
type NestedUnfit<Ha, F> = {
	[K in keyof Ha & keyof F]-?: F[K] extends ReadonlyArray<infer Fe extends object>
		? Ha[K] extends ReadonlyArray<infer He>
			? UnfitArms<He, Fe>
			: never
		: never
}[keyof Ha & keyof F]

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
 * The sequences of S whose owner is R: one pass over S's sequences per owner, whose few sequences the owner's addition
 * then maps by their count fields.
 */
type SequencesOwnedBy<S, R> = Extract<
	SequenceOf<S>,
	{ readonly slots: Fin<{ readonly name: NameOf<R> }, string> }
>

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

/** The parent field of R where R is a tree's: grizzle sets it, the root's to itself and a member's by its nesting. */
type TreeParentOf<S, R> = TreeParent<
	Extract<SequenceOf<S>, Tree<Side<{ readonly name: NameOf<R> }>, unknown, string>>
>

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
 * Seen stops the walk at a tree, a family of its relation over itself.
 */
export type NestedWrites<S, R, Seen = never> = [R] extends [Seen]
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
	Cx = never
> extends Phantom<{
	readonly params: Params
	readonly paramsInvariant: Invariant<Params>
	readonly writes: Writes
	readonly contexts: Cx
	readonly schema: Invariant<S>
}> {
	/** The decoder of the outcome's read-backs, by name. */
	readonly reads: RowDecoder<Reads>
	/**
	 * Adds each member fact, with its sequences' members nested in order at its count fields (AdditionIn): every nested
	 * member relation is written too. A counted family's member is a row of its own relation, inserted directly, its
	 * group key naming its owner; grizzle draws every count, index, interval, copy and accumulator.
	 */
	insert<R extends AnyRelation | AnyWorld, const M extends Member<S, AdditionIn<S, R>>>(
		relation: R & WritableCheck<S, R> & NotSequenceMember<S, R>,
		facts: M & MemberCheck<M, AdditionIn<S, R>, R>
	): ChangeSet<
		S,
		Simplify<Params & ParamsOf<M>>,
		Writes | NameOf<R> | NestedWrites<S, R>,
		Reads,
		Cx | ContextsOf<M>
	>
	/**
	 * Removes each member fact, stated as its caller writes it (Written<R>): the fields PostgreSQL and grizzle write are
	 * no part of a fact's identity a caller states, so an insert and a delete of one fact state one row.
	 */
	delete<R extends AnyRelation | AnyWorld, const M extends Member<S, Written<R>>>(
		relation: R & WritableCheck<S, R>,
		facts: M & MemberCheck<M, Written<R>, R>
	): ChangeSet<S, Simplify<Params & ParamsOf<M>>, Writes | NameOf<R>, Reads, Cx | ContextsOf<M>>
	/**
	 * After the change, R's fact at each member's key is that member, with the fields its caller does not write as
	 * PostgreSQL and grizzle write them. For every relation it is the row its caller writes (Written<R>): an owner's put
	 * leaves its families as they are, and a member's put is an edit of its family, in place, a refill from its slot or
	 * a move between groups, which grizzle plans.
	 */
	put<R extends AnyRelation | AnyWorld, const M extends Member<S, Written<R>>>(
		relation: R & WritableCheck<S, R>,
		facts: M & MemberCheck<M, Written<R>, R>
	): ChangeSet<S, Simplify<Params & ParamsOf<M>>, Writes | NameOf<R>, Reads, Cx | ContextsOf<M>>
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
		Simplify<Params & ParamsOf<Q>>,
		Writes,
		Simplify<Reads & { readonly [K in Name]: ReadonlyArray<IHead> }>,
		Cx | ContextsOf<Q>
	>
	bind(params: ParamArg<Params>): ChangeSet<S, unknown, Writes, Reads, Cx>
}

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
 * (`deltaOf`, a phantom no value carries).
 */
export interface DeltaSource<R extends Headed<Carriers>>
	extends Source<Fact<R>>, Headed<R["heading"]> {
	readonly deltaOf?: Invariant<R>
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
	empty<S extends AnySchema>(schema: S): ChangeSet<S>
	/** The commutative combination: one add-wins transition. */
	union<SA, SB, P1, P2, W1 extends string, W2 extends string, R1, R2, C1, C2>(
		a: ChangeSet<SA, P1, W1, R1, C1>,
		b: ChangeSet<SB, P2, W2, R2, C2> & LevelCheck<HigherLevel<SA, SB>> & DisjointReads<R1, R2>
	): ChangeSet<HigherLevel<SA, SB>, Simplify<P1 & P2>, W1 | W2, Simplify<R1 & R2>, C1 | C2>
	/**
	 * Strata: b is evaluated against the state a produced. The result is over the higher of the two schemas, each of
	 * which is a level of it. Strata are associative, so three are sequence(sequence(a, b), c).
	 */
	sequence<SA, SB, P1, P2, W1 extends string, W2 extends string, R1, R2, C1, C2>(
		a: ChangeSet<SA, P1, W1, R1, C1>,
		b: ChangeSet<SB, P2, W2, R2, C2> & LevelCheck<HigherLevel<SA, SB>> & DisjointReads<R1, R2>
	): ChangeSet<HigherLevel<SA, SB>, Simplify<P1 & P2>, W1 | W2, Simplify<R1 & R2>, C1 | C2>
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
	| Vector

/**
 * What a law's refusal names: the violating fact's key, or why it names none.
 *
 * - `key`: one violating fact's relation and its key values, never a payload column. A write statement's refusal names
 *   the key you submitted, in the fields you wrote it in, a collision with a fact outside the written entry included.
 * - `unreported`: every law is a native constraint, and a violation PostgreSQL raised itself states its key only in
 *   its message, which the runtime neither forwards nor parses.
 */
export type Witness =
	| {
			readonly kind: "key"
			readonly relation: string
			readonly values: Readonly<Record<string, KeyHost>>
	  }
	| { readonly kind: "unreported" }

/**
 * A law as the schema states it, which an `invariant-rejected` outcome names: an application matches on it directly.
 *
 * - `primaryKey`: a relation's primary key, by its fields (a span field makes it a nonoverlap key);
 * - `key`: a key statement, key(side), by its side: a candidate key of the relation when the side reads every fact
 *   and its terms are fields (a span field makes it a nonoverlap key), and otherwise a key over the facts the side
 *   reads. A side (ir/desc.ts SideDesc, the public LawSide) is its relation, its terms in the order the statement pairs
 *   them, each a field or pred of a natural field, and its selection's conjuncts, each a row predicate as its
 *   Description states it, in canonical order: none reads every fact;
 * - `check`: a relation's row check, by its name;
 * - `contained`: a containment, a foreign key included, from its source side into its target side (a mirrors is two);
 * - `coverage`: a containment whose sides pair a span field, the source's span covered by the target's;
 * - `family`: an ordered or counted family, by its member side and its owner's slots: each owner's members indexed by
 *   exactly 0 … n − 1 (an alternatives law states plain containments, each a `contained` law);
 * - `tree`: a tree, by its member side, its slots and its root field: each root field's rows one tree in pre-order;
 * - `fold`: a fold, by its family's slots, its monoid and its step and end sides: each owner's ends its members'
 *   combination;
 * - `contract`: a contract's predicate, by its name;
 * - `pattern`: a text pattern (str.regex), as its domain spells it: one law for every spelling of the same language.
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
	| { readonly kind: "pattern"; readonly source: string; readonly flags: "u" | "su" }
