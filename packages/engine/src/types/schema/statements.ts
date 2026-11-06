import type { MonoidName } from "#compiler/ir/desc.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { ScalarHelpers } from "#compiler/types/compute/compute.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	DomainOf,
	Headed,
	Origin,
	Refusal,
	SqlOfCarrier
} from "#compiler/types/core/phantom.ts"
import type {
	AccumulatedField,
	BitsField,
	DrawnField,
	FieldBase,
	HandleOf,
	WritingTag
} from "#compiler/types/fields/field.ts"
import type {
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	Fact,
	NameOf
} from "#compiler/types/schema/relation.ts"

/**
 * pred(field), a law side's term over a natural field: the field's value less one, defined only where the value is
 * above zero, so a fact whose field is zero has no tuple on the side. It is one level deep: no term is pred of a pred.
 */
export interface Pred<F extends string> {
	readonly kind: "pred"
	readonly field: F
}

/** Any term of a law side: a field's name, or pred of one. */
export type AnyTerm = string | Pred<string>

/**
 * A candidate key of the ordinary relation R: a Key over a side of the whole relation whose terms are fields. A key
 * over a selection or a pred term constrains only the facts its side reads, so it is no key of the relation, and a
 * closed relation is keyed by its handle alone.
 */
export type CandidateKey<R extends AnyRelation> = Key<Side<R, ReadonlyArray<string>>>

/** In key position a relation stands for its primary key, and a candidate key for itself. */
export type KeyRef<R extends AnyRelation> = R | CandidateKey<R>

/**
 * key(side): no two of the side's facts share its tuple of terms, UNIQUE NULLS DISTINCT over them. Over a whole
 * relation and its fields it is a candidate key of the relation; over a selection or a pred term it constrains only
 * the facts the side reads.
 */
export interface Key<S> {
	readonly kind: "key"
	readonly side: S
}

export interface Mutable<R> {
	readonly kind: "mutable"
	readonly relation: R
}

export interface Check<Name extends string, R> {
	readonly kind: "check"
	readonly name: Name
	readonly relation: R
}

/**
 * A law side: a relation, closed relation or selection projected onto terms, in order, a partial projection: a fact
 * whose pred term is undefined has no tuple on it. Side is covariant, so AnySide is every side.
 */
export interface Side<R, T extends ReadonlyArray<AnyTerm> = ReadonlyArray<AnyTerm>> {
	readonly source: R
	readonly terms: T
}
export type AnySide = Side<unknown>

/**
 * select(R, predicate): the facts of R a row predicate over their own fields holds of. The predicate is the
 * selection's Description's, which no type reads: an alternatives arm's handle is read from the alternatives law
 * (types/evidence ArmProofOf).
 */
export interface Selection<R> {
	readonly relation: R
}

/**
 * Statements: keys, mutability, checks, law sides, containment, mirrors, alternatives, families, trees and folds. The
 * constructors are the typed schema facade's (schema/api.ts), written under these types over the admission cores of
 * packages/engine/src/schema.
 *
 * Every statement type carries the types of what it names, so the schema's captured statement tuple can be read back.
 * Statement constructors accept only ordinary relations (and
 * closed relations where a law side may be one), never a derived relation, so a law over a derived relation does not
 * typecheck.
 */
export interface Containment<L = Side<unknown>, R = Side<unknown>> {
	readonly kind: "contained"
	readonly left: L
	readonly right: R
}

/** mirrors(a, b): sugar for both containments, contained(a, b) and contained(b, a); a schema states those two. */
export interface Mirrors<L = Side<unknown>, R = Side<unknown>> {
	readonly kind: "mirrors"
	readonly left: L
	readonly right: R
}

/**
 * fin(O, n): the slots of O's count n, the facts (key(o), i) for 0 ≤ i < o.n: over an ordinary O, whose drawn count a
 * family draws, a family's second argument; over a closed O, whose natural field counts them, the slots a closed
 * relation's key field holds (Slot). Never a law side and never a schema member.
 */
export interface Fin<O, N extends string> {
	readonly kind: "fin"
	readonly owner: O
	readonly count: N
}
export type AnyFin = Fin<unknown, string>

/**
 * slot(type, fin(O, n)): a closed relation's key field of `type`, a closed id, holding one of fin(O, n)'s slots, O a
 * closed relation whose key pairs with the key's first fields. It is the field `type` is, read as `type` reads, and its
 * codes are slots, each owner's from 0 below its count.
 */
