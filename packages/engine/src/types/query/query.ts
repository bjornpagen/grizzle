import type { Stream } from "effect"
import type { Delivered, Delivery, FieldHost, RowDecoder } from "#compiler/core/decoder.ts"
import type { Direction } from "#compiler/core/order.ts"
import type { Built, Delivering, phantom, Phantom } from "#compiler/core/phantom.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type { Requires } from "#compiler/types/compute/scalar.ts"
import type {
	BindMapParams,
	BundleParams,
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
	OperandOrigin,
	PhantomOf,
	ParamsContribution,
	ParamType,
	Refusal,
	RequireBound,
	SchemaSource,
	Simplify,
	Source,
	SqlOfCarrier,
	UnionArmsOf,
	UnionHeading,
	UnionToIntersection,
	Unordered
} from "#compiler/types/core/phantom.ts"

import type {
	DeliveryClaim,
	Evidence,
	InferredEvidence,
	TakeEvidence,
	UnionEvidence
} from "#compiler/types/evidence/evidence.ts"
import type { FieldBase, LiteralOf } from "#compiler/types/fields/field.ts"
import type { AllDigits, NumeralAbove } from "#compiler/types/fields/source.ts"
import type { Rule } from "#compiler/types/query/rule.ts"
import type {
	Aggregate,
	NoStrayParameters,
	ParentVars,
	Producer,
	HeadedBy,
	HeadingIn,
	ShownVars,
	SourceNamed,
	ShownOrigins,
	VSource
} from "#compiler/types/query/terms.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"
import type {
	AnyFragment,
	AnySchema,
	EmptyLevel,
	HigherLevel,
	HighestLevel,
	LevelsOf
} from "#compiler/types/schema/schema.ts"
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
 *   attachments: a child stated as the one child is an Option there (ReadBack).
 * - Hc is the query's heading of carriers, a real member: the record of column carriers v mints variables over and an
 *   attachment mints its parent variables over. A find's is its head; a union's the arms' (UnionHeading); a recursive
 *   definition's its row.
 * - Cx is the union of the names of the contexts the query reads, at any depth of its rules, negations, imports,
 *   interiors and attachments: never for a query that reads none. It is carried contravariantly (`readsContexts`), so a
 *   query that reads contexts is still a query to every consumer that names no Cx; a role reads it off its query entries
 *   (types/schema/world.ts), and a derived definition must read none.
 * - At is the query's attachments by name, its phantom `attached`: each the delivery its author stated, its child's
 *   heading of carriers and the child's own attachments (Attachment), which the relations holding the query's records
 *   are typed by (types/schema/records.ts). Head keeps only each child's decoded records, never their carriers. A query
 *   that attaches nothing holds NoAttachments, one alias, so it pays nothing for the member.
 *
 * query(S).
 */
export type QueryConstructor = <S extends AnySchema | AnyFragment | AnyRole>(
	schema: S
) => QueryBuilder<S>

/**
 * The builder's members are each a function over the builder it is called on, `this`, declared once beside it, as
 * Rule's are (rule.ts Rule): the checker would otherwise walk the schema, every relation of it and each relation's
 * field record, once per call and per inference pass. Its phantom holds S invariant, as its methods held it before.
 */
export interface QueryBuilder<S> {
	readonly [phantom]?: { readonly schema: Invariant<S> } | undefined
	/** A query of one arm: its heading, read-back heading and decoders the arm's, attached or not. */
	readonly rule: BuilderRule
	readonly recursive: BuilderRecursive
	readonly reads: BuilderReads
}

/**
 * QueryBuilder.reads over the builder it is called on: a record R of named queries, each a query or ordered query over
 * S or a level below it (Child), as one query of exactly one row (ReadsQuery). Each query's records are one array
 * under its name, so a read that is a union of several headings is refused when it compiles, as an attached one is
 * (lower/conservative/deliver.ts).
 */
type BuilderReads = <S, const R extends Readonly<Record<string, Child<S>>>>(
	this: QueryBuilder<S>,
	reads: R
) => ReadsQuery<S, R>

/** What a record of reads holds: named queries, each with the phantom attach reads of its child (ChildReads). */
export type ReadsChildren = Readonly<Record<string, Phantom<ChildReads>>>

/**
 * A record of named queries R as one query over S, query(S).reads(R): its one row holds each query's records under its
 * name, an array in that query's own order (its orderBy or take, else its key), as attach delivers an array child under
 * the unit parent, the one row of no columns. Its evidence is that row's: the empty key, exactly one row. Its
 * parameters are each query's own under its name, `${name}.${parameter}` (ReadsParams); it reads every context any of
 * them reads. It is one statement, so its queries read one snapshot.
 */
export type ReadsQuery<S, R extends ReadsChildren> = Query<
	S,
	Simplify<{ readonly [K in keyof R]: ReadonlyArray<HeadOf<R[K]>> }>,
	ReadsEvidence,
	Simplify<ReadsParams<R>>,
	Simplify<{ readonly [K in keyof R]: ReadonlyArray<ImmediateHeadOf<R[K]>> }>,
	ReadsCarriers<R>,
	{ [K in keyof R]-?: ChildContexts<R[K]> }[keyof R],
	readonly [UnionArm<ReadsCarriers<R>, keyof R & string, "attach", false>],
	{ readonly [K in keyof R]: Attachment<"array", ChildCarriers<R[K]>, ChildAttached<R[K]>> }
>

