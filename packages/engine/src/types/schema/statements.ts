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
import type { HandleOf } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation, Fact, NameOf } from "#compiler/types/schema/relation.ts"

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
 * Statements: keys, mutability, checks, law sides, containment, mirrors, alternatives and capacity. The
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

export interface Capacity<T = Side<unknown>, F = Side<unknown>> {
	readonly kind: "capacity"
	readonly target: T
	readonly from: F
}

export interface Ref {
	readonly ref: string
}

export interface Duration {
	readonly duration: string
}

export interface Weight {
	readonly weight: string | Duration
}

export interface Bound {
	readonly low: bigint | Ref
	readonly high: bigint | Ref | "*"
}

/**
 * What a capacity bounds: the facts it counts from, how each fact weighs (one, when the rule names no weight), and the
 * bounds.
 */
export interface CapacityRule<F> {
	readonly from: F
	readonly weight?: Weight
	readonly within: Bound
}
/** within(n) is exactly n, within(low, high) the inclusive range, within(low, "*") unbounded above. */
export type WithinConstructor = (low: bigint | Ref, high?: bigint | Ref | "*") => Bound

/** Any mirrors statement, whatever its sides. */
export type MirrorsBase = Mirrors<unknown, unknown>

/** Every statement is covariant in what it names, so `unknown` there admits every statement of its kind. */
export type Statement =
	| Key<unknown>
	| Mutable<unknown>
	| Check<string, unknown>
	| Containment<unknown, unknown>
	| MirrorsBase
	| Capacity<unknown, unknown>
	| AlternativesBase

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
 * changing text equality, so their domain is text. A closed relation's id is its roster's enum, of its roster's
 * identity.
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
			: K extends AnyClosed
				? readonly ["id"]
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
 * One arm's statement: the parent's facts whose discriminator is the arm's handle, projected onto the parent key,
 * mirror the arm's key. The selection's handle is its Description's; ArmProofOf reads it from the alternatives law.
 */
type ArmMirrors<P, PK, A> = Mirrors<
	Side<Selection<P>, KeyFieldsOf<PK>>,
	Side<RelationOfKey<A>, KeyFieldsOf<A>>
>

/**
 * An alternatives law: one statement of a schema, which the schema expands into a containment and one mirrors per
 * arm, each the two containments it is sugar for. P is the parent in key position (a relation, standing for its
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
 * The statements an alternatives law expands to: contained(on(parent, discriminator), on(roster, "id")) and one
 * mirrors per handle the arm map gives an arm, as a union. The schema expands them in roster order.
 */
export type ExpansionOf<A> =
	A extends Alternatives<infer P, infer D, infer C, infer Arms>
		?
				| Containment<Side<RelationOfKey<P>, readonly [D]>, Side<C, readonly ["id"]>>
				| {
						[H in keyof Arms]-?: [Exclude<Arms[H], undefined>] extends [never]
							? never
							: ArmMirrors<RelationOfKey<P>, P, Exclude<Arms[H], undefined>>
				  }[keyof Arms]
		: never

/** The arm map names at least one handle. */
export type AtLeastOneArm<Arms> = [keyof Arms] extends [never]
	? Refusal<"alternatives takes at least one arm">
	: unknown