export type SlotField<F, Fi> = F & { readonly slots: Fi }

/** ordered(on(F, g…, i), fin(O, n)): each owner's members indexed by their drawn index i, exactly 0 … n − 1. */
export interface Ordered<F, Fi> {
	readonly kind: "ordered"
	readonly family: F
	readonly slots: Fi
}

/** counted(on(F, g…), fin(O, n)): each owner's n members, whose index is hidden and in no heading. */
export interface Counted<F, Fi> {
	readonly kind: "counted"
	readonly family: F
	readonly slots: Fi
}

/**
 * tree(on(T, "parent", "at"), fin(T, "children"), { root: r }): the ordered family of T over itself, every row but
 * the self-parented root a member, with T's drawn `start` and `end` its pre-order interval and r the caller's field
 * each tree's rows share.
 */
export interface Tree<F, Fi, Root extends string> {
	readonly kind: "tree"
	readonly family: F
	readonly slots: Fi
	readonly root: Root
}

/** Any family: each is covariant in what it names. */
export type AnyFamily =
	| Ordered<unknown, unknown>
	| Counted<unknown, unknown>
	| Tree<unknown, unknown, string>

/** A closed monoid a fold combines by: twos keeps two planes (ones and twos), the others one. */
export interface Monoid<M extends MonoidName> {
	readonly kind: "monoid"
	readonly name: M
	readonly planes: M extends "twos" ? 2 : 1
}
export type AnyMonoid = Monoid<MonoidName>

/**
 * fold(family, Monoid.m, step, end): the family's members' step values combined by the monoid in slot order, each
 * owner's result in its end fields.
 */
export interface Fold<Fa, M, S, E> {
	readonly kind: "fold"
	readonly family: Fa
	readonly monoid: M
	readonly step: S
	readonly end: E
}

/** A key lists no set: a set's bit string is wider than an index entry holds. */
export type NoSetKey<S> =
	S extends Side<infer Src, infer T>
		? [Extract<T[number], string> & SetFieldOf<SideRelation<Src>>] extends [never]
			? unknown
			: Refusal<"a key lists no set: a set's bit string is too wide for an index entry">
		: unknown

type SetFieldOf<R> =
	R extends Headed<infer C>
		? { [K in keyof C]-?: C[K] extends BitsField<unknown> ? K : never }[keyof C] & string
		: never

/** The fields of R its family or tree draws: its drawn naturals, read off its heading. */
export type DrawnFieldOf<R> =
	R extends Headed<infer C>
		? { [K in keyof C]-?: C[K] extends DrawnField ? K : never }[keyof C] & string
		: never

/**
 * The fields of O that may count fin(O, n)'s slots: an ordinary relation's drawn naturals, which a family draws, and a
 * closed relation's naturals, which its declaration states.
 */
export type CountFieldOf<O> = O extends AnyClosedRelation ? NaturalFieldOf<O> : DrawnFieldOf<O>

/** The fields of R its caller writes: those whose descriptor states no writing of its own. */
type CallerFieldOf<R> =
	R extends Headed<infer C>
		? { [K in keyof C]-?: C[K] extends { readonly writing: WritingTag } ? never : K }[keyof C] &
				string
		: never

/** The join types of R's fields T, in order. */
type TypesOf<R, T> = { readonly [I in keyof T]: FieldTypeOf<R, T[I]> }

type PrimaryKeyOf<O> = O extends { readonly primaryKey: infer P extends ReadonlyArray<string> }
	? P
	: never

/** Whether R's fields G have the types of O's primary key, in order: a family's group pairs with its owner's key. */
type GroupOfOwner<R, G, O> = [TypesOf<R, G>] extends [TypesOf<O, PrimaryKeyOf<O>>]
	? [TypesOf<O, PrimaryKeyOf<O>>] extends [TypesOf<R, G>]
		? true
		: false
	: false

/** The owner a family's slots count over. */
type OwnerOfSlots<Fi> = Fi extends Fin<infer O, string> ? O : never

