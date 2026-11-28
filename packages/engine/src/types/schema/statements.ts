import type { Delivering } from "#compiler/core/phantom.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { ScalarHelpers } from "#compiler/types/compute/compute.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	BaseOf,
	DomainOf,
	Headed,
	LanguageOf,
	Origin,
	Refusal,
	Repeats,
	RosterKeysOf,
	SqlOfCarrier,
	Unordered
} from "#compiler/types/core/phantom.ts"
import type { Generation, GenerationsOf } from "#compiler/types/evidence/evidence.ts"
import type {
	AccumulatedField,
	BitField,
	NaturalDomain,
	FieldBase,
	GeneratedField,
	StoredOnlySql,
	WritingTag
} from "#compiler/types/fields/field.ts"
import type { AnyRelation, AnyRoster, Fact } from "#compiler/types/schema/relation.ts"

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

/**
 * unit(name, heading): a unit, the key a family of rows sits under, each value of it one lock. Every stored relation
 * whose primary key leads with the heading's fields, by name and type in order, sits under it. `Sealed` is whether it
 * is sealed at founding, sealed(unit(name, heading)): every row under it at a key is inserted by the one transaction
 * that founds it there.
 */
export interface Unit<Name extends string, Heading, Sealed extends boolean> {
	readonly kind: "unit"
	readonly name: Name
	readonly heading: Heading
	readonly sealed: Sealed
}

/** Any unit statement, sealed or not: Unit is covariant in its heading. */
export type UnitBase = Unit<string, unknown, boolean>

/**
 * series(R): R's one primary key field, natural or a contract over an integer, runs 0, 1, 2, … with no gap, and R's
 * appends queue on one lock of their own.
 */