/** The unit row's evidence: the empty key, one row. */
interface ReadsEvidence {
	readonly keys: readonly [ReadonlyArray<never>]
	readonly card: "one"
}

/** The unit row's carriers: none, since it has no columns; each name of the record is an attachment, never a column. */
export type ReadsCarriers<R> = { readonly [K in keyof R as never]: Carrier }

/** The parameters of a record of reads: each query's parameter `p` as `${name}.${p}`, under the query's name. */
type ReadsParams<R extends ReadsChildren> = UnionToIntersection<
	{ [K in keyof R & string]-?: Namespaced<K, ChildParams<R[K]>> }[keyof R & string]
>
type Namespaced<N extends string, P> = { readonly [Q in keyof P & string as `${N}.${Q}`]: P[Q] }

/** QueryBuilder.rule over the builder it is called on. */
type BuilderRule = <S, Head, Ev extends InferredEvidence, P, IHead, Hc extends Carriers, Cx, At>(
	this: QueryBuilder<S>,
	rule: (r: Rule<S>) => Finished<Head, Ev, P, S, IHead, Hc, Cx, At>
) => Query<S, Head, Ev, Simplify<P>, IHead, Hc, Cx, readonly [ArmOf<Head, Hc>], At>

/**
 * QueryBuilder.recursive over the builder it is called on. The definition's facts are records of its row, decoded by
 * the row's descriptors; every arm's head delivers the row (ArmDelivers), checked at the arm once its head is inferred;
 * and each arm list holds an arm (SomeArm).
 */
type BuilderRecursive = <
	S,
	const Row extends Record<string, FieldBase>,
	const Base extends ReadonlyArray<FinishedArm>,
	const Rec extends ReadonlyArray<FinishedArm>
>(
	this: QueryBuilder<S>,
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
) => Query<
	S,
	FactOfFields<Row>,
	Evidence.Set<Row>,
	Simplify<ArmParams<Base[number]> & ArmParams<Rec[number]>>,
	FactOfFields<Row>,
	Row,
	ContextsOf<Base[number]> | ContextsOf<Rec[number]>,
	readonly [UnionArm<Row, never, "recursive", false>]
>

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
/**
 * An attachment child: a query or ordered query over S or a level below it, with the members of its phantom attach
 * reads by key (ChildReads).
 */
type Child<S> = ChildAt<LevelsOf<S>>
type ChildAt<L> = L extends unknown ? QueryChild<L> | OrderedChild<L> : never
interface QueryChild<in out S> extends QueryBase, Phantom<ChildBundle<S>> {}
interface OrderedChild<in out S> extends OrderedBase, Phantom<ChildBundle<S>> {}
interface ChildBundle<S> extends ChildReads {
	readonly schema: Invariant<S>
}

/**
 * What attach reads of its child, its evidence, parameters, contexts and attachments, each a member of the child's
 * phantom, which every query and ordered query carries. Each is read by key (ChildEvidence, ChildParams, ChildContexts,
 * ChildAttached), never by a test of the child: the child holds its schema, and a conditional the checker resolves
 * instantiates its operands whole, every relation of the schema and each relation's field record with them.
 */
interface ChildReads {
	readonly evidence: Evidence
	readonly params: unknown
	readonly readsContexts: (read: never) => void
	readonly attached: unknown
}
type ChildPhantom<C extends Phantom<ChildReads>> = NonNullable<C[typeof phantom]>
/**
 * A child's evidence, each child of a union its own (EvidenceOfQuery): a child typed `any`, whose keys are every string,
 * states none, Evidence.Unknown.
 */
type ChildEvidence<C extends Phantom<ChildReads>> = C extends unknown
	? string extends keyof C
		? Evidence.Unknown
		: ChildPhantom<C>["evidence"]
	: never
/** The parameters a child needs, each child of a union its own (ParamsOf); a child typed `any` needs none. */
type ChildParams<C extends Phantom<ChildReads>> = C extends unknown
	? string extends keyof C
		? unknown
		: UnionToIntersection<ParamsContribution<ChildPhantom<C>["params"]>>
	: never
/** The contexts a child reads, each child of a union its own (ContextsOf); a child typed `any` reads none. */
type ChildContexts<C extends Phantom<ChildReads>> = C extends unknown
	? string extends keyof C
		? never
		: ContextsRead<ChildPhantom<C>["readsContexts"]>
	: never
/** The attachments a child's records carry, each child of a union its own; a child typed `any` carries none. */
type ChildAttached<C extends Phantom<ChildReads>> = C extends unknown
	? string extends keyof C
		? NoAttachments
		: ChildPhantom<C>["attached"]
	: never
/**
 * A child's heading of carriers, read by key, as HeadOf reads its records, each child of a union its own; a child typed
 * `any` states none, Carriers.
 */
type ChildCarriers<C> = C extends unknown
	? string extends keyof C
		? Carriers
		: C["heading" & keyof C]
	: never
/**
 * The contexts a phantom's `readsContexts` member reads, none where it reads `unknown`, as the member of a value typed
 * `any` does. An alias of its own: a type the checker resolves within a test of a child's keys would carry the child,
 * and instantiate it whole.
 */
type ContextsRead<F> = F extends (read: infer X) => void ? (unknown extends X ? never : X) : never

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
 * An attachment as the relations holding its query's records read it (types/schema/records.ts): the delivery D its
 * author stated, its child's heading of carriers Hc, and the child's own attachments At, by name. A query's attachments
 * are a record of these by name, its phantom `attached`.
 */