/** An ordered family's side is its owner's key, then its drawn index. */
export type OrderedMember<F, Fi> =
	F extends Side<
		infer R,
		readonly [...infer G extends ReadonlyArray<AnyTerm>, infer I extends AnyTerm]
	>
		? GroupOfOwner<R, G, OwnerOfSlots<Fi>> extends true
			? I extends DrawnFieldOf<R>
				? unknown
				: Refusal<"an ordered family's side is its owner's key, then its drawn index">
			: Refusal<"an ordered family's side is its owner's key, then its drawn index">
		: Refusal<"an ordered family's side is its owner's key, then its drawn index">

/** A counted family's side is its owner's key. */
export type CountedMember<F, Fi> =
	F extends Side<infer R, infer G>
		? GroupOfOwner<R, G, OwnerOfSlots<Fi>> extends true
			? unknown
			: Refusal<"a counted family's side is its owner's key">
		: Refusal<"a counted family's side is its owner's key">

/**
 * A tree is a family of T over itself, on(T, parent, at) with fin(T, n): parent of T's one-field primary key's type,
 * and at, n, start and end drawn.
 */
export type SelfFamily<F, Fi> =
	F extends Side<infer T, readonly [infer P extends AnyTerm, infer I extends AnyTerm]>
		? SameRelation<T, OwnerOfSlots<Fi>> extends true
			? GroupOfOwner<T, readonly [P], T> extends true
				? [I | CountOfSlots<Fi> | "start" | "end"] extends [DrawnFieldOf<T>]
					? unknown
					: Refusal<"a tree is a family of T over itself, on(T, parent, at), with drawn start and end">
				: Refusal<"a tree is a family of T over itself, on(T, parent, at), with drawn start and end">
			: Refusal<"a tree is a family of T over itself, on(T, parent, at), with drawn start and end">
		: Refusal<"a tree is a family of T over itself, on(T, parent, at), with drawn start and end">

type CountOfSlots<Fi> = Fi extends Fin<unknown, infer N> ? N : never

/** A tree's root field is a caller's field of its relation. */
export type TreeRootOf<F, Root> =
	F extends Side<infer T>
		? Root extends CallerFieldOf<T>
			? unknown
			: Refusal<"a tree's root field is a caller's field of its relation">
		: Refusal<"a tree's root field is a caller's field of its relation">

/** A family's member relation and group terms, and its owner. */
type MemberOf<Fa> =
	Fa extends Ordered<
		Side<infer R, readonly [...infer G extends ReadonlyArray<AnyTerm>, AnyTerm]>,
		infer Fi
	>
		? {
				readonly relation: R
				readonly group: G
				readonly owner: OwnerOfSlots<Fi>
				readonly hidden: false
			}
		: Fa extends Counted<Side<infer R, infer G extends ReadonlyArray<AnyTerm>>, infer Fi>
			? {
					readonly relation: R
					readonly group: G
					readonly owner: OwnerOfSlots<Fi>
					readonly hidden: true
				}
			: Fa extends Tree<
						Side<infer R, readonly [infer P extends AnyTerm, AnyTerm]>,
						infer Fi,
						string
				  >
				? {
						readonly relation: R
						readonly group: readonly [P]
						readonly owner: OwnerOfSlots<Fi>
						readonly hidden: false
					}
				: never

/** The SQL types a monoid's step value may be of: exact numbers for sum, sets for or and twos, least-valued ones for max. */
type MonoidSql = {
	readonly count: never
	readonly sum: "smallint" | "integer" | "bigint" | "numeric" | "money"
	readonly or: "bits"
	readonly twos: "bits"
	readonly max: "smallint" | "integer" | "bigint" | "code" | "money"
	readonly concat: "text"
}

type NameOfMonoid<M> = M extends Monoid<infer N> ? N : never

/** An accumulator of R's field X's type: an accumulated field of R whose domain and SQL type are X's. */
type Accumulator<R, A, X> =
	FieldOfHeading<R, A> extends AccumulatedField<FieldBase>
		? [FieldTypeOf<R, A>] extends [X]
			? [X] extends [FieldTypeOf<R, A>]
				? true
				: false
			: false
		: false

type FieldOfHeading<R, K> = R extends Headed<infer C> ? (K extends keyof C ? C[K] : never) : never

/** The accumulators a step names after its value: none, or one (before, after) pair per plane, of the value's type. */
type Accumulators<R, Rest, X, Planes> = Rest extends readonly []
	? true
	: Rest extends readonly [infer B, infer A]
		? Planes extends 1
			? [Accumulator<R, B, X>, Accumulator<R, A, X>] extends [true, true]
				? true
				: false
			: false
		: Rest extends readonly [infer B1, infer A1, infer B2, infer A2]
			? Planes extends 2
				? [
						Accumulator<R, B1, X>,
						Accumulator<R, A1, X>,
						Accumulator<R, B2, X>,
						Accumulator<R, A2, X>
					] extends [true, true, true, true]
					? true
					: false
				: false
			: false

