import type { Option, Stream } from "effect"
import type { Column, Delivered, Delivery, RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, phantom, Phantom } from "#compiler/core/phantom.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Requires } from "#compiler/types/compute/scalar.ts"
import type {
	Carriers,
	Headed,
	Invariant,
	IsOneLiteral,
	ParamsContribution,
	ParamsOfTerm,
	Refusal,
	SchemaSource,
	Simplify,
	Source,
	Term,
	TermBase,
	UnionHeading,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"

import type {
	DeliveryClaim,
	Evidence,
	TakeEvidence,
	UnionEvidence
} from "#compiler/types/evidence/evidence.ts"
import type { FieldBase, LiteralOf } from "#compiler/types/fields/field.ts"
import type { RequireBound, Rule } from "#compiler/types/query/rule.ts"
import type { NoExcess, ParentVars, VarsOf, VSource } from "#compiler/types/query/terms.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"
import type { AnySchema, IsLevelOf, LevelsOf } from "#compiler/types/schema/schema.ts"
import type { ApproximateNearestSpec } from "#compiler/types/vector/vector.ts"

/**
 * The one relation-valued expression, Query<S, Head, Ev, P>, and its ordered and finished forms. The builders of
 * packages/engine/src/query/build are written under QueryConstructor, QueryBuilder, Query, Ordered and VConstructor, and the
 * public barrel exports them; a lower layer never imports the query layer, so the implementation lives above these
 * types.
 *
 * The builder's values carry none of these phantoms at runtime: `heading`, `evidence`, `params`, `paramsInvariant`,
 * `sourceParams` and `schema` are read only by the type level, and the Description a value records is
 * what the compiler reads. What a value delivers is a real member: its decoders (Decoders), each built by the
 * combinator that made the value, so a query's heading is the type of the records its decoder assembles.
 *
 * Phantoms:
 * - S, the schema, is invariant through `schema: Invariant<S>`: a query over an extension is never a query over its
 *   base. Where a query over a base must stand for a query over an extension, the consumer
 *   accepts any level of its schema (LevelsOf): readers, attach, ChangeSet members and read-backs, the workload.
 * - Head is the result heading: the records `rows` decodes (HeadOf), and the heading a rule that matches the query
 *   reads through `heading` (a Source; an Ordered is no source until take closes it back into a set).
 * - Ev is the evidence approximation; P the parameter map the caller binds. P is carried invariantly as well as read
 *   through `params` (`paramsInvariant: Invariant<P>`), so a query that needs parameters is never a query that needs
 *   none: it cannot be upcast to `Query<S, Head, any, unknown>` and then executed with `{}` or matched without bind.
 * - IHead is the heading a read inside a write transaction delivers, a read-back, the records `immediate` decodes
 *   (ImmediateHeadOf). Such a read may rely on immediate-constraint evidence only, so it differs from Head only in its
 *   attachments: a child stated as the one child is an Option there, and an alternatives arm is an Option rather than
 *   Some or None by the handle (ReadBack).
 * - Hc is the query's heading of carriers, a real member: the record of column carriers v mints variables over and an
 *   attachment mints its parent variables over. A find's is its head; a union's the arms' (UnionHeading); a recursive
 *   definition's its row.
 * - Cx is the union of the names of the contexts the query reads, at any depth of its rules, negations, imports,
 *   interiors and attachments: never for a query that reads none. It is carried contravariantly (`readsContexts`), so a
 *   query that reads contexts is still a query to every consumer that names no Cx; a role reads it off its query entries
 *   (types/schema/world.ts), and a derived definition must read none.
 *
 * query(S).
 */
export type QueryConstructor = <S extends AnySchema>(schema: S) => QueryBuilder<S>

export interface QueryBuilder<S> {
	/** A query of one arm: its heading, read-back heading and decoders the arm's. */
	rule<Head, Ev extends Evidence, P, IHead, Hc extends Carriers, Cx>(
		rule: (r: Rule<S>) => Finished<Head, Ev, P, S, IHead, Hc, Cx>
	): Query<S, Head, Ev, Simplify<P>, IHead, Hc, Cx>
	recursive<
		const Row extends Record<string, FieldBase>,
		const Base extends ReadonlyArray<(r: Rule<S>) => FinishedOver<FactOfFields<Row>>>,
		const Rec extends ReadonlyArray<
			(r: Rule<S>, self: SelfSource<Row>) => FinishedOver<FactOfFields<Row>>
		>
	>(
		/** The definition's facts are records of its row, decoded by the row's descriptors. */
		name: string,
		spec: { readonly row: Row; readonly base: Base; readonly rec: Rec }
	): Query<
		S,
		FactOfFields<Row>,
		Evidence.Unknown,
		Simplify<ArmParams<Base[number]> & ArmParams<Rec[number]>>,
		FactOfFields<Row>,
		Row,
		ArmContexts<Base[number]> | ArmContexts<Rec[number]>
	>
}

/**
 * A recursive definition's self, matched only in its recursive arms: a source of its row, whose fields are its heading.
 */
export interface SelfSource<Row> extends Source<FactOfFields<Row>>, Headed<Row> {}

type ArmParams<F> = UnionToIntersection<
	F extends (...args: never) => Phantom<{ readonly params: infer P }>
		? ParamsContribution<P>
		: never
>
type ArmContexts<F> = F extends (...args: never) => infer Fin ? ContextsOf<Fin> : never

/**
 * A query or ordered query over one of the levels L, whatever its heading, evidence, parameters and immediate
 * heading. Query is invariant in its schema and its parameters, so the level is distributed and the rest is read by
 * the base every query extends: QueryOver<L> is the base narrowed to one schema.
 */
export type QueryAt<L> = L extends unknown ? QueryOver<L> : never
export type OrderedAt<L> = L extends unknown ? OrderedOver<L> : never
/** An attachment child: a query or ordered query over S or a level below it. */
type Child<S> = QueryAt<LevelsOf<S>> | OrderedAt<LevelsOf<S>>

/**
 * What a query, ordered query or finished arm delivers: the records its rows decode to under the snapshot reading
 * (Head), and under the reading of a read inside a write transaction (IHead). Each is built by the combinator that made
 * the value: find's from its head (schema/record.ts record), a union's from its arms' by heading group (one record over
 * the carriers of arms of one key set, oneOf across key sets), an attachment's from its parent's and its child's (merge
 * with the stated delivery).
 */
export interface Decoders<out Head, out IHead> {
	readonly rows: RowDecoder<Head>
	readonly immediate: RowDecoder<IHead>
}

/**
 * A name that is one literal: an attachment's key in the records its decoder assembles (schema/record.ts named). The
 * alias carries N, so a builder that passes the name on infers N itself.
 */
export type OneName<N extends string> = N &
	(IsOneLiteral<N> extends true ? unknown : Refusal<"one literal name">)

/** A key of any arm of a heading: what an attachment's name must not be, and what one heading's arms all share. */
type KeyOfAnyArm<H> = H extends unknown ? keyof H : never
/**
 * The attachment's name is a field the parent's heading does not have (Query.attach: "a new field name for the
 * attachment").
 */
type FreshName<Name extends string, Head> = Requires<
	[Name] extends [KeyOfAnyArm<Head>] ? false : true,
	"a new field name for the attachment"
>
/**
 * An attachment's name: one literal, and a field the parent's heading does not have. One alias, so a builder that
 * passes the name on (query/build/attach.ts attachedDecoders) infers Name from it.
 */
export type AttachmentName<Name extends string, Head> = OneName<Name> & FreshName<Name, Head>
/**
 * One attachment statement delivers one heading (lower/conservative/deliver.ts): a child whose rows are a union of
 * records with different key sets is refused; a union of arms with one key set is one heading.
 */
type OneHeading<CH> = Requires<
	[KeyOfAnyArm<CH>] extends [keyof CH] ? true : false,
	"an attached heterogeneous union; one attachment statement delivers one heading"
>

/**
 * How an attachment delivers its child's records, as its author states it: every child ("array"), at most one
 * ("option"), exactly one ("one"), or the arm of one handle of an alternatives law (arm(field, handle)).
 */
export type DeliveryKind = Delivery | "arm"

/**
 * arm(field, handle): the attachment is the arm of `handle` of an alternatives law keyed by the parent's key, and
 * `field` the parent's head field that holds the parent's discriminator.
 */
export interface Arm<out K, out F, out Hd> {
	readonly kind: K
	readonly field: F
	readonly handle: Hd
}

/**
 * The delivery argument of attach: a delivery name, or an arm. K, the delivery's kind, is read off either: a name is its
 * own kind, an arm's kind is "arm"; F and Hd are an arm's field and handle.
 */
export type DeliveryArg<K, F, Hd> = (K & Delivery) | Arm<K, F, Hd>

/**
 * The records an attachment's parent decodes to, by the stated delivery: the parent's heading with the child's records
 * under Name as an array, an Option or the one child; or, for the arm of handle Hd held in field F, Some in the records
 * whose F is Hd and None in the others, so that narrowing on F narrows the attachment.
 */
export type AttachedHeads<Head, Name extends string, CH, F extends keyof Head, Hd> = {
	readonly [D in Delivery]: WithChild<Head, Name, CH, D>
} & { readonly arm: ArmSome<Head, Name, CH, F, Hd> | ArmNone<Head, Name, CH, F, Hd> }

export type WithChild<Head, Name extends string, CH, D extends Delivery> = Simplify<
	Head & { readonly [N in Name]: Delivered<CH>[D] }
>

export type ArmSome<Head, Name extends string, CH, F extends keyof Head, Hd> = Simplify<
	Head & { readonly [K in F]: Hd } & { readonly [N in Name]: Option.Some<CH> }
>

export type ArmNone<Head, Name extends string, CH, F extends keyof Head, Hd> = Simplify<
	Head & { readonly [K in F]: Exclude<Head[F], Hd> } & { readonly [N in Name]: Option.None<CH> }
>

/**
 * How each stated delivery is read inside a write transaction: the one child and an arm are Options there, since the
 * evidence a read-back may rely on proves at most one child where a snapshot read proves exactly one.
 */
export interface ReadBack {
	readonly array: "array"
	readonly option: "option"
	readonly one: "option"
	readonly arm: "option"
}

/**
 * What each parameter of a query may be bound to: a scalar parameter to a term of its type (an outer parameter of
 * it among them) or a literal; a relation parameter to a source.
 */
type BindingsFor<P> = {
	readonly [K in keyof P]: P[K] extends ReadonlyArray<infer Row> | Stream.Stream<infer Row>
		? Source<Row>
		: Term<P[K]> | LiteralOf<P[K]>
}

/**
 * A relation parameter bound to a query, bound import or interior stage reads that source's schema, so it must be a
 * level of the imported query's schema; the importing rule's level check on the bound import then covers it too.
 */
type BoundAtLevels<B, S> = {
	readonly [K in keyof B]: B[K] extends Phantom<{ readonly schema: Invariant<infer QS> }>
		? IsLevelOf<S, QS> extends true
			? unknown
			: Refusal<"the bound source is not over a level of the query's schema">
		: unknown
}
/** The contexts a binding object's bound sources read. */
type BindContexts<B> = { [K in keyof B]-?: ContextsOf<B[K]> }[keyof B]
/**
 * A relation parameter bound to a query consumes that query, so a parameterized one must be bound first, as for match:
 * `Q.bind({ ids: inner.bind({ ... }) })`. A scalar binding is a term, whose parameters the importing rule takes.
 */
type BoundSources<B> = {
	readonly [K in keyof B]: B[K] extends TermBase ? unknown : RequireBound<B[K]>
}

/**
 * The parameters a binding object leaves to the importing rule: its terms' own, outer parameters among them, and what
 * each bound source contributes.
 */
type BindParams<B> = UnionToIntersection<
	{
		[K in keyof B]-?: ParamsContribution<
			B[K] extends Phantom<{ readonly sourceParams: infer SP }> ? SP : ParamsOfTerm<B[K]>
		>
	}[keyof B]
>

/**
 * Any query, any ordered query and any finished arm: the members every runtime value of each has, its decoders among
 * them. Query and Ordered are invariant in their schema and parameters, so no instance of them is universal;
 * QueryOver<S> is any query over S, whatever its heading, evidence, parameters and immediate heading, and
 * OrderedOver<S> the same for an ordered one.
 */
export interface QueryBase extends Built, Decoders<unknown, unknown> {
	named(name: string): QueryBase
}

export interface QueryOver<in out S>
	extends QueryBase, Phantom<{ readonly schema: Invariant<S> }> {}

export interface OrderedBase extends Built, Decoders<unknown, unknown> {
	take(k: number): QueryBase
}
interface OrderedOver<in out S> extends OrderedBase, Phantom<{ readonly schema: Invariant<S> }> {}
/**
 * A finished arm of heading exactly Head, whatever its evidence, parameters, immediate heading and carriers: the
 * members every Finished of that heading has. A recursive definition's arms are read through it, so an arm's head is
 * the row's, no field added and none of a narrower type (headingInvariant); attach is no member of it, since its child
 * reads the arm's own carriers.
 */
export interface FinishedOver<in out Head>
	extends
		Phantom<{
			readonly headingInvariant: Invariant<Head>
			readonly evidence: Evidence
			readonly params: unknown
		}>,
		Headed<Carriers> {
	readonly rows: RowDecoder<Head>
}

/**
 * The phantoms of a query: its heading as a source, its schema invariantly, its evidence, its parameters, read and
 * carried invariantly, and the contexts it reads, contravariantly.
 */
interface QueryPhantom<S, Head, Ev, P, Cx> {
	readonly heading: Head
	readonly sourceParams: unknown
	readonly schema: Invariant<S>
	readonly evidence: Ev
	readonly params: P
	readonly paramsInvariant: Invariant<P>
	readonly readsContexts: (read: Cx) => void
}

/**
 * A query is a source over its schema: `schema: Invariant<S>` (SchemaSource) is what makes Query<Ext> no Query<Base>,
 * and what lets a rule refuse to match a query over a level above its own.
 */
export interface Query<
	S,
	Head,
	Ev extends Evidence = Evidence.Unknown,
	P = unknown,
	IHead = Head,
	Hc extends Carriers = HeadingCarriers<Head>,
	Cx = never
>
	extends SchemaSource<S, Head>, Headed<Hc>, Decoders<Head, IHead> {
	readonly [phantom]?: QueryPhantom<S, Head, Ev, P, Cx> | undefined

	/**
	 * An additional arm. Its heading may differ from Head; arms of different headings must share a literal
	 * discriminant, checked by the compiler. The records are either arm's: arms of one heading key set decode as one
	 * record over their carriers, arms of different key sets by oneOf. The union's evidence is what the engine proves of
	 * a union of one heading (UnionEvidence): fields every arm fixes alike, and keys its literals tell apart.
	 */
	rule<Head2, Ev2 extends Evidence, P2, IHead2, Hc2 extends Carriers, Cx2>(
		rule: (r: Rule<S>) => Finished<Head2, Ev2, P2, S, IHead2, Hc2, Cx2>
	): Query<
		S,
		Head | Head2,
		UnionEvidence<Ev, Ev2, Head, Head2>,
		Simplify<P & P2>,
		IHead | IHead2,
		UnionHeading<Hc, Hc2>,
		Cx | Cx2
	>
	/**
	 * A nested sub-result per parent fact, delivered as its author states: every child, an Option, the one child, or
	 * an alternatives arm (AttachedHeads). The parent set is unchanged. The child's evidence must prove the stated
	 * delivery (DeliveryClaim, checked on the child the callback returns: a claim on the delivery argument would be read
	 * before the callback is, when the child is not yet inferred), and the analysis proves it again where the program
	 * binds its decoder. Parent variables are inputs to the child, minted over the parent's heading, and keep the
	 * origins the parent's evidence records.
	 */
	attach<
		const Name extends string,
		C extends Child<S>,
		CH,
		CI,
		const K extends DeliveryKind,
		const F extends keyof Head & string,
		const Hd extends string
	>(
		name: AttachmentName<Name, Head>,
		child: (
			parent: ParentVars<Hc, Ev>
		) => C &
			Decoders<CH, CI> &
			DeliveryClaim<K, F, Hd, EvidenceOfQuery<C>, Ev, Head> &
			OneHeading<CH>,
		delivery: DeliveryArg<K, F, Hd>
	): Query<
		S,
		AttachedHeads<Head, Name, CH, F, Hd>[K],
		Ev,
		Simplify<P & ParamsOf<C>>,
		WithChild<IHead, Name, CI, ReadBack[K]>,
		Hc,
		Cx | ContextsOf<C>
	>
	named(name: string): Query<S, Head, Ev, P, IHead, Hc, Cx>
	/** The bound import keeps the query's schema, so matching it is checked against the importing rule's levels. */
	bind<const B extends BindingsFor<P>>(
		bindings: B & NoExcess<B, P> & BoundAtLevels<B, S> & BoundSources<B>
	): BoundSource<S, Head, BindParams<B>, Hc, Cx | BindContexts<B>>
	orderBy(
		...order: ReadonlyArray<readonly [CommonKeys<Head> & string, "asc" | "desc"]>
	): Ordered<S, Head, Ev, P, IHead, Hc, Cx>
	approximateNearest(
		spec: ApproximateNearestSpec<Head>
	): Query<S, Head, Evidence.Unknown, P, IHead, Hc, Cx>
}

/** A source over S that holds its heading of carriers: a bound import or an interior stage, reading the contexts Cx. */
export interface BoundSource<S, Head, SP, Hc, Cx = never> extends Built, Headed<Hc> {
	readonly [phantom]?:
		| {
				readonly heading: Head
				readonly sourceParams: SP
				readonly schema: Invariant<S>
				readonly readsContexts: (read: Cx) => void
		  }
		| undefined
}

/**
 * The carriers a heading's host types determine: a key of any arm, of its type across the arms that have it, of an
 * unknown SQL type. The default of a query written without its carriers.
 */
type HeadingCarriers<Head> = {
	readonly [K in Head extends unknown ? keyof Head : never]: {
		readonly column: Column<Head extends unknown ? (K extends keyof Head ? Head[K] : never) : never>
		readonly sql: SqlTag
	}
}

/**
 * S is the schema of the rule that finished the arm (Rule<S>.find), so an arm's attachment child is over one of its
 * levels, as Query.attach requires. The heading is invariant (headingInvariant), so an arm read as a FinishedOver has
 * exactly the heading it is read at. A Finished written without a
 * schema has none, so it attaches nothing until it is read as the Finished of a rule over a schema.
 */
export interface Finished<
	Head,
	Ev extends Evidence,
	P = unknown,
	S = never,
	IHead = Head,
	Hc extends Carriers = HeadingCarriers<Head>,
	Cx = never
>
	extends
		Phantom<{
			readonly headingInvariant: Invariant<Head>
			readonly evidence: Ev
			readonly params: P
			readonly readsContexts: (read: Cx) => void
		}>,
		Headed<Hc>,
		Decoders<Head, IHead> {
	/** An arm may attach before it joins a union; the arm keeps its own attached heading. */
	attach<
		const Name extends string,
		C extends Child<S>,
		CH,
		CI,
		const K extends DeliveryKind,
		const F extends keyof Head & string,
		const Hd extends string
	>(
		name: AttachmentName<Name, Head>,
		child: (
			parent: ParentVars<Hc, Ev>
		) => C &
			Decoders<CH, CI> &
			DeliveryClaim<K, F, Hd, EvidenceOfQuery<C>, Ev, Head> &
			OneHeading<CH>,
		delivery: DeliveryArg<K, F, Hd>
	): Finished<
		AttachedHeads<Head, Name, CH, F, Hd>[K],
		Ev,
		Simplify<P & ParamsOf<C>>,
		S,
		WithChild<IHead, Name, CI, ReadBack[K]>,
		Hc,
		Cx | ContextsOf<C>
	>
}

export interface Ordered<
	S,
	Head,
	Ev extends Evidence = Evidence.Unknown,
	P = unknown,
	IHead = Head,
	Hc extends Carriers = HeadingCarriers<Head>,
	Cx = never
>
	extends
		Headed<Hc>,
		Decoders<Head, IHead>,
		Phantom<{
			readonly evidence: Ev
			readonly params: P
			readonly paramsInvariant: Invariant<P>
			readonly schema: Invariant<S>
			readonly readsContexts: (read: Cx) => void
		}> {
	/**
	 * The first k under the completed total order; a set again; take(1) is atMostOne (TakeEvidence). k is a positive
	 * literal, or the name of an integer parameter, take("batch"), which joins the query's parameters as pg.integer.
	 */
	take<const K extends number | string>(
		k: K
	): Query<
		S,
		Head,
		TakeEvidence<Ev, K>,
		K extends string ? Simplify<P & { readonly [N in K]: number }> : P,
		IHead,
		Hc,
		Cx
	>
}

/**
 * v(source): fresh variables, one per carrier of the source's heading, each carrying the relation and field it came
 * from where the source is a relation.
 */
export type VConstructor = <R extends VSource>(source: R) => VarsOf<R>

/** Over a union, the keys common to every arm; the discriminant is always common. */
export type CommonKeys<Head> = keyof Head

/** The records a query, ordered query or finished arm delivers: its rows decoder's. */
export type HeadOf<Q> = Q extends { readonly rows: RowDecoder<infer H> } ? H : never
/** Readers of a query's phantoms. */
export type EvidenceOfQuery<Q> =
	Q extends Phantom<infer B>
		? B extends { readonly evidence: infer E extends Evidence }
			? E
			: Evidence.Unknown
		: Evidence.Unknown

/**
 * The contexts a query reads, at any depth of its rules, imports and attachments: a phantom its rules collect from the
 * contexts they match, carried contravariantly (`readsContexts`) so that a query reading contexts is still a query to
 * every consumer that names none.
 */
export type ContextsOf<Q> =
	Q extends Phantom<infer B>
		? B extends { readonly readsContexts: (read: infer C) => void }
			? C
			: never
		: never
/** The records a query delivers to a read inside a write transaction, a read-back: its immediate decoder's. */
export type ImmediateHeadOf<Q> = Q extends { readonly immediate: RowDecoder<infer I> } ? I : never
/** An array or Stream member contributes no named parameter; a query, ordered query or ChangeSet its own map. */
export type ParamsOf<X> = X extends
	| ReadonlyArray<unknown>
	| Stream.Stream<unknown, unknown, unknown>
	? unknown
	: ParamsOfTerm<X>