interface Attachment<out D, out Hc, out At> {
	readonly delivery: D
	readonly carriers: Hc
	readonly attached: At
}

declare const noAttachment: unique symbol

/**
 * The attachments of a query that attaches nothing: no name. Its one key is a symbol no attachment is named by, never
 * present, so the record is no empty object type, which any value but null and undefined would meet; readers of a
 * query's attachments read their string keys alone.
 */
export interface NoAttachments {
	readonly [noAttachment]?: never
}

/** The attachments At with the child C attached under Name, as the delivery K states. */
type AttachedWith<
	At,
	Name extends string,
	C extends Phantom<ChildReads>,
	K extends Delivery
> = At & {
	readonly [N in Name]: Attachment<K, ChildCarriers<C>, ChildAttached<C>>
}

/**
 * The records an attachment's parent decodes to, by the stated delivery D: the parent's heading with the child's
 * records under Name as an array, an Option or the one child.
 */
export type WithChild<Head, Name extends string, CH, D extends Delivery> = Simplify<
	Head & { readonly [N in Name]: Delivered<CH>[D] }
>

/**
 * How each stated delivery is read inside a write transaction: the one child is an Option there, since the evidence a
 * read-back may rely on proves at most one child where a snapshot read proves exactly one.
 */
export interface ReadBack {
	readonly array: "array"
	readonly option: "option"
	readonly one: "option"
}

/**
 * What each parameter of a query may be bound to: a scalar parameter to a term that meets its type (Meets), an outer
 * parameter of it among them, or a JavaScript value of its language; a relation parameter to a source of its rows, a
 * relation-valued term (RelationBindings).
 */
type BindingsFor<P> = {
	readonly [K in keyof P]: P[K] extends ReadonlyArray<infer Row> | Stream.Stream<infer Row>
		? Source<Row>
		: P[K] extends ParamType<infer D, infer Sql, infer L>
			? Meets<D, Sql> | LiteralOf<L>
			: never
}

/**
 * A relation parameter is bound to a relation-valued term of its heading, the sources a Description holds as a
 * binding (ir/desc.ts RelationTermDesc, query/build/query.ts boundRelation): a relation parameter of the importing
 * rule, `r.relation(name, heading)`, or a query or a bound query (RelationTerm). An interior stage or a recursive
 * definition's self is refused.
 */
type RelationBindings<B, P, S> = {
	readonly [K in keyof B]: K extends keyof P
		? P[K] extends ReadonlyArray<infer Row> | Stream.Stream<infer Row>
			? RelationTerm<B[K], Row, S>
			: unknown
		: unknown
}

/**
 * A relation-valued term for a relation parameter of rows Row of a query over S: the importing rule's relation
 * parameter, or a query or a bound query (a source written over a schema, no interior stage) that needs no parameter
 * (RequireBound), delivers exactly Row's fields, and is written over a level of S or a schema S is a level of: the
 * bound import is over the higher of the two (BoundOver), and levels of which neither is a level of the other do not
 * combine.
 */
type RelationTerm<X, Row, S> =
	IsRelationParameter<X> extends true
		? unknown
		: X extends Phantom<{ readonly interior: true }>
			? Refusal<"a relation parameter binds a relation-valued term: a relation parameter of the importing rule, r.relation(name, heading), or a query or a bound query">
			: X extends Phantom<{ readonly schema: unknown }>
				? RequireBound<X> & QueryRows<X, Row, S>
				: Refusal<"a relation parameter binds a relation-valued term: a relation parameter of the importing rule, r.relation(name, heading), or a query or a bound query">

/**
 * A query or a bound query X standing for the rows Row of a relation parameter bound in a program over S, an import's
 * (Query.bind) or a ChangeSet's (ChangeSet.bind): it delivers exactly Row's fields and is written over a level of S or
 * over a schema S is a level of, the program it is bound in then over the higher of the two (BoundOver); levels of which
 * neither is a level of the other do not combine.
 */
export type QueryRows<X, Row, S> = (SameKeys<HeadOfSource<X>, Row> extends true
	? unknown
	: Refusal<"a relation parameter binds a query that delivers exactly its heading's fields">) &
	([HigherLevel<S, WrittenOver<X>>] extends [never]
		? Refusal<"a relation parameter binds a query over a level of the schema it is bound in, or over a schema that schema is a level of">
		: unknown)

/**
 * The schema a source is written over, read off its phantom: a query's or a bound import's; never for any other, and
 * never for the empty level, below every level, which raises no program it is bound in (EmptyLevel).
 */
type WrittenOver<X> =
	X extends Phantom<{ readonly schema: Invariant<infer SX> }>
		? [SX] extends [EmptyLevel]
			? never
			: SX
		: never

/** The facts a source holds, read off its phantom. */
type HeadOfSource<X> = X extends Phantom<{ readonly heading: infer H }> ? H : never

/**
 * The schema a program whose relation parameters B binds is over, a bound import (Query.bind) or a bound ChangeSet
 * (ChangeSet.bind): the highest of its own, S, and those of the queries its relation parameters are bound to
 * (HighestLevel), so a rule matches a bound import only where it may match each of them.
 */
export type BoundOver<S, B, P> = HighestLevel<
	| S
	| {
			[K in keyof B]-?: K extends keyof P
				? P[K] extends ReadonlyArray<unknown> | Stream.Stream<unknown>
					? WrittenOver<B[K]>
					: never
				: never
	  }[keyof B]