/** count's value and accumulators are naturals. */
type NaturalType = readonly [bigint, "bigint"]

/**
 * A fold's step: the family's member side (or a selection of it), its group, then its value (none for count) of a type
 * the monoid admits, then none or one accumulated (before, after) pair per plane of the value's type; over a counted
 * family, no pair, since a visible accumulator would show the hidden order.
 */
export type FoldStep<Fa, M, S> =
	S extends Side<infer Src, infer T>
		? SameRelation<SideRelation<Src>, MemberOf<Fa>["relation"]> extends true
			? T extends readonly [...MemberOf<Fa>["group"], ...infer Rest]
				? StepRest<MemberOf<Fa>, NameOfMonoid<M>, M, Rest>
				: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">
			: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">
		: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">

type StepRest<Mb extends MemberShape, N extends MonoidName, M, Rest> = N extends "count"
	? PairsAllowed<Mb, Accumulators<Mb["relation"], Rest, NaturalType, 1>, Rest>
	: Rest extends readonly [infer X, ...infer Pairs]
		? FieldTypeOf<Mb["relation"], X> extends readonly [unknown, MonoidSql[N]]
			? PairsAllowed<
					Mb,
					Accumulators<Mb["relation"], Pairs, FieldTypeOf<Mb["relation"], X>, PlanesOf<M>>,
					Pairs
				> &
					InOrder<Mb, N, Pairs>
			: Refusal<"the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text">
		: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">

type MemberShape = {
	readonly relation: unknown
	readonly group: ReadonlyArray<AnyTerm>
	readonly owner: unknown
	readonly hidden: boolean
}

type PlanesOf<M> = M extends Monoid<infer N> ? (N extends "twos" ? 2 : 1) : never

/**
 * concat, text's free monoid, depends on its members' order: a counted family, whose order is hidden, is refused it,
 * and a sequence names its (before, after) pair, through which its law reads each member's running value.
 */
type InOrder<Mb extends MemberShape, N extends MonoidName, Pairs> = N extends "concat"
	? Mb["hidden"] extends true
		? Refusal<"a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree">
		: Pairs extends readonly []
			? Refusal<"a concat fold names its (before, after) pair after its value: its law reads each member's running value">
			: unknown
	: unknown

type PairsAllowed<Mb extends MemberShape, Holds, Pairs> = Holds extends true
	? Mb["hidden"] extends true
		? Pairs extends readonly []
			? unknown
			: Refusal<"a fold over a counted family hides its accumulators: name the step's value alone">
		: unknown
	: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">

/** The step value's type a fold's ends hold: count's natural, every other monoid's step value's. */
type StepType<Fa, M, S> =
	NameOfMonoid<M> extends "count"
		? NaturalType
		: S extends Side<
					unknown,
					readonly [...MemberOf<Fa>["group"], infer X extends AnyTerm, ...ReadonlyArray<AnyTerm>]
			  >
			? FieldTypeOf<MemberOf<Fa>["relation"], X>
			: never

/**
 * A fold's end: the owner's side, its primary key then one accumulated field per plane of the step value's type
 * (count's a natural).
 */
export type FoldEnd<Fa, M, E, S> =
	E extends Side<
		infer O,
		readonly [...PrimaryKeyOf<MemberOf<Fa>["owner"]>, ...infer Ends extends ReadonlyArray<AnyTerm>]
	>
		? SameRelation<O, MemberOf<Fa>["owner"]> extends true
			? EndsHold<O, Ends, StepType<Fa, M, S>, PlanesOf<M>> extends true
				? unknown
				: Refusal<"a fold's end names one accumulated field of the owner per plane">
			: Refusal<"a fold's end names one accumulated field of the owner per plane">
		: Refusal<"a fold's end names one accumulated field of the owner per plane">

type EndsHold<O, Ends, X, Planes> = Ends extends readonly [infer E1]
	? Planes extends 1
		? Accumulator<O, E1, X>
		: false
	: Ends extends readonly [infer E1, infer E2]
		? Planes extends 2
			? [Accumulator<O, E1, X>, Accumulator<O, E2, X>] extends [true, true]
				? true
				: false
			: false
		: false