export interface Series<R> {
	readonly kind: "series"
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
 * selection's Description's, which no type reads.
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
 * Statements: keys, mutability, checks, law sides, containment, mirrors, families, trees and folds. The constructors
 * are the typed schema facade's (schema/api.ts), written under these types over the admission cores of
 * packages/engine/src/schema.
 *
 * Every statement type carries the types of what it names, so the schema's captured statement tuple can be read back.
 * A key's, a check's and a containment's side may read an ordinary, a closed or a derived relation, a derived one's
 * terms typed by its definition's heading; a family, a tree, a fold and mutable name ordinary relations alone, whose
 * rows grizzle writes.
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
export interface OrderedFamily<F, Fi> {
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
	| OrderedFamily<unknown, unknown>
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
type SetIn<C> = { [K in keyof C]-?: C[K] extends BitField<unknown> ? K : never }[keyof C] & string

/** The heading of R: the record of carriers its facts are made of. */
type HeadingOf<R> = R extends Headed<infer C> ? C : never

/** The fields of the heading C a family or tree draws: its drawn fields, each a natural or a contract over an integer. */
type DrawnIn<C> = {
	[K in keyof C]-?: C[K] extends { readonly writing: "drawn" } ? K : never
}[keyof C] &
	string

/**
 * The fields of the heading C a tree draws and a counted family counts by: its drawn naturals, a tree's interval and
 * a counted family's hidden index being natural's, which they pair with.
 */
type DrawnNaturalIn<C> = {
	[K in keyof C]-?: C[K] extends {
		readonly writing: "drawn"
		readonly field: { readonly natural: true }
	}
		? K
		: never
}[keyof C] &
	string

/** The fields of R its family or tree draws: its drawn fields, read off its heading. */
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

/**
 * An ordered family's index, the last of its side's terms T over the heading C, is of the type of its slots Fi's count
 * over its owner's heading OC: the family's law pairs them, its last member's index pred(n), so they are of one
 * identity.
 */
export type IndexOfCount<C, T, OC, Fi> = [Fi] extends [{ readonly count: infer N }]
	? IndexOfCountField<C, T, OC, N>
	: unknown

/** IndexOfCount over the count field N of the owner's heading OC. */
type IndexOfCountField<C, T, OC, N> = T extends readonly [
	...ReadonlyArray<AnyTerm>,
	infer I extends AnyTerm
]
	? [FieldTypeOf<C, I>] extends [FieldTypeOf<OC, N>]
		? [FieldTypeOf<OC, N>] extends [FieldTypeOf<C, I>]
			? unknown
			: Refusal<"an ordered family's index is of its count's type">
		: Refusal<"an ordered family's index is of its count's type">
	: unknown

/**
 * A counted family's count, its slots Fi's over its owner's heading OC, is a drawn natural, as the hidden index it pairs
 * with is.
 */
export type CountedCount<OC, Fi> = [Fi] extends [{ readonly count: infer N }]
	? [N] extends [DrawnNaturalIn<OC>]
		? unknown
		: Refusal<"a counted family's count is a drawn natural, as its hidden index is">
	: unknown

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
		? [P | I | N | "start" | "end"] extends [DrawnNaturalIn<C>]
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

/** The generated fields of the heading C, a key generation among them where the primary key holds one. */
type GeneratedIn<C> = {
	[K in keyof C]-?: C[K] extends { readonly writing: "generated" } ? K : never
}[keyof C] &
	string

/**
 * A tree's root fields are caller's fields of its relation, whose heading is C, or key generations (ir/law.ts
 * FieldWriting keyGenerated), a member's own generated over the reads its caller states: the primary key the root
 * fields lead (RootThenStart) holds them, so a generated one is a key generation.
 */
export type TreeRootOf<C, Root> = Root extends readonly [string, ...ReadonlyArray<string>]
	? Root[number] extends CallerIn<C> | GeneratedIn<C>
		? unknown
		: Refusal<"a tree's root fields are distinct caller fields of its relation">
	: Refusal<"a tree's root fields are distinct caller fields of its relation">

/** A family's group terms, and whether it hides its order: a counted family's members have no visible index. */
type MemberOf<Fa> =
	Fa extends OrderedFamily<
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
	readonly sum: "int2" | "int4" | "int8" | "numeric" | "money"
	readonly or: "bit"
	readonly twos: "bit"
	readonly max: "int2" | "int4" | "int8" | "code" | "money"
	readonly concat: "text"
}

type NameOfMonoid<M> = M extends Monoid<infer N> ? N : never

/**
 * What the term A of the heading C is as an accumulator of field X's type: one, an accumulated field whose domain and SQL
 * type are X's, or, X a text, a generated field, which stands in the place of the running text it digests where it is
 * `Crypto.sha256(row.v)` over the accumulated v (ir/family.ts FoldCarrier); an accumulated field of another type; or
 * neither. A generated field's reads are no part of its type, so the schema's compile admits the digest alone
 * (analysis/theory/families.ts runningValue), and its value, v, is typed there.
 */
type AccumulatorOf<C, A, X> = A extends keyof C
	? C[A] extends AccumulatedField<FieldBase>
		? [FieldTypeOf<C, A>] extends [X]
			? [X] extends [FieldTypeOf<C, A>]
				? "held"
				: "type"
			: "type"
		: C[A] extends GeneratedField<FieldBase>
			? X extends readonly [unknown, "text"]
				? "held"
				: "absent"
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

/** count's value and accumulators are naturals: natural's domain and SQL type. */
type NaturalType = readonly [NaturalDomain, "int8"]

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
		? MonoidAdmits<N, FieldTypeOf<C, X>> extends true
			? PairsAllowed<Mb, Accumulators<C, Pairs, FieldTypeOf<C, X>, PlanesOf<M>>, Pairs> &
					InOrder<Mb, N, Pairs>
			: Refusal<"the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text">
		: Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">

/**
 * Whether the monoid N admits a step value of the join type V (FieldTypeOf): one of the SQL types it admits (MonoidSql),
 * and, for max, a value with a least one, which a closed id of a closed.unordered roster has not: its domain carries
 * Unordered, since none of its handles comes before another.
 */
type MonoidAdmits<N extends MonoidName, V> = V extends readonly [infer D, MonoidSql[N]]
	? N extends "max"
		? [D] extends [never]
			? true
			: [D] extends [Unordered]
				? false
				: true
		: true
	: false

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
	| UnitBase
	| Series<unknown>
	| AnyFamily
	| Fold<unknown, unknown, unknown, unknown>

/**
 * Each field of the source V shows as a Scalar of its field's domain and SQL type, whose language is the field's
 * (LanguageOf): its values, but a closed id of a subset's, its roster's handles, beside the comparison and boolean helpers of Logic: a relation shows its own name and heading, and a
 * builder passes what it inferred of its argument (Shows), so a row of a generic source is typed by the heading its
 * relations share. A bytes field's scalar is one no comparison or operation but Crypto.sha256 takes (FirstTerm), since
 * a bytes value has no equality, so a row check, selection or generated field reads it only through its digest.
 */
export type RowScalars<V extends Shows<string, unknown>> = {
	readonly [K in keyof V["heading"]]: Scalar<
		FieldTypeOf<V["heading"], K> extends readonly [infer D, SqlTag] ? D : never,
		unknown,
		Origin<V["name"], K & string>,
		FieldTypeOf<V["heading"], K> extends readonly [unknown, infer Sql extends SqlTag]
			? Sql
			: SqlTag,
		LanguageOf<V["heading"][K]>
	>
} & ScalarHelpers

/**
 * The fields of the heading C that are natural (types/fields NaturalField), a drawn natural among them (DrawnField),
 * the fields pred reads.
 */
type NaturalIn<C> = {
	[K in keyof C]-?: C[K] extends
		| { readonly natural: true }
		| { readonly writing: "drawn"; readonly field: { readonly natural: true } }
		? K
		: never
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

/**
 * What field K of the heading C pairs as in a containment's side: its domain's base carrier, its contracts stripped
 * (BaseOf) and its roster's brands kept (RosterKeysOf), and its PostgreSQL type. natural, an instant and a contract over
 * int8 pair as int8 does, since a refinement only narrows the values and the inclusion is one law under the
 * base's equality.
 */
type PairedTypeOf<C, K> = K extends keyof C
	? readonly [BaseOf<DomainOf<C[K]>>, RosterKeysOf<DomainOf<C[K]>>, SqlOfCarrier<C[K]>]
	: never

/** What a term pairs as: a field's own type, and pred of a field its field's, a count less one being a count. */
type TermTypeOf<C, T> = T extends Pred<infer F> ? PairedTypeOf<C, F> : PairedTypeOf<C, T>

/** The paired types of the terms T of a side over the heading C, in order. */
export type SideHosts<C, T> = { readonly [I in keyof T]: TermTypeOf<C, T[I]> }

/**
 * Two sides are compatible when their terms' paired types, L and R (SideHosts), agree position by position: one base
 * carrier, closed-roster identity included, either side's contracts refining it, with no added cast (the mirrors and
 * contained reader).
 */
export type SidesCompatible<L, R> = [L] extends [R]
	? [R] extends [L]
		? unknown
		: Refusal<"the sides' field types differ">
	: Refusal<"the sides' field types differ">

/**
 * The relation and key fields a key in key position names: a Key's side's relation and field terms, a relation's
 * primary key, a closed relation's key.
 */
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

/**
 * The values a caller states to name a fact by the key K, its key heads (ir/law.ts keyHeads): each key field, a key
 * generation (a generated field of the key) replaced by the fields its generation reads (types/evidence GenerationsOf),
 * which the host fills it from before the key is read; a generation the types do not trace stays its own field.
 */
export type KeyValues<K> = Pick<
	Fact<RelationOfKey<K>>,
	KeyHeadFields<
		HeadingOf<RelationOfKey<K>>,
		KeyFieldsOf<K> extends ReadonlyArray<infer F> ? F : never
	> &
		keyof Fact<RelationOfKey<K>>
>

/** The key heads of the key fields F of the relation R (KeyHeadFields over its heading). */
export type KeyHeadsOf<R, F> = KeyHeadFields<HeadingOf<R>, F>

/** Each key field F of a heading H as its key heads: a traced generation's reads, else itself. */
type KeyHeadFields<H, F> = F extends string
	? [Extract<GenerationsOf<H>, Generation<F, string>>] extends [never]
		? F
		: Extract<GenerationsOf<H>, Generation<F, string>> extends Generation<F, infer Reads>
			? Reads
			: F
	: never

/** A source of kind K a builder takes as one that shows N and C (fin's owner). */
export interface ShowingKind<out N, out C, out K> extends Showing<N, C> {
	readonly kind: K
}