>

/** A relation parameter: a source over no schema that contributes its one name to the rule that matches it. */
type IsRelationParameter<X> =
	X extends Phantom<{ readonly schema: unknown }>
		? false
		: X extends Phantom<{ readonly sourceParams: infer SP }>
			? IsOneLiteral<keyof SP>
			: false
/** The origins a binding object's terms read, on which the facts of the import it binds depend. */
type BindReads<B> = { [K in keyof B]-?: OperandOrigin<B[K]> }[keyof B]

/** The contexts a binding object's queries read, which the import that reads their rows reads (ContextsOf). */
export type BindContexts<B> = { [K in keyof B]-?: ContextsOf<B[K]> }[keyof B]

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
	extends QueryBase, Phantom<{ readonly schema: Invariant<S> | Invariant<EmptyLevel> }> {}

export interface OrderedBase extends Built, Decoders<unknown, unknown> {
	take(k: number): QueryBase
}
interface OrderedOver<in out S> extends OrderedBase, Phantom<{ readonly schema: Invariant<S> }> {}
/**
 * A finished arm, whatever its heading, evidence, parameters, immediate heading and carriers: the members every Finished
 * has. A recursive definition's arms are read through it, each head held to the row by ArmDelivers; attach is no member
 * of it, since its child reads the arm's own carriers.
 */
interface FinishedArm
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
 * carried invariantly, the contexts it reads, contravariantly, its arms' carriers (Query's Arms) and its attachments.
 */
interface QueryPhantom<S, Head, Ev, P, Cx, Arms, At> {
	readonly heading: Head
	readonly sourceParams: unknown
	readonly schema: Invariant<S>
	readonly evidence: Ev
	readonly params: P
	readonly paramsInvariant: Invariant<P>
	readonly readsContexts: (read: Cx) => void
	readonly arms: Arms
	readonly attached: At
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
	Arms extends UnionArms = readonly [ArmOf<Head, Hc>],
	At = NoAttachments
>
	extends SchemaSource<S, Head>, Headed<Hc>, Decoders<Head, IHead>, Delivering<Head> {
	readonly [phantom]?: QueryPhantom<S, Head, Ev, P, Cx, Arms, At> | undefined

	/**
	 * An additional arm. Its heading may differ from Head. The arms join as the checker unions them (ArmsMeet): arms of
	 * one heading meet at every field, none of them attached, and arms of different headings share a literal
	 * discriminant, a combination of fields telling every two apart; a stage over a union of several headings is no arm.
	 * The check is on the arm the callback returns, as attach's DeliveryClaim is: an intersection with the callback
	 * itself would be read before the arm is inferred, and leave it its constraint. Nothing is inferred from it
	 * (NoInfer): inferring the arm into the check made the checker resolve the arm's members, every one a type of its
	 * own, at each arm a union adds. The records are either arm's: arms
	 * of one heading key set decode as one record over their carriers, arms of different key sets by oneOf. The union's
	 * evidence is what the engine proves of a union of one heading (UnionEvidence): fields every arm fixes alike, and
	 * keys its literals tell apart. Its attachments are the query's own (At): an arm that attaches, or one beside a
	 * query that attaches, is of another heading than every other arm (ArmsMeet), and the records of a union of several
	 * headings are stored nowhere (program/records.ts), so no reader of a union's attachments meets an arm's.
	 */
	rule<Over, Head2, Ev2 extends InferredEvidence, P2, IHead2, Hc2 extends Carriers, Cx2>(
		this: OverSchema<Over>,
		rule: (
			r: Rule<Over>
		) => Finished<Head2, Ev2, P2, Over, IHead2, Hc2, Cx2> &
			NoInfer<ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>>
	): Query<
		Over,
		Head | Head2,
		UnionEvidence<Ev, Ev2, Head, Head2>,
		P & P2,
		IHead | IHead2,
		UnionHeading<UnionArmsOf<Hc> | UnionArmsOf<Hc2>>,
		Cx | Cx2,
		readonly [...Arms, ArmOf<Head2, Hc2>],
		At
	>
	/**
	 * A nested sub-result per parent fact, delivered as its author states: every child, an Option or the one child
	 * (WithChild). The parent set is unchanged. The child's evidence must prove the stated
	 * delivery (DeliveryClaim, checked on the child the callback returns: a claim on the delivery argument would be read
	 * before the callback is, when the child is not yet inferred), and the analysis proves it again where the program
	 * binds its decoder. Parent variables are inputs to the child, minted over the columns the parent delivers
	 * (DeliveredHeading), and keep the origins the parent's evidence records.
	 */
	attach<Over, const Name extends string, C extends Child<Over>, CH, CI, const K extends Delivery>(
		this: OverSchema<Over>,
		name: AttachmentName<Name, Head>,
		child: (
			parent: ParentVars<DeliveredHeading<Head, Hc>, Ev>
		) => C & Decoders<CH, CI> & DeliveryClaim<K, ChildEvidence<C>> & OneHeading<CH>,
		delivery: K
	): Query<
		Over,
		WithChild<Head, Name, CH, K>,
		Ev,
		Simplify<P & ChildParams<C>>,
		WithChild<IHead, Name, CI, ReadBack[K]>,
		Hc,
		Cx | ChildContexts<C>,
		readonly [
			UnionArm<
				AsOneArm<Arms, Head, Hc>["carriers"],
				AttachedNames<WithChild<Head, Name, CH, K>, Hc>,
				"attach",
				AsOneArm<Arms, Head, Hc>["bounded"]
			>
		],
		AttachedWith<At, Name, C, K>
	>
	named(name: string): Query<S, Head, Ev, P, IHead, Hc, Cx, Arms, At>
	/**
	 * The bound import is over the highest of the query's schema and the schemas of the queries its relation parameters
	 * are bound to (BoundOver), so matching it is checked against the importing rule's levels; it reads the contexts the
	 * query and those queries read, and keeps the query's evidence, whose keys a match of it reads, with what its
	 * bindings read.
	 */
	bind<Over, const B extends BindingsFor<P>>(
		this: OverSchema<Over>,
		bindings: B & NoStrayParameters<B, P> & RelationBindings<B, P, Over>
	): BoundSource<
		BoundOver<Over, B, P>,
		Head,
		BindMapParams<B>,
		Hc,
		Cx | BindContexts<B>,
		Ev,
		BindReads<B>
	>
	/**
	 * An order over the columns the query delivers (DeliveredKeys): never a field only some arms have, or an attachment,
	 * and never a closed id of a closed.unordered roster, which has no order (OrderedKeys).
	 */
	orderBy<
		Over,
		const O extends ReadonlyArray<readonly [DeliveredKeys<Head, Hc> & string, Direction]>
	>(
		this: OverSchema<Over>,
		...order: O & OrderedKeys<O, Hc>
	): Ordered<Over, Head, Ev, P, IHead, Hc, Cx, Arms, At>
	/**
	 * A search over one rule's projection, its source as the checker reads it (SearchSource), ranked by a distance of its
	 * carriers. The search keeps a subset of its source's facts, at most `take` of them, so its evidence is a take's of
	 * the source's (TakeEvidence), as the engine proves of the sealed node.
	 */
	approximateNearest<Over, const K extends number>(
		this: OverSchema<Over>,
		spec: SearchSource<AsOneArm<Arms, Head, Hc>, K> & {
			readonly take: PositiveBound<
				K,
				"9007199254740991",
				"a search's take, the requested result bound, is a positive integer of at most 9007199254740991, the largest safe integer"
			>
		}
	): Query<
		Over,
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
		],
		At
	>
}