/** Any mirrors statement, whatever its sides. */
export type MirrorsBase = Mirrors<unknown, unknown>

/** Every statement is covariant in what it names, so `unknown` there admits every statement of its kind. */
export type Statement =
	| Key<unknown>
	| Mutable<unknown>
	| Check<string, unknown>
	| Containment<unknown, unknown>
	| MirrorsBase
	| AlternativesBase
	| AnyFamily
	| Fold<unknown, unknown, unknown, unknown>

/**
 * Each field of R as a Scalar of its field's domain and SQL type, whose language is the field's values, beside the
 * comparison and boolean helpers of Compute.
 */
export type RowScalars<R> = {
	readonly [K in keyof Fact<R>]: Scalar<
		FieldTypeOf<R, K> extends readonly [infer D, SqlTag] ? D : never,
		unknown,
		Origin<NameOf<R>, K & string>,
		FieldTypeOf<R, K> extends readonly [unknown, infer Sql extends SqlTag] ? Sql : SqlTag,
		Fact<R>[K]
	>
} & ScalarHelpers

/** The relation a law side reads: a selection reads its relation. */
export type SideRelation<R> = R extends Selection<infer Rel> ? Rel : R
export type SideHeading<R> = Fact<SideRelation<R>>

/** The fields of R that are natural (types/fields NaturalField), the fields pred reads: read off R's heading. */
export type NaturalFieldOf<R> =
	R extends Headed<infer C>
		? { [K in keyof C]-?: C[K] extends { readonly natural: true } ? K : never }[keyof C] & string
		: never

/** A term a side over R may read: a field of the relation it reads, or pred of one of its natural fields. */
export type TermOf<R> = (keyof SideHeading<R> & string) | Pred<NaturalFieldOf<SideRelation<R>>>

/**
 * What a field joins as: its domain and its PostgreSQL type, read off the carrier of its heading. Text and uuid are
 * different carriers; two text fields with different patterns share both, because a pattern restricts values without
 * changing text equality, so their domain is text. A roster's id is its closed id, of its roster's identity.
 */
type FieldTypeOf<R, K> =
	R extends Headed<infer C>
		? K extends keyof C
			? readonly [DomainOf<C[K]>, SqlOfCarrier<C[K]>]
			: never
		: never

/** What a term joins as: a field's own type, and pred of a field its field's, a count less one being a count. */
type TermTypeOf<R, T> = T extends Pred<infer F> ? FieldTypeOf<R, F> : FieldTypeOf<R, T>

/** The join types of a side's terms, in order. */
type SideHosts<S> =
	S extends Side<infer Src, infer T>
		? { readonly [I in keyof T]: TermTypeOf<SideRelation<Src>, T[I]> }
		: never

/**
 * Two sides are compatible when their terms' host types agree position by position: contract and closed-roster
 * identity included, with no added cast (the mirrors and contained reader).
 */
export type SidesCompatible<L, R> = [SideHosts<L>] extends [SideHosts<R>]
	? [SideHosts<R>] extends [SideHosts<L>]
		? unknown
		: Refusal<"the sides' field types differ">
	: Refusal<"the sides' field types differ">

/** The relation and key fields a KeyRef names: a Key's side's relation and field terms, a relation's primary key. */
export type RelationOfKey<K> = K extends Key<Side<infer R, ReadonlyArray<string>>> ? R : K
export type KeyFieldsOf<K> =
	K extends Key<Side<unknown, infer F extends ReadonlyArray<string>>>
		? F
		: K extends { readonly primaryKey: infer P extends ReadonlyArray<string> }
			? P
			: K extends AnyRoster
				? readonly ["id"]
				: K extends {
							readonly kind: "closedRelation"
							readonly key: infer P extends ReadonlyArray<string>
					  }
					? P
					: never

export type KeyValues<K> = Pick<
	Fact<RelationOfKey<K>>,
	(KeyFieldsOf<K> extends ReadonlyArray<infer F> ? F : never) & keyof Fact<RelationOfKey<K>>
>

type KeyHosts<K> =
	KeyFieldsOf<K> extends infer F extends ReadonlyArray<string>
		? { readonly [I in keyof F]: FieldTypeOf<RelationOfKey<K>, F[I]> }
		: never

