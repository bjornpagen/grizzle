import type { Option, Stream } from "effect"
import type { Delivered, Delivery, FieldHost, RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, phantom, Phantom } from "#compiler/core/phantom.ts"
import type { Requires } from "#compiler/types/compute/scalar.ts"
import type {
	Carrier,
	Carriers,
	ConstantValuesOf,
	DeclaredName,
	DomainOf,
	FactsOf,
	Headed,
	InputTerm,
	Invariant,
	IsOneLiteral,
	IsRetyped,
	LanguageOf,
	Meets,
	Minted,
	OperandOrigin,
	ParamsContribution,
	ParamsOfTerm,
	ParamType,
	Refusal,
	SchemaSource,
	Simplify,
	Source,
	SqlOfCarrier,
	TypeRefusal,
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
import type { Rule } from "#compiler/types/query/rule.ts"
import type {
	Aggregate,
	NoExcess,
	ParentVars,
	Producer,
	HeadedBy,
	SourceNamed,
	ShownOrigins,
	VSource
} from "#compiler/types/query/terms.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"
import type { AnySchema, LevelsOf } from "#compiler/types/schema/schema.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"
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
export type QueryConstructor = <S extends AnySchema | AnyRole>(schema: S) => QueryBuilder<S>

export interface QueryBuilder<S> {
	/** A query of one arm: its heading, read-back heading and decoders the arm's, attached or not. */
	rule<Head, Ev extends Evidence, P, IHead, Hc extends Carriers, Cx>(
		rule: (r: Rule<S>) => Finished<Head, Ev, P, S, IHead, Hc, Cx>
	): Query<S, Head, Ev, Simplify<P>, IHead, Hc, Cx, readonly [ArmOf<Head, Hc>]>
	recursive<
		const Row extends Record<string, FieldBase>,
		const Base extends ReadonlyArray<FinishedArm>,
		const Rec extends ReadonlyArray<FinishedArm>
	>(
		/**
		 * The definition's facts are records of its row, decoded by the row's descriptors; every arm's head delivers the
		 * row (ArmDelivers), checked at the arm once its head is inferred; and each arm list holds an arm (SomeArm).
		 */
		name: string,
		spec: {
			readonly row: Row
			readonly base: {
				readonly [I in keyof Base]: (r: Rule<S>) => Base[I] & NoInfer<ArmDelivers<Base[I], Row>>
			} & NoInfer<SomeArm<Base, Rec>>
			readonly rec: {
				readonly [I in keyof Rec]: (
					r: Rule<S>,
					self: SelfSource<Row>
				) => Rec[I] & NoInfer<ArmDelivers<Rec[I], Row>>
			} & NoInfer<SomeArm<Rec, Base>>
		}
	): Query<
		S,
		FactOfFields<Row>,
		Evidence.Unknown,
		Simplify<ArmParams<Base[number]> & ArmParams<Rec[number]>>,
		FactOfFields<Row>,
		Row,
		ContextsOf<Base[number]> | ContextsOf<Rec[number]>,
		readonly [UnionArm<Row, never, "recursive", false>]
	>
}

/**
 * The refusal of an empty arm list of a recursion, none for a list of arms: the fixed point starts from its base arms
 * and grows by its recursive ones, so each list holds one at least. It refuses once the other list's arms are inferred
 * (their tuple's length is known), so the call's first inference, which leaves the arms' callbacks for later, never
 * fails on it, and the other list's arms are checked under the types they infer.
 */
type SomeArm<Arms, Other extends ReadonlyArray<unknown>> = Arms extends readonly []
	? number extends Other["length"]
		? unknown
		: Refusal<"a recursion has at least one base arm and at least one recursive arm">
	: unknown

/**
 * A recursive definition's self, matched only in its recursive arms: a source of its row, whose fields are its heading.
 */
export interface SelfSource<Row> extends Source<FactOfFields<Row>>, Headed<Row> {}

type ArmParams<F> = UnionToIntersection<
	F extends Phantom<{ readonly params: infer P }> ? ParamsContribution<P> : never
>

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

/**
 * A scope's name, as v takes it: one literal, which its variables' origins carry, kept to the declared-name rule's
 * characters (DeclaredName), which the builder checks again only for a JavaScript caller. The alias carries N, so v
 * infers N from it.
 */
export type ScopeName<N extends string> = N &
	(IsOneLiteral<N> extends true ? DeclaredName<N> : Refusal<"one literal name">)

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
 * What each parameter of a query may be bound to: a scalar parameter to a term that meets its type (Meets), an outer
 * parameter of it among them, or a JavaScript value of its language; a relation parameter to a source of its rows, a
 * relation parameter of the importing rule (RelationBindings).
 */
type BindingsFor<P> = {
	readonly [K in keyof P]: P[K] extends ReadonlyArray<infer Row> | Stream.Stream<infer Row>
		? Source<Row>
		: P[K] extends ParamType<infer D, infer Sql, infer L>
			? Meets<D, Sql> | LiteralOf<L>
			: never
}

/**
 * A relation parameter is bound to a relation parameter of the importing rule, `r.relation(name, heading)`, the one
 * source a Description holds as a binding (query/build/query.ts bindQuery): a query, a bound import, an interior stage
 * or a recursive definition's self is refused, whatever schema it is over.
 */
type RelationBindings<B, P> = {
	readonly [K in keyof B]: K extends keyof P
		? P[K] extends ReadonlyArray<unknown> | Stream.Stream<unknown>
			? IsRelationParameter<B[K]> extends true
				? unknown
				: Refusal<"a relation parameter binds a relation parameter of the importing rule, r.relation(name, heading)">
			: unknown
		: unknown
}
/** A relation parameter: a source over no schema that contributes its one name to the rule that matches it. */
type IsRelationParameter<X> =
	X extends Phantom<{ readonly schema: unknown }>
		? false
		: X extends Phantom<{ readonly sourceParams: infer SP }>
			? IsOneLiteral<keyof SP>
			: false
/** The origins a binding object's terms read, on which the facts of the import it binds depend. */
type BindReads<B> = { [K in keyof B]-?: OperandOrigin<B[K]> }[keyof B]

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
 * A finished arm, whatever its heading, evidence, parameters, immediate heading and carriers: the members every Finished
 * has. A recursive definition's arms are read through it, each head held to the row by ArmDelivers; attach is no member
 * of it, since its child reads the arm's own carriers.
 */
export interface FinishedArm
	extends Phantom<{ readonly evidence: Evidence; readonly params: unknown }>, Headed<Carriers> {
	readonly rows: RowDecoder<unknown>
}

/**
 * Whether an arm's head delivers the row Row: exactly its fields, none missing and none added, each carrier standing
 * at its field (StandsAt). Compilation then proves a computed exact value fits its field, or refuses it
 * (PartialOperation).
 */
type ArmDelivers<ArmResult, Row> =
	ArmResult extends Headed<infer Hc>
		? Requires<
				DeliversRow<Hc, Row>,
				"an arm's head delivers the row: each of its fields, at a type that meets the field's"
			>
		: unknown
type DeliversRow<Hc, Row> =
	SameKeys<Hc, Row> extends true
		? false extends { [K in keyof Row & keyof Hc]-?: StandsAt<Hc[K], Row[K]> }[keyof Row & keyof Hc]
			? false
			: true
		: false

/**
 * Whether a head's carrier X stands at the field F as a binding stands at it (Bindings): a JavaScript value of F's
 * language, or a term of X's domain and SQL type that meets F's type (Meets), a computed exact value of a plain integer
 * or money field's family among them.
 */
type StandsAt<X, F> =
	IsRetyped<X> extends true
		? [FieldHost<X>] extends [LiteralOf<LanguageOf<F>>]
			? true
			: false
		: [InputTerm<DomainOf<X>, unknown, unknown, SqlOfCarrier<X>>] extends [
					Meets<DomainOf<F>, SqlOfCarrier<F>>
			  ]
			? true
			: false

/**
 * The phantoms of a query: its heading as a source, its schema invariantly, its evidence, its parameters, read and
 * carried invariantly, the contexts it reads, contravariantly, and its arms' carriers (Query's Arms).
 */
interface QueryPhantom<S, Head, Ev, P, Cx, Arms> {
	readonly heading: Head
	readonly sourceParams: unknown
	readonly schema: Invariant<S>
	readonly evidence: Ev
	readonly params: P
	readonly paramsInvariant: Invariant<P>
	readonly readsContexts: (read: Cx) => void
	readonly arms: Arms
}

/**
 * A query is a source over its schema: `schema: Invariant<S>` (SchemaSource) is what makes Query<Ext> no Query<Base>,
 * and what lets a rule refuse to match a query over a level above its own. Arms is each arm, in order, the arms a
 * further rule joins as the checker flattens a union's (UnionArm): a query of one rule is its own one arm; a take, an
 * approximate search or an attachment is one arm, of the columns a union delivers and no head constant over a union
 * (AsOneArm), attached wherever its records carry an attachment (AttachedNames).
 */
export interface Query<
	S,
	Head,
	Ev extends Evidence = Evidence.Unknown,
	P = unknown,
	IHead = Head,
	Hc extends Carriers = HeadingCarriers<Head>,
	Cx = never,
	Arms extends UnionArms = readonly [ArmOf<Head, Hc>]
>
	extends SchemaSource<S, Head>, Headed<Hc>, Decoders<Head, IHead> {
	readonly [phantom]?: QueryPhantom<S, Head, Ev, P, Cx, Arms> | undefined

	/**
	 * An additional arm. Its heading may differ from Head. The arms join as the checker unions them (ArmsMeet): arms of
	 * one heading meet at every field, none of them attached, and arms of different headings share a literal
	 * discriminant, a combination of fields telling every two apart; a stage over a union of several headings is no arm.
	 * The check is on the arm the callback returns, as attach's DeliveryClaim is: an intersection with the callback
	 * itself would be read before the arm is inferred, and leave it its constraint. The records are either arm's: arms
	 * of one heading key set decode as one record over their carriers, arms of different key sets by oneOf. The union's
	 * evidence is what the engine proves of a union of one heading (UnionEvidence): fields every arm fixes alike, and
	 * keys its literals tell apart.
	 */
	rule<Head2, Ev2 extends Evidence, P2, IHead2, Hc2 extends Carriers, Cx2>(
		rule: (
			r: Rule<S>
		) => Finished<Head2, Ev2, P2, S, IHead2, Hc2, Cx2> & ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>
	): Query<
		S,
		Head | Head2,
		UnionEvidence<Ev, Ev2, Head, Head2>,
		Simplify<P & P2>,
		IHead | IHead2,
		UnionHeading<Hc, Hc2>,
		Cx | Cx2,
		readonly [...Arms, ArmOf<Head2, Hc2>]
	>
	/**
	 * A nested sub-result per parent fact, delivered as its author states: every child, an Option, the one child, or
	 * an alternatives arm (AttachedHeads). The parent set is unchanged. The child's evidence must prove the stated
	 * delivery (DeliveryClaim, checked on the child the callback returns: a claim on the delivery argument would be read
	 * before the callback is, when the child is not yet inferred), and the analysis proves it again where the program
	 * binds its decoder. Parent variables are inputs to the child, minted over the columns the parent delivers
	 * (DeliveredHeading), and keep the origins the parent's evidence records.
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
			parent: ParentVars<DeliveredHeading<Head, Hc>, Ev>
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
		Cx | ContextsOf<C>,
		readonly [
			UnionArm<
				AsOneArm<Arms, Head, Hc>["carriers"],
				AttachedNames<AttachedHeads<Head, Name, CH, F, Hd>[K], Hc>,
				"attach",
				AsOneArm<Arms, Head, Hc>["bounded"]
			>
		]
	>
	named(name: string): Query<S, Head, Ev, P, IHead, Hc, Cx, Arms>
	/**
	 * The bound import keeps the query's schema, so matching it is checked against the importing rule's levels, and its
	 * evidence, whose keys a match of it reads, with what its bindings read.
	 */
	bind<const B extends BindingsFor<P>>(
		bindings: B & NoExcess<B, P> & RelationBindings<B, P>
	): BoundSource<S, Head, BindParams<B>, Hc, Cx, Ev, BindReads<B>>
	/** An order over the columns the query delivers (DeliveredKeys): never a field only some arms have, or an attachment. */
	orderBy(
		...order: ReadonlyArray<readonly [DeliveredKeys<Head, Hc> & string, "asc" | "desc"]>
	): Ordered<S, Head, Ev, P, IHead, Hc, Cx, Arms>
	/**
	 * A search over one rule's projection, its source as the checker reads it (SearchSource), ranked by a distance of its
	 * carriers. The search keeps a subset of its source's facts, at most `take` of them, so its evidence is a take's of
	 * the source's (TakeEvidence), as the engine proves of the sealed node.
	 */
	approximateNearest<const K extends number>(
		spec: SearchSource<AsOneArm<Arms, Head, Hc>, K>
	): Query<
		S,
		Head,
		TakeEvidence<Ev, K>,
		P,
		IHead,
		Hc,
		Cx,
		readonly [
			UnionArm<
				Unconstant<AsOneArm<Arms, Head, Hc>["carriers"]>,
				AttachedNames<Head, Hc>,
				"approximate",
				AsOneArm<Arms, Head, Hc>["bounded"]
			>
		]
	>
}

/**
 * The stage that made a query's one arm, as the checker reads the node it built (check/approximate/trace.ts
 * sourceShape): a rule's head, the union of several arms read as one, a take, an attachment, an approximate search or
 * a recursive definition. A name and an order make no node of their own.
 */
export type ArmStage = "rule" | "union" | "take" | "attach" | "approximate" | "recursive"

/**
 * An arm of a union as the checker groups it (check/checker.ts Checker.union): its heading of carriers; the names of
 * the attachments its rows carry (AttachedNames), never for an arm that attaches nothing, which the checker refuses
 * beside another arm of its heading; the stage that made it; and whether a take bounds its rows, under every stage
 * above that take.
 */
export interface UnionArm<
	out C extends Carriers,
	out Attached extends PropertyKey,
	out Stage extends ArmStage,
	out Bounded extends boolean
> {
	readonly carriers: C
	readonly attached: Attached
	readonly stage: Stage
	readonly bounded: Bounded
}

/** A query's arms, in order. */
export type UnionArms = ReadonlyArray<AnyArm>
type AnyArm = UnionArm<Carriers, PropertyKey, ArmStage, boolean>

/**
 * The attachments an arm's records, Head, carry over its carriers, Hc: the keys of the records the carriers lack, each
 * a nested delivery (AttachedHeads), under whatever stage keeps the records, as the checker reads them off the arm's
 * rows (check/checker.ts #carried); never for an arm that attaches nothing.
 */
type AttachedNames<Head, Hc> = Exclude<KeyOfAnyArm<Head>, keyof Hc>

/**
 * The columns a query of records Head over the carriers Hc delivers, as the checker heads it (check/checker.ts
 * Checker.union): of one arm its own, of a union the columns every arm has; never an attachment. Every combinator over
 * the query reads these: an order's keys, an attachment's parent variables, a take's or a search's arm.
 */
export type DeliveredKeys<Head, Hc> = keyof Head & keyof Hc

/** The carriers of the columns a query delivers (DeliveredKeys). */
export type DeliveredHeading<Head, Hc> = { readonly [K in DeliveredKeys<Head, Hc>]: Hc[K] }

/** Whether a query's records are of several key sets: a union of several headings, delivered per heading group. */
type Heterogeneous<Head> = [KeyOfAnyArm<Head>] extends [keyof Head] ? false : true

/** The arm a rule of records Head over the carriers Hc is to a further rule. */
type ArmOf<Head, Hc extends Carriers> = UnionArm<Hc, AttachedNames<Head, Hc>, "rule", false>

/**
 * A query of arms Arms, records Head and carriers Hc read as one arm, as a stage over it reads it: its one arm, or, over
 * a union, one arm of the columns the union delivers (DeliveredHeading) with no head constant, since the checker records
 * none for a union, carrying every arm's attachments.
 */
type AsOneArm<Arms extends UnionArms, Head, Hc extends Carriers> = Arms extends readonly [
	infer A extends AnyArm
]
	? A
	: UnionArm<Unconstant<DeliveredHeading<Head, Hc>>, AttachedNames<Head, Hc>, "union", false>

/** A heading of carriers as an arm that holds no head constant: each carrier's type, values, facts and language. */
type Unconstant<Hc> = {
	readonly [K in keyof Hc]: Carrier<
		FieldHost<Hc[K]>,
		SqlOfCarrier<Hc[K]>,
		DomainOf<Hc[K]>,
		FactsOf<Hc[K]>,
		LanguageOf<Hc[K]>
	>
}

/**
 * The refusal of an approximate search over a source no one index orders, as the checker refuses its node
 * (check/approximate/trace.ts sourceShape): anything but one rule's projection.
 */
interface SearchRefusals {
	readonly union: "approximateNearest over one rule's projection; this source is a union of rules, which no single index orders"
	readonly take: "approximateNearest over one rule's projection; this source is a bounded subset, whose own order already selects among the rows"
	readonly attach: "approximateNearest over one rule's projection; this source is a query with attachments"
	readonly approximate: "approximateNearest over one rule's projection; this source is another approximate search"
	readonly recursive: "approximateNearest over one rule's projection; this source is a recursive relation"
	readonly aggregate: "approximateNearest over one rule's projection; this source is an aggregate rule, whose output is a nonlinear fold rather than a distance of one stored vector"
	readonly producer: "approximateNearest over one rule's projection; this source is a rule whose head produces spans, facts per binding rather than its projection"
}
/**
 * What an approximate search over the arm A takes: a spec ranking by a distance of A's carriers and taking K facts
 * (ApproximateNearestSpec), or, over a source no one index orders, the refusal the checker names.
 */
type SearchSource<A extends AnyArm, K extends number> = A["stage"] extends keyof SearchRefusals
	? RefusedSearch<SearchRefusals[A["stage"]], K>
	: [A["attached"]] extends [never]
		? HeadSearch<A["carriers"], K>
		: RefusedSearch<SearchRefusals["attach"], K>

/**
 * A search over a rule's head of carriers Hc: refused over a head that folds or produces spans, whose node the checker
 * reads as no projection of the rule (check/approximate/trace.ts sourceShape), and otherwise ranked by a distance of Hc.
 */
type HeadSearch<Hc, K extends number> = [CarriersOfKind<Hc, Aggregate<unknown, never>>] extends [
	never
]
	? [CarriersOfKind<Hc, Producer<unknown, never>>] extends [never]
		? ApproximateNearestSpec<Hc, K>
		: RefusedSearch<SearchRefusals["producer"], K>
	: RefusedSearch<SearchRefusals["aggregate"], K>

/**
 * The spec of a search over a source the checker refuses: its refusal, beside any by and take, so the argument as a
 * whole is refused and its diagnostic prints the refusal, whatever it ranks by.
 */
type RefusedSearch<M extends TypeRefusal, K extends number> = Refusal<M> & {
	readonly by: string
	readonly take: K
}

/** The fields of a head of carriers whose terms are of kind X: never a term refused already, which is never. */
type CarriersOfKind<Hc, X> = {
	readonly [K in keyof Hc]-?: [Hc[K]] extends [never] ? never : Hc[K] extends X ? K : never
}[keyof Hc]

/**
 * A union of several headings delivered per heading group under a take already, which a second take or a page would
 * bound across the groups no group statement sees (lower/conservative/deliver.ts heterogeneousPlan).
 */
type BoundGroups<Arms extends UnionArms, Head, Hc extends Carriers> = [
	Heterogeneous<Head>,
	AsOneArm<Arms, Head, Hc>["bounded"]
] extends [true, true]
	? true
	: false

/** A take over a query: refused over a union of several headings a take bounds already (BoundGroups). */
type OneTakeOverGroups<Arms extends UnionArms, Head, Hc extends Carriers> =
	BoundGroups<Arms, Head, Hc> extends true
		? Refusal<"one take over a union of several headings: each heading group is a statement of its own, which one take bounds and the merge across them keeps">
		: unknown

/** A page over an ordered query: refused over a union of several headings a take bounds (BoundGroups). */
export type PageOverGroups<Arms extends UnionArms, Head, Hc extends Carriers> =
	BoundGroups<Arms, Head, Hc> extends true
		? Refusal<"a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union's first k">
		: unknown

/** A page over the ordered query Q, read off its arms, records and carriers (PageOverGroups). */
export type PageOf<Q> = Q extends Phantom<infer B> & Headed<infer Hc extends Carriers>
	? B extends { readonly arms: infer Arms extends UnionArms }
		? PageOverGroups<Arms, HeadOf<Q>, Hc>
		: unknown
	: unknown

/**
 * A source over S that holds its heading of carriers: a bound import or an interior stage, reading the contexts Cx. Ev
 * is the evidence of the query it imports or the arm it stages, whose keys a match of it reads (evidence/evidence.ts
 * SourceKeys), and Rd the origins its bindings read, on which the facts it holds depend.
 */
export interface BoundSource<S, Head, SP, Hc, Cx, Ev, Rd> extends Built, Headed<Hc> {
	readonly [phantom]?:
		| {
				readonly heading: Head
				readonly sourceParams: SP
				readonly schema: Invariant<S>
				readonly readsContexts: (read: Cx) => void
				readonly evidence: Ev
				readonly reads: Rd
		  }
		| undefined
}

/**
 * Whether an arm New joins a query's arms, in order, as the checker unions them (check/checker.ts Checker.union),
 * judged over every arm at once, so three or more arms are judged arm by arm:
 * - the query of records Head is no one stage over a union of several headings (GroupedArm), the checker's first
 *   refusal: as an arm it would deliver the columns its heading groups share alone;
 * - no two arms of one heading key set, one of them attached, since a fact can come from both and which arm's
 *   attachment it carries is undetermined (SharesAttachedHeading);
 * - every two arms that share a field meet at it (KeyMeets), as the checker types a union's column, a JavaScript
 *   value at the type the union's typed arms give it (#positions), or the union is refused;
 * - arms of different headings need a discriminant (MissingDiscriminant): the fields every arm has, where every arm
 *   holds a constant; every two arms of different headings hold different constants at one of them, whatever
 *   combination of fields tells them apart. Constants are compared by value (Apart), and a constant whose value the
 *   types do not carry is taken to differ from every other.
 */
type ArmsMeet<Arms extends UnionArms, Head, New extends AnyArm> =
	GroupedArm<Arms, Head> extends true
		? Refusal<"an arm over a union of several headings: only a query's result delivers each heading group">
		: true extends SharesAttachedHeading<Arms[number], New>
			? Refusal<"an attachment on an arm of a union whose heading several arms share">
			: UnionRefusal<CarriersOfArm<Arms[number]> | New["carriers"]>
/** Whether a query of arms Arms and records Head is one stage over a union of several headings. */
type GroupedArm<Arms extends UnionArms, Head> = Arms extends readonly [AnyArm]
	? Heterogeneous<Head>
	: false
type CarriersOfArm<A> = A extends AnyArm ? A["carriers"] : never
/** Whether an earlier arm A has New's heading key set, one of the two carrying an attachment. */
type SharesAttachedHeading<A, New extends AnyArm> = A extends AnyArm
	? SameKeys<A["carriers"], New["carriers"]> extends true
		? [A["attached"] | New["attached"]] extends [never]
			? false
			: true
		: false
	: never
type UnionRefusal<All> =
	true extends Mismatched<All, All>
		? Refusal<"a union's arms deliver each field at one type">
		: true extends Indistinct<All, All, DiscriminantOf<All, keyof All>>
			? Refusal<"arms of different headings share a field that holds a different constant in each">
			: unknown
/** Whether some two arms, X and Y among All, deliver a field they share at types that do not meet. */
type Mismatched<X, All> = X extends unknown
	? All extends unknown
		? false extends { [K in keyof X & keyof All]-?: KeyMeets<X[K], All[K]> }[keyof X & keyof All]
			? true
			: false
		: never
	: never
/** The discriminant's fields among the fields Ks every arm has: those where every arm holds a constant. */
type DiscriminantOf<All, Ks> = {
	[K in Ks & PropertyKey]-?: true extends NoConstantAt<All, K> ? never : K
}[Ks & PropertyKey]
type NoConstantAt<All, K> = All extends unknown
	? K extends keyof All
		? [ConstantValuesOf<All[K]>] extends [never]
			? true
			: false
		: true
	: never
/** Whether some two arms of different groups, X and Y among All, hold the same constant at every field of D. */
type Indistinct<X, All, D> = X extends unknown
	? All extends unknown
		? SameKeys<X, All> extends true
			? false
			: true extends {
						[K in D & keyof X & keyof All]-?: Apart<
							ConstantValuesOf<X[K]>,
							ConstantValuesOf<All[K]>
						>
				  }[D & keyof X & keyof All]
				? false
				: true
		: never
	: never
type SameKeys<A, B> = [keyof A] extends [keyof B]
	? [keyof B] extends [keyof A]
		? true
		: false
	: false
/**
 * Whether two arms' constants at a field tell their rows apart, as the checker compares the literals typed at the
 * field: unless each is one value the types carry, and the two are one value. A contract's constant is read as its
 * base's value (LiteralOf), so a Compute.literal of a contract, whose type is the whole branded base, is no one value.
 */
type Apart<X, Y> = [OneKnown<LiteralOf<X>>] extends [never]
	? true
	: [OneKnown<LiteralOf<Y>>] extends [never]
		? true
		: Same<OneKnown<LiteralOf<X>>, OneKnown<LiteralOf<Y>>> extends true
			? false
			: true
/**
 * A constant's one value as the checker compares it, a number and a bigint by their spelling, which a field both
 * meet types alike; never where the types carry no one value: a Decimal, a Money, a typed Compute.literal's, a value
 * of a non-literal type.
 */
type OneKnown<V> = [V] extends [UnionToIntersection<V>]
	? V extends string
		? IsOneLiteral<V> extends true
			? V
			: never
		: V extends number | bigint
			? number extends V
				? never
				: bigint extends V
					? never
					: `${V}`
			: V extends boolean
				? V
				: never
	: never
type KeyMeets<X, Y> =
	IsRetyped<X> extends true
		? IsRetyped<Y> extends true
			? Same<SqlOfCarrier<X>, SqlOfCarrier<Y>>
			: LiteralMeets<X, Y>
		: IsRetyped<Y> extends true
			? LiteralMeets<Y, X>
			: TypedMeets<X, Y>
type TypedMeets<X, Y> =
	Same<SqlOfCarrier<X>, SqlOfCarrier<Y>> extends true ? Same<DomainOf<X>, DomainOf<Y>> : false
/**
 * A JavaScript value's carrier L beside a typed carrier T: T's type when T's language admits L's values, else L's
 * default.
 */
type LiteralMeets<L, T> = [FieldHost<L>] extends [LiteralOf<LanguageOf<T>>]
	? true
	: TypedMeets<L, T>
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * The carriers a heading's host types determine: a key of any arm, of its type across the arms that have it, which is
 * its domain, of an unknown SQL type. The default of a query written without its carriers.
 */
type HeadingCarriers<Head> = {
	readonly [K in Head extends unknown ? keyof Head : never]: Carrier<
		Head extends unknown ? (K extends keyof Head ? Head[K] : never) : never
	>
}

/**
 * S is the schema of the rule that finished the arm (Rule<S>.find), so an arm's attachment child is over one of its
 * levels, as Query.attach requires. The heading is invariant (headingInvariant), so a union's arm is read at exactly
 * its own heading. A Finished written without a
 * schema has none, so it attaches nothing until it is read as the Finished of a rule over a schema. Whether it attaches
 * is its records' (AttachedNames): an attachment adds a key to Head that its carriers lack, which a union of arms of
 * one heading refuses (ArmsMeet).
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

/** An ordered query; Arms is its query's arms (Query), which take makes one arm (AsOneArm). */
export interface Ordered<
	S,
	Head,
	Ev extends Evidence = Evidence.Unknown,
	P = unknown,
	IHead = Head,
	Hc extends Carriers = HeadingCarriers<Head>,
	Cx = never,
	Arms extends UnionArms = readonly [ArmOf<Head, Hc>]
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
			readonly arms: Arms
		}> {
	/**
	 * The first k under the completed total order; a set again; take(1) is atMostOne (TakeEvidence). k is a positive
	 * literal, or the name of an integer parameter, take("batch"), which joins the query's parameters as pg.integer.
	 * A union of several headings is bounded by one take (OneTakeOverGroups).
	 */
	take<const K extends number | string>(
		k: K & OneTakeOverGroups<Arms, Head, Hc>
	): Query<
		S,
		Head,
		TakeEvidence<Ev, K>,
		K extends string ? Simplify<P & { readonly [N in K]: ParamType<number, "integer"> }> : P,
		IHead,
		Hc,
		Cx,
		readonly [UnionArm<AsOneArm<Arms, Head, Hc>["carriers"], AttachedNames<Head, Hc>, "take", true>]
	>
}

/**
 * v(source, name): fresh variables in the scope `name`, one per carrier of the source's heading, each carrying the
 * relation and field it came from and its scope where the source is a relation. The name is one literal of the
 * declared-name rule (ScopeName), so two scopes of one relation are two types; a rule holds one scope of each name,
 * which the builder refuses twice (no type tells two calls of one name apart).
 */
export type VConstructor = <R extends VSource, const N extends string, F extends Carriers, RN>(
	source: R & HeadedBy<F> & Headed<F> & SourceNamed<RN>,
	name: ScopeName<N>
) => Minted<F, ShownOrigins<R, N, RN, F>>

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