/**
 * What a member of Query, Ordered or Finished reads of the value it is called on, `this`: its schema, Over, read off its
 * phantom by key (`schema`), never the interface's own S. A method of a generic interface is instantiated in two
 * steps, the interface's type arguments, then the call's own, and the second walks every type the first put in: a
 * member whose signature names S walked the schema, every relation of it and each relation's field record, once per
 * call and per inference pass, so every union arm, bind, order and take over a schema of n relations cost n (the
 * combinators' cost gate, test/types/query/budget/combinators.ts). A member that names Over holds only its own type
 * parameter, which the call infers from the phantom it is called on at one property read, and the phantom alone is
 * compared, never a member of the value, so the call costs what it did over a schema of any size. A member with no type
 * parameter of its own, Query.named, is instantiated once, by the interface's arguments, and keeps S: made generic, it
 * is compared as a generic signature with QueryBase's wherever a query is read as any query over a level (a workload's
 * entries, an attachment's child), at every level of the schema (the query-scale gate, budget/scaling.ts).
 */
interface OverSchema<in out S> {
	readonly [phantom]?: { readonly schema: Invariant<S> } | undefined
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
 * a nested delivery (WithChild), under whatever stage keeps the records, as the checker reads them off the arm's
 * rows (check/checker.ts #carried); never for an arm that attaches nothing.
 */
type AttachedNames<Head, Hc> = Exclude<KeyOfAnyArm<Head>, keyof Hc>

/**
 * The columns a query of records Head over the carriers Hc delivers, as the checker heads it (check/checker.ts
 * Checker.union): of one arm its own, of a union the columns every arm has; never an attachment. Every combinator over
 * the query reads these: an order's keys, an attachment's parent variables, a take's or a search's arm.
 */
export type DeliveredKeys<Head, Hc> = keyof Head & keyof Hc

/**
 * What an order O over the carriers Hc requires of each of its keys: a column with an order, so a key naming a closed id
 * of a closed.unordered roster, whose domain carries Unordered, is refused by the engine's refusal of an ordered
 * operation over one (types/compute/scalar.ts OrderedOperand).
 */
type OrderedKeys<O extends ReadonlyArray<unknown>, Hc> = {
	readonly [I in keyof O]: O[I] extends readonly [infer K, Direction]
		? K extends keyof Hc
			? [DomainOf<Hc[K]>] extends [never]
				? unknown
				: [DomainOf<Hc[K]>] extends [Unordered]
					? readonly [
							Refusal<"a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles">,
							Direction
						]
					: unknown
			: unknown
		: unknown
}

/** The carriers of the columns a query delivers (DeliveredKeys). */
export type DeliveredHeading<Head, Hc> = { readonly [K in DeliveredKeys<Head, Hc>]: Hc[K] }

/** Whether a query's records are of several key sets: a union of several headings, delivered per heading group. */
type Heterogeneous<Head> = [KeyOfAnyArm<Head>] extends [keyof Head] ? false : true

/** The arm a rule of records Head over the carriers Hc is to a further rule. */
export type ArmOf<Head, Hc extends Carriers> = UnionArm<Hc, AttachedNames<Head, Hc>, "rule", false>

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
	readonly producer: "approximateNearest over one rule's projection; this source is a rule whose head produces ranges, facts per binding rather than its projection"
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
type RefusedSearch<M extends Refused, K extends number> = Refusal<M> & {
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

/**
 * Whether a number literal's numeral is a positive integer of at most Max: digits alone, none leading with zero (a
 * literal's numeral leads with zero only as zero itself), and no greater than Max, so neither zero, a negative, a
 * fraction nor an exponent's numeral (1e+21) is one.
 */
type PositiveAtMost<S extends string, Max extends string> = S extends `0${string}`
	? false
	: AllDigits<S> extends true
		? NumeralAbove<S, Max> extends true
			? false
			: true
		: false

/**
 * A bound K the run time reads as a positive integer of at most Max, each member of a union of literals: refused under
 * M where a member is no such literal; a widened number, whose value only the run time reads, admitted.
 */
type PositiveBound<K extends number, Max extends string, M extends Refused> = number extends K
	? unknown
	: false extends (K extends unknown ? PositiveAtMost<`${K}`, Max> : never)
		? Refusal<M>
		: unknown

/**
 * Ordered.take's k, each member of a union at once: a positive integer literal of int4's range, at most 2147483647,
 * the most rows the checker bounds a take by (check/checker.ts int4TakeBound), or a parameter's name, which is any
 * nonempty string (query/build/query.ts takeOf); a widened number or string, whose value only the run time reads,
 * admitted. A search's take is at most 9007199254740991, the largest safe integer (query/build/query.ts
 * positiveInteger).
 */
type TakeBound<K extends number | string> = false extends (
	K extends string ? (K extends "" ? false : true) : true
)
	? Refusal<"take's k is a positive integer of at most 2147483647, int4's, or a parameter's nonempty name">
	: PositiveBound<
			Extract<K, number>,
			"2147483647",
			"take's k is a positive integer of at most 2147483647, int4's, or a parameter's nonempty name"
		>

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
 * An interior stage of a rule over S (Rule.interior): a source matched in that rule alone, as a bound import is, its
 * phantom marked `interior`, so no import's relation parameter is bound to it (RelationTerm), its rows being its rule's.
 */
export interface InteriorSource<S, Head, SP, Hc, Cx, Ev> extends Built, Headed<Hc> {
	readonly [phantom]?:
		| {
				readonly heading: Head
				readonly sourceParams: SP
				readonly schema: Invariant<S>
				readonly readsContexts: (read: Cx) => void
				readonly evidence: Ev
				readonly reads: never
				readonly interior: true
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
 *
 * Every two arms before New met when the later of them joined, so New is judged beside each of them, once: a union of
 * n arms judges n pairs as its last arm joins, never every pair again. Only the discriminant reads every arm, since a
 * further arm can only narrow it: where New leaves it fewer fields than the arms before it had, every two arms are
 * judged apart again at the fields left (UnionRefusal).
 */
type ArmsMeet<Arms extends UnionArms, Head, New extends AnyArm> =
	GroupedArm<Arms, Head> extends true
		? Refusal<"an arm over a union of several headings: only a query's result delivers each heading group">
		: true extends AttachedBeside<Arms[number], New>
			? Refusal<"an attachment on an arm of a union whose heading several arms share">
			: UnionRefusal<Arms[number]["carriers"], New["carriers"]>
/** Whether a query of arms Arms and records Head is one stage over a union of several headings. */
type GroupedArm<Arms extends UnionArms, Head> = Arms extends readonly [AnyArm]
	? Heterogeneous<Head>
	: false
/**
 * Whether an earlier arm of Old has New's heading key set, one of the two carrying an attachment: none where no arm
 * carries one, read off the arms' union at once (`attached`, never for an arm that attaches nothing), and otherwise
 * each arm beside New (SharesAttachedHeading).
 */
type AttachedBeside<Old extends AnyArm, New extends AnyArm> = [
	Old["attached"] | New["attached"]
] extends [never]
	? false
	: SharesAttachedHeading<Old, New>
/** Whether an earlier arm A has New's heading key set, one of the two carrying an attachment. */
type SharesAttachedHeading<A, New extends AnyArm> = A extends AnyArm
	? SameKeys<A["carriers"], New["carriers"]> extends true
		? [A["attached"] | New["attached"]] extends [never]
			? false
			: true
		: false
	: never
/**
 * Whether the carriers New of a further arm join the carriers Old of the arms before it (ArmsMeet): New meets each of
 * them at every field they share, and at the union's discriminant New is apart from each arm of another heading, and so
 * is every two arms of Old where New narrowed the discriminant Old had.
 */
type UnionRefusal<Old, New> =
	true extends Mismatched<New, Old>
		? Refusal<"a union's arms deliver each field at one type">
		: OneKeySet<Old, New> extends true
			? unknown
			: true extends IndistinctBeside<Old, New, DiscriminantOf<Old | New, keyof (Old | New)>>
				? Refusal<"arms of different headings share a field that holds a different constant in each">
				: unknown
/**
 * Whether every arm of Old has New's key set: no two arms of different headings, so none to tell apart, and no
 * discriminant to read. Every key any arm of Old has is one of New's, and every key of New one every arm of Old has.
 */
type OneKeySet<Old, New> = [KeyOfAnyArm<Old>] extends [keyof New]
	? [keyof New] extends [keyof Old]
		? true
		: false
	: false
/**
 * Whether two arms of Old and New hold the same constants at every field of the discriminant D: New and an arm of Old,
 * and two arms of Old only where D is narrower than the discriminant of Old alone, at which they were judged apart.
 */
type IndistinctBeside<Old, New, D> =
	| Indistinct<New, Old, D>
	| ([DiscriminantOf<Old, keyof Old>] extends [D] ? false : Indistinct<Old, Old, D>)
/**
 * Whether an arm X delivers a field it shares with an arm of All at types that do not meet: at a field every arm of All
 * has, X's carrier beside each carrier the arms deliver there, the field read off All at once (All[K], one union of the
 * arms' carriers, each carrier once however many arms deliver it, a carrier that is itself a union read as each of its
 * members, as the engine reads an arm whose field is one of two terms under each value of its flag); at a field only
 * some of them have, beside each arm that has it (MismatchedApart).
 */
type Mismatched<X, All> = X extends unknown
	? | (false extends { [K in keyof X & keyof All]-?: MeetsEvery<X[K], All[K]> }[keyof X & keyof All]
				? true
				: false)
		| MismatchedApart<X, All, Exclude<keyof X, keyof All>>
	: never
/** Whether the carrier X meets every carrier of Ys, each its own (KeyMeets). */
type MeetsEvery<X, Ys> = false extends (Ys extends unknown ? KeyMeets<X, Ys> : never) ? false : true
/** Whether X delivers one of the fields Ks, which some arms of All lack, at a type an arm of All that has it does not meet. */
type MismatchedApart<X, All, Ks> = [Ks] extends [never]
	? false
	: All extends unknown
		? false extends { [K in Ks & keyof All]-?: KeyMeets<X[K & keyof X], All[K]> }[Ks & keyof All]
			? true
			: false
		: never
/**
 * The discriminant's fields among the fields Ks every arm has: those where every arm holds a constant, each field read
 * off All at once (All[K], the arms' carriers there, each once, a carrier that is a union as each of its members).
 */
type DiscriminantOf<All, Ks> = {
	[K in Ks & keyof All]-?: true extends NoConstantIn<All[K]> ? never : K
}[Ks & keyof All]
/** Whether some carrier of Cs holds no constant. */
type NoConstantIn<Cs> = Cs extends unknown
	? [ConstantValuesOf<Cs>] extends [never]
		? true
		: false
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
 * base's value (LiteralOf), so a Type.literal of a contract, whose type is the whole branded base, is no one value.
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
 * meet types alike; never where the types carry no one value: a Numeric, a Money, a typed Type.literal's, a value
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
 * S is the schema of the rule that finished the arm (Rule<S>.find), carried invariantly in its phantom (`schema`), so an
 * arm's attachment child is over one of its levels, as Query.attach requires, read off the phantom as every member of
 * Query reads its schema (OverSchema). The heading is invariant (headingInvariant), so a union's arm is read at exactly
 * its own heading. A Finished written without a
 * schema has none, so it attaches nothing until it is read as the Finished of a rule over a schema. Whether it attaches
 * is its records' (AttachedNames): an attachment adds a key to Head that its carriers lack, which a union of arms of
 * one heading refuses (ArmsMeet).
 *
 * Hc, the arm's carriers, is declared invariant, `in out`, the variance the checker measures of it, so that variance
 * is reliable. attach mints the arm's parent variables over Hc, a mapped type of it (ParentVars), which leaves the
 * measured variance unreliable, and where two Finished types meet whose carriers that variance does not relate, an
 * unreliable variance has the checker compare them member by member, attach's signature instantiated at each: every
 * further arm of a union paid for it, 189 instantiations an arm of the plain union of two rules
 * (test/types/query/budget/plain.ts), and the type tier reads every program alike without it.
 */
export interface Finished<
	Head,
	Ev extends Evidence,
	P = unknown,
	S = never,
	IHead = Head,
	in out Hc extends Carriers = HeadingCarriers<Head>,
	Cx = never,
	At = NoAttachments
>
	extends
		Phantom<{
			readonly headingInvariant: Invariant<Head>
			readonly schema: Invariant<S>
			readonly evidence: Ev
			readonly params: P
			readonly readsContexts: (read: Cx) => void
			readonly attached: At
		}>,
		Headed<Hc>,
		Decoders<Head, IHead> {
	/** An arm may attach before it joins a union; the arm keeps its own attached heading. */
	attach<Over, const Name extends string, C extends Child<Over>, CH, CI, const K extends Delivery>(
		this: OverSchema<Over>,
		name: AttachmentName<Name, Head>,
		child: (
			parent: ParentVars<Hc, Ev>
		) => C & Decoders<CH, CI> & DeliveryClaim<K, ChildEvidence<C>> & OneHeading<CH>,
		delivery: K
	): Finished<
		WithChild<Head, Name, CH, K>,
		Ev,
		Simplify<P & ChildParams<C>>,
		Over,
		WithChild<IHead, Name, CI, ReadBack[K]>,
		Hc,
		Cx | ChildContexts<C>,
		AttachedWith<At, Name, C, K>
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
	Arms extends UnionArms = readonly [ArmOf<Head, Hc>],
	At = NoAttachments
>
	extends
		Headed<Hc>,
		Decoders<Head, IHead>,
		Delivering<Head>,
		Phantom<{
			readonly evidence: Ev
			readonly params: P
			readonly paramsInvariant: Invariant<P>
			readonly schema: Invariant<S>
			readonly readsContexts: (read: Cx) => void
			readonly arms: Arms
			readonly attached: At
		}> {
	/**
	 * The first k under the completed total order; a set again; take(1) is atMostOne (TakeEvidence). k is a positive
	 * literal of int4's range, or the name of an integer parameter, take("batch"), which joins the query's parameters
	 * as int4 (TakeBound). A union of several headings is bounded by one take (OneTakeOverGroups).
	 */
	take<Over, const K extends number | string>(
		this: OverSchema<Over>,
		k: K & TakeBound<K> & OneTakeOverGroups<Arms, Head, Hc>
	): Query<
		Over,
		Head,
		TakeEvidence<Ev, K>,
		K extends string ? Simplify<P & { readonly [N in K]: ParamType<number, "int4"> }> : P,
		IHead,
		Hc,
		Cx,
		readonly [
			UnionArm<AsOneArm<Arms, Head, Hc>["carriers"], AttachedNames<Head, Hc>, "take", true>
		],
		At
	>
}

/**
 * v(source, name): fresh variables in the scope `name`, one per carrier of the source's heading, each carrying the
 * relation and field it came from and its scope where the source is a relation. The name is one literal of the
 * declared-name rule (ScopeName), so two scopes of one relation are two types; a rule holds one scope of each name,
 * which the builder refuses twice (no type tells two calls of one name apart).
 */
export type VConstructor = <R extends VSource, const N extends string, F extends Carriers, RN>(
	source: R & HeadedBy<F> & SourceNamed<RN>,
	name: ScopeName<N>
) => ShownVars<HeadingIn<R>, F, RN, ShownOrigins<R, N, RN, F>>

/**
 * The records a query, ordered query or finished arm delivers: its rows decoder's, read by key. A match of the query
 * against `{ rows: RowDecoder<infer H> }` instantiates it whole, the schema it is over with it, so a derived relation's
 * check of its definition's head cost every relation of the level below it (types/derived/derived.ts DefinitionShape).
 */
export type HeadOf<Q> = DecodedBy<Q["rows" & keyof Q]>
type DecodedBy<D> = D extends RowDecoder<infer H> ? H : never
/**
 * The attachments a query's or ordered query's records carry, by name (Attachment), read off its phantom by key, as
 * HeadOf reads its records: a match of the query would instantiate it whole, the schema it is over with it. A value
 * with no phantom, a query known only at run time, carries none the types know.
 */
export type AttachedOf<Q> = AttachedIn<PhantomOf<Q>>
type AttachedIn<B> = [B] extends [never] ? NoAttachments : B["attached" & keyof B]
/** Readers of a query's phantoms. */
export type EvidenceOfQuery<Q> =
	Q extends Phantom<infer B>
		? B extends { readonly evidence: infer E extends Evidence }
			? E
			: Evidence.Unknown
		: Evidence.Unknown

/**
 * The contexts a program reads, at any depth of its rules, imports and attachments: a phantom its rules collect from
 * the contexts they match, carried contravariantly (`readsContexts`) so that a query reading contexts is still a query to
 * every consumer that names none. Each program of a union, and each shape of a phantom that is a union of shapes, reads
 * its own; a value with no phantom, and one typed `any` (ContextsRead), read none. The phantom is read by key, never by
 * a test of the program (ChildContexts): a query holds its schema, and a conditional the checker resolves instantiates
 * its operands whole, every relation of the schema with them, once for each program it tests. A value without the key
 * is never indexed by it: the key's intersection with its keys is never, and an indexable value indexed by never is its
 * element, an array member's fact.
 */
export type ContextsOf<Q> = Q extends unknown
	? typeof phantom extends keyof Q
		? PhantomContexts<NonNullable<Q[typeof phantom & keyof Q]>>
		: never
	: never
/** The contexts a phantom reads, each of its shapes its own: none for a shape that reads none. */
type PhantomContexts<B> = B extends unknown ? ContextsRead<B["readsContexts" & keyof B]> : never
/** The records a query delivers to a read inside a write transaction, a read-back: its immediate decoder's. */
export type ImmediateHeadOf<Q> = Q extends { readonly immediate: RowDecoder<infer I> } ? I : never
/**
 * The parameters a program needs, each program of a union its own: a query's, ordered query's or ChangeSet's map, or a
 * bound import's, the parameters its bind map needs, read off its phantom by key (core/phantom.ts BundleParams) and
 * folded as ParamsOfTerm folds a value's; an array or Stream member, which has no phantom, and a value typed `any`,
 * whose keys are every string, none, `unknown`. A program is told by its keys,
 * never by a test of it: a query holds its schema, and a conditional the checker resolves instantiates its operands
 * whole, every relation of the schema with them, once for each program it tests. A value without the phantom's key is
 * never indexed by it, as ContextsOf says: an array member's facts would be read as its phantom, and a fact's field
 * named `params` as its parameters. A term, which holds no schema, is read by ParamsOfTerm.
 *
 * A program carries its map as the intersection of its parts' maps, one for each rule or member, which the checker
 * keeps flat (types/changeset/changeset.ts JointParams); the map is one record here, where it is read, once.
 */
export type ParamsOf<X> = X extends unknown
	? string extends keyof X
		? unknown
		: typeof phantom extends keyof X
			? OneMap<
					UnionToIntersection<
						ParamsContribution<BundleParams<NonNullable<X[typeof phantom & keyof X]>>>
					>
				>
			: unknown
	: never
/** A map of parameters, an intersection of maps, as one record: none, unknown, where it needs none. */
type OneMap<P> = unknown extends P ? P : Simplify<P>
