import type { Delivering } from "#compiler/core/phantom.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { ScalarHelpers } from "#compiler/types/compute/compute.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	DomainOf,
	Headed,
	Origin,
	Refusal,
	Repeats,
	SqlOfCarrier,
	Term
} from "#compiler/types/core/phantom.ts"
import type {
	AccumulatedField,
	BitsField,
	DrawnField,
	FieldBase,
	HandleOf,
	StoredOnlySql,
	WritingTag
} from "#compiler/types/fields/field.ts"
import type {
	AnyRelation,
	AnyRoster,
	Fact,
	FactOfFields,
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
 * A side's terms by name: a field's own, and pred of a field `pred <field>`, which no declared name spells (a name
 * holds no space), so a field and pred of it are two names.
 */
type TermNames<T> = { readonly [I in keyof T]: T[I] extends Pred<infer F> ? `pred ${F}` : T[I] }

/** A side lists each of its terms once (ir/desc.ts SideDesc): a field and pred of it are two terms. */
export type DistinctTerms<T> =
	Repeats<TermNames<T>> extends true ? Refusal<"a side lists each term once"> : unknown

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
export interface Key<S> extends Delivering<SideRecords<S>> {
	readonly kind: "key"
	readonly side: S
}

/** The records a key's side delivers: its source's, a candidate key's relation's facts. */
type SideRecords<S> = S extends { readonly source: Delivering<infer A> } ? A : never

export interface Mutable<R> {
	readonly kind: "mutable"
	readonly relation: R
}

/**
 * race(R): R's primary key is held by its first insertion, and every later insertion at it meets that row, never
 * refused for differing from it.
 */
export interface Race<R> {
	readonly kind: "race"
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
 * A source as a statement's builder reads it: its name and its heading, the record of carriers its facts are made of,
 * a roster's its closed id at `id`. A builder infers both from its argument, and from a generic argument's constraint
 * where the argument is one, so a check over a generic source is decided where it is written: its name is the union of
 * its relations' names, and its heading the one they share, every relation it may be holding each of its fields at
 * its carrier.
 */
export interface Shows<out N, out C> {
	readonly name: N
	readonly heading: C
}

/**
 * A source a builder takes as one that shows N and C: its heading is C, which a builder infers from it; a generic
 * source whose relations share no heading is refused there. The refusal is the heading's, so it is printed only where
 * the heading is what differs.
 */
export interface Showing<out N, out C> {
	readonly name: N
	readonly heading: C | Refusal<"a generic source's relations share one heading">
}

/** A relation a builder takes as one that shows N and C, whose primary key is K. */
export interface ShowingKeyed<out N, out C, out K> extends Showing<N, C> {
	readonly primaryKey: K
}

/**
 * A side whose source, or the source its selection selects, shows N and C. A generic source whose relations share no
 * heading is refused.
 */
export interface SideShows<out N, out C> {
	readonly source: SourceShowing<N, C>
}

/** A selection a builder takes as one of a source that shows N and C. */
export interface Selecting<out N, out C> {
	readonly relation: Showing<N, C>
}

/** A side's source as a builder takes it: one that shows N and C, or a selection of one. */
export type SourceShowing<N, C> = Showing<N, C> | Selecting<N, C>

/** A side over a relation that shows N and C, whose primary key is K. */
export interface SideShowsKeyed<out N, out C, out K> {
	readonly source: ShowingKeyed<N, C, K>
}

/** An owner a builder takes as one that shows N and C, whose primary key, where it has one, is K. */
export interface OwnerShowing<out N, out C, out K> extends Showing<N, C> {
	readonly primaryKey?: K
}

/** Slots over an owner of kind Kind that shows N and C, whose primary key, where it has one, is K. */
export interface FinShows<out N, out C, out K, out Kind> {
	readonly owner: OwnerShowing<N, C, K> & { readonly kind: Kind }
}

/**
 * Statements: keys, mutability, checks, law sides, containment, mirrors, alternatives, families, trees and folds. The
 * constructors are the typed schema facade's (schema/api.ts), written under these types over the admission cores of
 * packages/engine/src/schema.
 *
 * Every statement type carries the types of what it names, so the schema's captured statement tuple can be read back.
 * A key's, a check's and a containment's side may read an ordinary, a closed or a derived relation, a derived one's
 * terms typed by its definition's heading; a family, a tree, a fold, alternatives and mutable name ordinary relations
 * alone, whose rows grizzle writes.
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
 * tree(on(T, "parent", "at"), fin(T, "children"), { root: [r…] }): the ordered family of T over itself, keyed by its
 * root fields r… then its drawn `start`, every row but each root a member, its drawn `parent` its parent's start, with
 * T's drawn `start` and `end` its pre-order interval and r… the caller's fields each tree's rows share.
 */
export interface Tree<F, Fi, Root extends ReadonlyArray<string>> {
	readonly kind: "tree"
	readonly family: F
	readonly slots: Fi
	readonly root: Root
}

/** Any family: each is covariant in what it names. */
export type AnyFamily =
	| Ordered<unknown, unknown>
	| Counted<unknown, unknown>
	| Tree<unknown, unknown, ReadonlyArray<string>>

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

/** A key over the heading C lists no set: a set's bit string is wider than an index entry holds. */
export type NoSetKey<C, T extends ReadonlyArray<AnyTerm>> = [
	Extract<T[number], string> & SetIn<C>
] extends [never]
	? unknown
	: Refusal<"a key lists no set: a set's bit string is too wide for an index entry">

/** The sets of the heading C. */
type SetIn<C> = { [K in keyof C]-?: C[K] extends BitsField<unknown> ? K : never }[keyof C] & string

/** The heading of R: the record of carriers its facts are made of. */
type HeadingOf<R> = R extends Headed<infer C> ? C : never

/** The fields of the heading C a family or tree draws: its drawn naturals. */
type DrawnIn<C> = { [K in keyof C]-?: C[K] extends DrawnField ? K : never }[keyof C] & string

/** The fields of R its family or tree draws: its drawn naturals, read off its heading. */
export type DrawnFieldOf<R> = DrawnIn<HeadingOf<R>>

/**
 * The fields of a source of kind K over the heading C that may count fin's slots: an ordinary relation's drawn
 * naturals, which a family draws, and a closed relation's naturals, which its declaration states.
 */
export type CountFieldIn<K, C> = [K] extends ["closedRelation"]
	? NaturalIn<C>
	: [K] extends ["relation"]
		? DrawnIn<C>
		: never

/** The fields of the heading C its caller writes: those whose descriptor states no writing of its own. */
type CallerIn<C> = {
	[K in keyof C]-?: C[K] extends { readonly writing: WritingTag } ? never : K
}[keyof C] &
	string

/** The join types of the fields T of the heading C, in order. */
type TypesOf<C, T> = { readonly [I in keyof T]: FieldTypeOf<C, T[I]> }

/**
 * Whether the fields G of the heading C have the types of the key K of the heading OC, in order: a family's group
 * pairs with its owner's key.
 */
type GroupOfOwner<C, G, OC, K> = [TypesOf<C, G>] extends [TypesOf<OC, K>]
	? [TypesOf<OC, K>] extends [TypesOf<C, G>]
		? true
		: false
	: false

/**
 * An ordered family's side, the terms T over the heading C, is its owner's key, then its drawn index: the owner's
 * heading OC and primary key K.
 */
export type OrderedMember<C, T, OC, K> = T extends readonly [
	...infer G extends ReadonlyArray<AnyTerm>,
	infer I extends AnyTerm
]
	? GroupOfOwner<C, G, OC, K> extends true
		? I extends DrawnIn<C>
			? unknown
			: Refusal<"an ordered family's side is its owner's key, then its drawn index">
		: Refusal<"an ordered family's side is its owner's key, then its drawn index">
	: Refusal<"an ordered family's side is its owner's key, then its drawn index">

/** A counted family's side, the terms T over the heading C, is its owner's key: the owner's heading OC and key K. */
export type CountedMember<C, T, OC, K> =
	GroupOfOwner<C, T, OC, K> extends true
		? unknown
		: Refusal<"a counted family's side is its owner's key">

/**
 * A family's slots, over an owner of kind Kind (FinShows): fin(O, n) over an ordinary relation, whose drawn count the
 * family draws. A closed relation's count numbers the slots of its key, and slots with no owner are no fin.
 */
export type FamilySlots<Kind> = [Kind] extends ["relation"]
	? unknown
	: [Kind] extends ["closedRelation"]
		? Refusal<"a family counts by an ordinary relation's drawn count: a closed relation's count numbers the slots of its key">
		: Refusal<"a family's slots are fin(owner, count), the owner's count">

/**
 * `Then`, the check of a family's member side, read where its slots are over an ordinary relation, of kind Kind: other
 * slots are refused at the slots.
 */
export type OverSlots<Kind, Then> = [Kind] extends ["relation"] ? Then : unknown

/**
 * A tree is a family of T over itself, on(T, parent, at) with fin(T, n): over T's heading C and primary key K, K its
 * root fields Root then `start`, and parent, at, n, start and end drawn. That the slots are T's own a tree's builder
 * checks.
 */
export type SelfFamily<C, K, T, N, Root> = T extends readonly [
	infer P extends AnyTerm,
	infer I extends AnyTerm
]
	? RootThenStart<K, Root> extends true
		? [P | I | N | "start" | "end"] extends [DrawnIn<C>]
			? unknown
			: Refusal<"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end">
		: Refusal<"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end">
	: Refusal<"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end">

/** Whether the primary key K is the root fields Root, in order, then `start`. */
type RootThenStart<K, Root> =
	Root extends ReadonlyArray<string>
		? [K] extends [readonly [...Root, "start"]]
			? [readonly [...Root, "start"]] extends [K]
				? true
				: false
			: false
		: false

/** A tree's root fields are caller's fields of its relation, whose heading is C. */
export type TreeRootOf<C, Root> = Root extends readonly [string, ...ReadonlyArray<string>]
	? Root[number] extends CallerIn<C>
		? unknown
		: Refusal<"a tree's root fields are distinct caller fields of its relation">
	: Refusal<"a tree's root fields are distinct caller fields of its relation">

/** A family's group terms, and whether it hides its order: a counted family's members have no visible index. */
type MemberOf<Fa> =
	Fa extends Ordered<
		Side<unknown, readonly [...infer G extends ReadonlyArray<AnyTerm>, AnyTerm]>,
		unknown
	>
		? { readonly group: G; readonly hidden: false }
		: Fa extends Counted<Side<unknown, infer G extends ReadonlyArray<AnyTerm>>, unknown>
			? { readonly group: G; readonly hidden: true }
			: Fa extends Tree<
						Side<unknown, readonly [infer P extends AnyTerm, AnyTerm]>,
						unknown,
						infer Root extends ReadonlyArray<string>
				  >
				? { readonly group: readonly [...Root, P]; readonly hidden: false }
				: never

/** The relation a family's members are rows of, which a fold's step reads. */
export type MemberRelationOf<Fa> = Fa extends { readonly family: Side<infer R> } ? R : never

/** The relation a family's slots count over, which a fold's end reads. */
export type OwnerRelationOf<Fa> = Fa extends { readonly slots: Fin<infer O, string> } ? O : never

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

/**
 * What the term A of the heading C is as an accumulator of field X's type: one, an accumulated field whose domain and SQL
 * type are X's; an accumulated field of another type; or no accumulated field.
 */
type AccumulatorOf<C, A, X> = A extends keyof C
	? C[A] extends AccumulatedField<FieldBase>
		? [FieldTypeOf<C, A>] extends [X]
			? [X] extends [FieldTypeOf<C, A>]
				? "held"
				: "type"
			: "type"
		: "absent"
	: "absent"

/** An accumulator of field X's type in the heading C: an accumulated field of C whose domain and SQL type are X's. */
type Accumulator<C, A, X> = AccumulatorOf<C, A, X> extends "held" ? true : false

/** The accumulators a step names after its value: none, or one (before, after) pair per plane, of the value's type. */
type Accumulators<C, Rest, X, Planes> = Rest extends readonly []
	? true
	: Rest extends readonly [infer B, infer A]
		? Planes extends 1
			? [Accumulator<C, B, X>, Accumulator<C, A, X>] extends [true, true]
				? true
				: false
			: false
		: Rest extends readonly [infer B1, infer A1, infer B2, infer A2]
			? Planes extends 2
				? [
						Accumulator<C, B1, X>,
						Accumulator<C, A1, X>,
						Accumulator<C, B2, X>,
						Accumulator<C, A2, X>
					] extends [true, true, true, true]
					? true
					: false
				: false
			: false

/** count's value and accumulators are naturals. */
type NaturalType = readonly [bigint, "bigint"]

/**
 * A fold's step, the terms T over the member's heading C: the family's group, then its value (none for count) of a
 * type the monoid admits, then none or one accumulated (before, after) pair per plane of the value's type; over a
 * counted family, no pair, since a visible accumulator would show the hidden order. That the step reads the family's
 * member, or a selection of it, a fold's builder checks.
 */
export type FoldStep<Fa, M, C, T> = T extends readonly [...MemberOf<Fa>["group"], ...infer Rest]
	? StepRest<MemberOf<Fa>, C, NameOfMonoid<M>, M, Rest>
	: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">

type StepRest<Mb extends MemberShape, C, N extends MonoidName, M, Rest> = N extends "count"
	? PairsAllowed<Mb, Accumulators<C, Rest, NaturalType, 1>, Rest>
	: Rest extends readonly [infer X, ...infer Pairs]
		? FieldTypeOf<C, X> extends readonly [unknown, MonoidSql[N]]
			? PairsAllowed<Mb, Accumulators<C, Pairs, FieldTypeOf<C, X>, PlanesOf<M>>, Pairs> &
					InOrder<Mb, N, Pairs>
			: Refusal<"the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text">
		: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">

type MemberShape = {
	readonly group: ReadonlyArray<AnyTerm>
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

/** The step value's type a fold's ends hold: count's natural, every other monoid's step value's, the terms T over C. */
type StepType<Fa, M, C, T> =
	NameOfMonoid<M> extends "count"
		? NaturalType
		: T extends readonly [
					...MemberOf<Fa>["group"],
					infer X extends AnyTerm,
					...ReadonlyArray<AnyTerm>
			  ]
			? FieldTypeOf<C, X>
			: never

/**
 * A fold's end, the terms E over the owner's heading OC: its primary key K then one accumulated field per plane of the
 * step value's type (count's a natural), the step the terms T over the member's heading C. That the end reads the
 * family's owner a fold's builder checks.
 */
export type FoldEnd<Fa, M, OC, K, E, C, T> = E extends readonly [
	...Extract<K, ReadonlyArray<string>>,
	...infer Ends extends ReadonlyArray<AnyTerm>
]
	? {
			readonly held: unknown
			readonly type: Refusal<"a fold's accumulators and ends are of its plane's type: another integer width, numeric typmod or contract is another type">
			readonly absent: Refusal<"a fold's end names one accumulated field of the owner per plane">
		}[EndsHeld<OC, Ends, StepType<Fa, M, C, T>, PlanesOf<M>>]
	: Refusal<"a fold's end names one accumulated field of the owner per plane">

/**
 * What a fold's ends Ends over the owner's heading OC are, one per plane: held, accumulators of the step value's type
 * X; of another type, accumulated fields one of which is of another type; or absent, another count of ends or one no
 * accumulated field.
 */
type EndsHeld<OC, Ends, X, Planes> = Ends extends readonly [infer E1]
	? Planes extends 1
		? AccumulatorOf<OC, E1, X>
		: "absent"
	: Ends extends readonly [infer E1, infer E2]
		? Planes extends 2
			? Worst<AccumulatorOf<OC, E1, X> | AccumulatorOf<OC, E2, X>>
			: "absent"
		: "absent"

/** The worst of accumulator verdicts V: absent, then of another type, then held. */
type Worst<V> = "absent" extends V ? "absent" : "type" extends V ? "type" : "held"

/** Any mirrors statement, whatever its sides. */
export type MirrorsBase = Mirrors<unknown, unknown>

/** Every statement is covariant in what it names, so `unknown` there admits every statement of its kind. */
export type Statement =
	| Key<unknown>
	| Mutable<unknown>
	| Race<unknown>
	| Check<string, unknown>
	| Containment<unknown, unknown>
	| MirrorsBase
	| AlternativesBase
	| RetirableBase
	| AnyFamily
	| Fold<unknown, unknown, unknown, unknown>

/**
 * Each field of the source V shows as a Scalar of its field's domain and SQL type, whose language is the field's
 * values, beside the comparison and boolean helpers of Compute: a relation shows its own name and heading, and a
 * builder passes what it inferred of its argument (Shows), so a row of a generic source is typed by the heading its
 * relations share. A bytes field shows as a term of no comparison, which only Compute.sha256 reads (RowBytes).
 */
export type RowScalars<V extends Shows<string, unknown>> = {
	readonly [K in keyof V["heading"]]: V["heading"][K] extends { readonly sql: StoredOnlySql }
		? RowBytes<FieldTypeOf<V["heading"], K>, Origin<V["name"], K & string>>
		: Scalar<
				FieldTypeOf<V["heading"], K> extends readonly [infer D, SqlTag] ? D : never,
				unknown,
				Origin<V["name"], K & string>,
				FieldTypeOf<V["heading"], K> extends readonly [unknown, infer Sql extends SqlTag]
					? Sql
					: SqlTag,
				FactOfFields<V["heading"]>[K]
			>
} & ScalarHelpers

/**
 * A bytes field of a row, of its domain and SQL type T, from origin O: a term with no comparison, since a bytes value
 * has no equality, which every operation and helper but Compute.sha256 refuses (FirstTerm), so a row check, selection or
 * generated field reads it only through its digest.
 */
type RowBytes<T, O> = T extends readonly [infer D, infer Sql extends SqlTag]
	? Term<D, unknown, O, Sql>
	: never

/** The relation a law side reads: a selection reads its relation. */
export type SideRelation<R> = R extends Selection<infer Rel> ? Rel : R

/** The fields of the heading C that are natural (types/fields NaturalField), the fields pred reads. */
type NaturalIn<C> = {
	[K in keyof C]-?: C[K] extends { readonly natural: true } ? K : never
}[keyof C] &
	string

/** The fields of R that are natural (types/fields NaturalField), the fields pred reads: read off R's heading. */
export type NaturalFieldOf<R> = NaturalIn<HeadingOf<R>>

/** The fields of the heading C that are bytes, which no side reads: a bytes value has no equality. */
type StoredOnlyIn<C> = {
	[K in keyof C]-?: C[K] extends { readonly sql: StoredOnlySql } ? K : never
}[keyof C] &
	string

/**
 * A term a side over a source of the heading C may read: a field of C, but no stored-only field, or pred of one of its
 * natural fields. on reads C off what its source shows (SourceShowing), a generic source's off its constraint, so a
 * term over a generic source is decided where it is written.
 */
export type TermOf<C> = Exclude<keyof C & string, StoredOnlyIn<C>> | Pred<NaturalIn<C>>

/**
 * What field K of the heading C joins as: its domain and its PostgreSQL type, read off its carrier. Text and uuid are
 * different carriers; two text fields with different patterns share both, because a pattern restricts values without
 * changing text equality, so their domain is text. A roster's id is its closed id, of its roster's identity.
 */
type FieldTypeOf<C, K> = K extends keyof C ? readonly [DomainOf<C[K]>, SqlOfCarrier<C[K]>] : never

/** What a term joins as: a field's own type, and pred of a field its field's, a count less one being a count. */
type TermTypeOf<C, T> = T extends Pred<infer F> ? FieldTypeOf<C, F> : FieldTypeOf<C, T>

/** The join types of the terms T of a side over the heading C, in order. */
export type SideHosts<C, T> = { readonly [I in keyof T]: TermTypeOf<C, T[I]> }

/**
 * Two sides are compatible when their terms' join types, L and R (SideHosts), agree position by position: contract
 * and closed-roster identity included, with no added cast (the mirrors and contained reader).
 */
export type SidesCompatible<L, R> = [L] extends [R]
	? [R] extends [L]
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

/** The join types of a KeyRef's key fields, in order. */
type KeyHosts<K> = SideHosts<HeadingOf<RelationOfKey<K>>, KeyFieldsOf<K>>

/** A Key over a side of a relation that shows N and C, whose terms are F: a parent in key position. */
export interface KeyShows<out N, out C, out F> {
	readonly side: KeySideShowing<N, C, F>
}
interface KeySideShowing<out N, out C, out F> {
	readonly source: Showing<N, C>
	readonly terms: F
}

/** A source of kind K a builder takes as one that shows N and C (fin's owner). */
export interface ShowingKind<out N, out C, out K> extends Showing<N, C> {
	readonly kind: K
}

/** The fields of the heading C that are closedId(R) references: the discriminator alternatives accepts. */
export type DiscriminatorsOf<C, R> = {
	[K in keyof FactOfFields<C>]-?: [FactOfFields<C>[K]] extends [HandleOf<R>]
		? [HandleOf<R>] extends [FactOfFields<C>[K]]
			? K
			: never
		: never
}[keyof FactOfFields<C>] &
	string

/**
 * The alternatives reader: every arm is a stored relation, whose rows a write draws, and its key has the parent key's
 * field types, P, in order.
 */
export type ArmsCompatible<P, Arms> = {
	readonly [H in keyof Arms]: RelationOfKey<Arms[H]> extends { readonly kind: "derived" }
		? Refusal<"alternatives relate stored relations: a derived relation's rows are its definition's, which no write draws">
		: [KeyHosts<Arms[H]>] extends [P]
			? [P] extends [KeyHosts<Arms[H]>]
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

/**
 * Whether two relations' names, A and B, may name one relation: each a literal or a union of them, the names meet. A
 * name that is no literal tells no relation apart, and the runtime tells them.
 */
type NamesMeet<A, B> = [A] extends [never]
	? false
	: string extends A
		? false
		: string extends B
			? false
			: [A & B] extends [never]
				? false
				: true

/**
 * The alternatives reader: no arm is the parent itself, the parent's name P. A parent that is its own arm at a handle
 * must hold that handle in every fact, since the arm key is a key of the parent, so every other handle of its roster
 * would be dead; a generic parent is any of the relations its name may be, and a relation whose name is no literal
 * cannot be told from the parent by its type, and the runtime refuses it.
 */
export type ArmsApartFromParent<P, Arms> = {
	readonly [H in keyof Arms]: NamesMeet<NameOf<RelationOfKey<Arms[H]>>, P> extends true
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

/**
 * A retirable statement: one statement of a schema whose header H, a relation standing for its primary key or a Key,
 * keeps one row per group for good, holding its retirement field, and whose bodies B, sides over every fact of each
 * body relation, name each row's group by the fields paired with the header's key. A retirement removes a group's
 * rows of every body relation in one statement and sets its header's retirement field, so no group is read half
 * retired and none is written again (ir/desc.ts expandRetirable states the fence that keeps it).
 */
export interface Retirable<H, B> {
	readonly kind: "retirable"
	readonly header: H
	readonly bodies: B
}

/** Any retirable statement: Retirable is covariant in what it names. */
export type RetirableBase = Retirable<unknown, unknown>

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