/** The fields of P that are closedId(C) references: the discriminator alternatives accepts. */
export type DiscriminatorsOf<P, C> = {
	[K in keyof Fact<P>]-?: [Fact<P>[K]] extends [HandleOf<C>]
		? [HandleOf<C>] extends [Fact<P>[K]]
			? K
			: never
		: never
}[keyof Fact<P>] &
	string

/** The alternatives reader: every arm's key must have the parent key's field types, in order. */
export type ArmsCompatible<PK, Arms> = {
	readonly [H in keyof Arms]: [KeyHosts<Arms[H]>] extends [KeyHosts<PK>]
		? [KeyHosts<PK>] extends [KeyHosts<Arms[H]>]
			? unknown
			: Refusal<"the arm's key does not match the parent key">
		: Refusal<"the arm's key does not match the parent key">
}

/**
 * The alternatives reader: the arm map is keyed by handles of the roster C alone, each key by its spelling, a numeric
 * one's included. A roster whose handles are no literals cannot tell a stray key by its type, and the runtime refuses
 * it.
 */
export type ArmsOfRoster<C, Arms> = {
	readonly [
		K in Exclude<(keyof Arms & string) | `${keyof Arms & number}`, HandleOf<C>>
	]: Refusal<"an arm is keyed by a handle of its roster">
}

/** Whether A and B are one relation by their literal names: a name that is no literal tells no relation apart. */
type SameRelation<A, B> = [NameOf<A>] extends [never]
	? false
	: string extends NameOf<A>
		? false
		: [NameOf<A>] extends [NameOf<B>]
			? [NameOf<B>] extends [NameOf<A>]
				? true
				: false
			: false

/**
 * The alternatives reader: no arm is the parent itself. A parent that is its own arm at a handle must hold that handle
 * in every fact, since the arm key is a key of the parent, so every other handle of its roster would be dead; a
 * relation whose name is no literal cannot be told from the parent by its type, and the runtime refuses it.
 */
export type ArmsApartFromParent<PK, Arms> = {
	readonly [H in keyof Arms]: SameRelation<RelationOfKey<Arms[H]>, RelationOfKey<PK>> extends true
		? Refusal<"an arm is a relation other than its parent">
		: unknown
}

/**
 * One arm's containments: the arm's key among the parent's facts its handles select, and the parent's facts its
 * handle selects, projected onto the parent key, among the arm's keys. The selection's handles are its Description's;
 * ArmProofOf reads them from the alternatives law.
 */
type ArmContainments<P, PK, A> =
	| Containment<Side<RelationOfKey<A>, KeyFieldsOf<A>>, Side<Selection<P>, KeyFieldsOf<PK>>>
	| Containment<Side<Selection<P>, KeyFieldsOf<PK>>, Side<RelationOfKey<A>, KeyFieldsOf<A>>>

/**
 * An alternatives law: one statement of a schema, which states one containment per arm relation into the parent and
 * one per armed handle from the parent, with no head: the discriminator's roster domain types it. P is the parent in key position (a relation, standing for its
 * primary key, or a Key), D the discriminator, C the closed roster, and Arms the arm map from handles to arms in key
 * position. The value keeps its four inputs, so a reader of the schema (ContainmentsOf, the alternatives row of
 * types/evidence) reads the expansion from its type (ExpansionOf).
 */
export interface Alternatives<P, D extends string, C, Arms> {
	readonly kind: "alternatives"
	readonly parent: P
	readonly discriminator: D
	readonly roster: C
	readonly arms: Arms
}

/** Any alternatives law: Alternatives is covariant in what it names. */
export type AlternativesBase = Alternatives<unknown, string, unknown, unknown>

/**
 * The containments an alternatives law states, as a union: each arm's key among the parent's facts its handles select,
 * and the parent's facts each armed handle selects among its arm's keys (ir/desc.ts expandAlternatives).
 */
export type ExpansionOf<A> =
	A extends Alternatives<infer P, string, unknown, infer Arms>
		? {
				[H in keyof Arms]-?: [Exclude<Arms[H], undefined>] extends [never]
					? never
					: ArmContainments<RelationOfKey<P>, P, Exclude<Arms[H], undefined>>
			}[keyof Arms]
		: never

/** The arm map names at least one handle. */
export type AtLeastOneArm<Arms> = [keyof Arms] extends [never]
	? Refusal<"alternatives takes at least one arm">
	: unknown
