import type { AllenMask, HoldsExactly } from "#compiler/allen/mask.ts"
import type { Built, phantom, Phantom } from "#compiler/core/phantom.ts"
import type { unkeyedAggregateRefusals } from "#compiler/core/refusals.ts"
import type {
	AvgSql,
	EndpointSql,
	NumericSql,
	PlainHost,
	SumSql
} from "#compiler/scalar/compute/tables.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type {
	Admitted,
	FirstTerm,
	FirstValue,
	HasOrder,
	IsSpan,
	OfFamily,
	Operand,
	OrderedOperand,
	RefinedEquality,
	RefinedTerm,
	Requires
} from "#compiler/types/compute/scalar.ts"

import type {
	CallArgs,
	CallNumberings,
	CallReads,
	CallSource
} from "#compiler/types/compute/call.ts"
import type {
	BindMapParams,
	Carriers,
	ComputedOrigin,
	Facts as ProvedFacts,
	InputTerm,
	Invariant,
	LanguageOf,
	Meets,
	NegatesIn,
	NegationFreeEach,
	Negating,
	OperandOrigin,
	ParamOrigin,
	ParamType,
	ParamsOfEach,
	ParamsOfTerm,
	ParamsOfValues,
	Predicate,
	Refusal,
	RequireBound,
	Simplify,
	Source,
	SqlOfTerm,
	Term,
	TermBase,
	TypeOfTerm,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type {
	Comparison,
	ComparisonOp,
	Conjunction,
	ContainmentProof,
	Disjunction,
	EqualityStates,
	FoundOf,
	MembershipStates,
	EvidenceOf,
	InferredEvidence,
	StatesOf,
	Stating,
	HeadKeys,
	HeadValues,
	Negation,
	Opaque,
	PinnedOrSplit,
	ProducedCard,
	ProofsOf,
	Reading,
	ReflexiveProof,
	BindingsProved,
	FoldsIn,
	Shaped,
	ShownOf,
	SoleMatch,
	Split
} from "#compiler/types/evidence/evidence.ts"
import type {
	ExactIntegerField,
	Field,
	FieldBase,
	InstantDomain,
	StoredInstantField,
	LiteralOf,
	NaturalDomain,
	NaturalField,
	NotInstant,
	NotSearchDocument,
	NotStoredOnly,
	StoredOnlySql,
	TextField
} from "#compiler/types/fields/field.ts"
import type { ContextsOf, Finished, InteriorSource } from "#compiler/types/query/query.ts"
import type {
	Aggregate,
	Bindings,
	NegatedBindings,
	NegatedCarriers,
	DeadConstants,
	HeadOrigins,
	HeadTerm,
	HeadTerms,
	NoExcess,
	ParamSource,
	Producer,
	OrdinaryKind,
	ShownCarriers,
	HeadingIn,
	EachInstanceOf,
	ShownHeading,
	ShownHeadingOf,
	SourceShows
} from "#compiler/types/query/terms.ts"
import type {
	AnyClosed,
	AnyRelation,
	FactOfFields,
	NameOf,
	Relation
} from "#compiler/types/schema/relation.ts"
import type {
	EmptyLevel,
	IsLevelOfInvariant,
	IsRelationOf,
	RelationOf,
	RelationsOf,
	UnderName
} from "#compiler/types/schema/schema.ts"
import type { AnyContext, AnyWorld } from "#compiler/types/schema/world.ts"

type T<A> = TypeOfTerm<A>
type P<A> = ParamsOfTerm<A>
/**
 * What find returns over a head of terms H, a head whose JavaScript values are its literal terms (HeadTerms), from the
 * rule's facts read by their parts (RuleFacts): its matches O, what its filters state St, its filters Fl and its splits
 * Sp. An arm that attaches nothing yet, its records each field's host value as the rule's filters keep it (FoundOf).
 */
type FinishedHead<
	S,
	Params,
	Sole,
	O extends ReadonlyArray<unknown>,
	St,
	Fl,
	Sp,
	Cx,
	H extends Carriers
> = Finished<
	FoundOf<H, St>,
	EvidenceOf<
		H,
		HeadKeys<S, O, H, St>,
		HeadValues<H, St>,
		HeadOrigins<H, O>,
		ProofsOf<ContainmentProof<S, Sole, H>, ReflexiveProof<O, Fl, H>>,
		BindingsProved<PinnedOrSplit<S, HeadKeys<S, O, H, St>, H, O, St, Sp>, ProducedCard<S, H, O, St>>
	>,
	Simplify<Params & ParamsOfValues<H>>,
	S,
	FoundOf<H, St>,
	H,
	Cx
>
/** A predicate's origin: a computation over its operands, terms or predicates. */
type Reads<Os extends ReadonlyArray<unknown>> = ComputedOrigin<OperandOrigin<Os[number]>>

/**
 * An aggregate in a head folds the facts its rule matches, each read once by a key (the engine's FoldInput): every
 * match binds, by a variable, a parent variable or a constant, every field of one key of its source. A delta of an
 * ordinary relation is keyed by the relation's keys, a context's one fact by the empty key, and a relation parameter,
 * an imported query, an interior stage and a delta of a world relation by their whole heading, each a set keyed by its
 * heading. A match that binds no key whole would fold a projection of its facts, and is refused; distinct values are
 * folded by matching a query of them as the source. The refusal names the aggregate as its author wrote it.
 */
type FoldKeyed<S, Os, X> =
	X extends Aggregate<unknown, never>
		? EveryMatchKeyed<S, Os> extends true
			? unknown
			: Refusal<(typeof unkeyedAggregateRefusals)[X["aggregate"]]>
		: unknown

/**
 * A span producer stands alone in its head, as the checker folds a head (check/checker.ts foldedOf): a producer yields
 * facts per binding, which no aggregate beside it folds, and a head has at most one producer. Each producer of a head
 * that breaks either is refused at its key, an aggregate's company first.
 */
type ProducerAlone<H, X> =
	X extends Producer<unknown, never>
		? [KeysOfKind<H, Aggregate<unknown, never>>] extends [never]
			? IsUnion<KeysOfKind<H, Producer<unknown, never>>> extends true
				? Refusal<"one range producer per head">
				: unknown
			: Refusal<"aggregate and range producer in one head: a producer yields facts per binding, an aggregate folds them">
		: unknown

/** The keys of a head whose terms are of kind X: never a term refused already, which is never and of every kind. */
type KeysOfKind<H, X> = {
	readonly [K in keyof H]-?: [H[K]] extends [never] ? never : H[K] extends X ? K : never
}[keyof H]

/** Whether U is a union of more than one member. */
type IsUnion<U, All = U> = U extends unknown ? ([All] extends [U] ? false : true) : never

type EveryMatchKeyed<S, Os> = Os extends readonly [infer M, ...infer Rest]
	? MatchKeyed<S, M> extends true
		? EveryMatchKeyed<S, Rest>
		: false
	: true

/** Whether a match binds a key its fold reads its source by in S (FoldsIn), each member of its source its own. */
type MatchKeyed<S, M> =
	M extends SoleMatch<infer Sh, infer B>
		? Sh extends unknown
			? BindsAKey<FoldsIn<S, Sh>, keyof B>
			: never
		: false

/**
 * The source a match of a source of kind K records for its rule's evidence, as the evidence reads it (ShownOf): an
 * ordinary relation as it shows itself, its name N, heading C and primary key PK, which are a concrete relation's own,
 * so a generic relation's evidence is read off the relations it may be, its name the union of theirs; any other source
 * as its own members show.
 */
type ShownSource<R, K, N, C, PK> = [K] extends ["relation"]
	? ShownOf<Relation<Extract<N, string>, C, Extract<PK, ReadonlyArray<keyof C & string>>>>
	: ShownOf<R>

/** Whether one of the keys, each a tuple of fields, has every field among the bound ones. */
type BindsAKey<Keys, Bound> = 0 extends 1 & Keys
	? false
	: true extends (
				Keys extends ReadonlyArray<infer F> ? ([F] extends [Bound] ? true : false) : false
		  )
		? true
		: false

/**
 * What a rule may match: a relation, closed, derived or world relation, a context, or any source (a relation
 * parameter, an interior stage, an imported or bound query).
 */
type Matchable = AnyRelation | AnyClosed | AnyDerived | AnyWorld | AnyContext | Source<unknown>

/**
 * A relation must belong to the rule's schema, and a query, bound import or interior stage must be written over one
 * of the rule's levels, so a derived definition cannot read its own level directly or through an imported query.
 * A parameterized query is imported through Q.bind, never matched directly.
 * Relation parameters, deltas and contexts carry no schema: a context is matched by a rule over any schema.
 */
type MatchCheck<S, R> = R extends AnyContext
	? unknown
	: R extends AnyRelation | AnyClosed | AnyDerived | AnyWorld
		? IsRelationOf<S, R> extends true
			? unknown
			: Refusal<"the relation is not in this query's schema">
		: R extends Source<unknown>
			? RequireBound<R> & RequireLevel<S, R>
			: Refusal<"the relation is not in this query's schema">

/**
 * A source written over a schema, a query, a bound import or an interior stage, is over a level of S or over the empty
 * level, a level of every level (EmptyLevel), as schema/levels.ts isLevelOf holds it at run time: so a rule over a role
 * matches a read over schema.empty bound by the rule's own parameters, as den's census of a root derived from its key
 * does. Its schema is read off its phantom by key, never bound by `infer`, whose branch would instantiate the schema
 * whole at every match; the empty level is tested only where no level of S is the source's, so a match of a source over
 * a level of S pays nothing for it.
 */
type RequireLevel<S, R> = typeof phantom extends keyof R
	? LevelOfPhantom<S, NonNullable<R[typeof phantom & keyof R]>>
	: unknown
type LevelOfPhantom<S, B> = "schema" extends keyof B
	? IsLevelOfInvariant<S, B["schema" & keyof B]> extends true
		? unknown
		: [B["schema" & keyof B]] extends [Invariant<EmptyLevel>]
			? unknown
			: Refusal<"the query is not over a level of this query's schema">
	: unknown

/**
 * What a rule checks of a source of kind K it matches or negates: an ordinary relation is one of the schema's, held by
 * assignability, which a generic relation's constraint decides; any other source as MatchCheck checks it. A schema
 * holds each relation under its own name (UnderOwnNames), so a relation that shows the literal names N, one or a
 * generic relation's union of them, is held against the schema's relations of those names, one property read each,
 * never against the union of every relation of the schema, which the source's intersection would distribute over, a
 * type per relation of the schema for each match. A relation whose name the type does not know names none of them,
 * and is held against every relation of the schema.
 */
type ShownMatch<S, R, K, N> = [K] extends ["relation" | "closedRelation"]
	? | (string extends N ? RelationOf<S> : UnderName<RelationsOf<S>, N>)
		| Refusal<"the relation is not in this query's schema">
	: MatchCheck<S, R>

/** The parameters a source of kind K contributes: an ordinary relation none, any other source its own. */
type ShownSourceParams<R, K> = [K] extends ["relation" | "closedRelation"]
	? unknown
	: SourceParamsOf<R>

/** The contexts a source of kind K reads: an ordinary relation none, any other source its own. */
type ShownSourceContexts<R, K> = [K] extends ["relation" | "closedRelation"]
	? never
	: SourceContexts<R>

/** The parameters a source contributes to the rule that matches it. */
type SourceParamsOf<R> = R extends Phantom<{ readonly sourceParams: infer SP }> ? SP : unknown
/**
 * The contexts a source reads: a context its own name, a query, bound import or interior stage the contexts it reads.
 */
type SourceContexts<R> = R extends AnyContext ? NameOf<R> : ContextsOf<R>
/** The contexts a list of predicates reads: the negated contexts in any of them. */
type PredicateContexts<Ps> = Ps extends ReadonlyArray<infer X> ? ContextsOf<X> : never
/**
 * A predicate's contexts, the contexts a relational negation in it reads, a phantom carried contravariantly as a
 * query's are (query.ts ContextsOf).
 */
interface ReadsContexts<in Cx> extends Built {
	readonly [phantom]?: { readonly readsContexts: (read: Cx) => void } | undefined
}

type Compare<A, B> = Predicate<P<A> & P<B>, Reads<readonly [A, B]>>
/** A comparison records its operator and operands for the reflexive proof (../evidence/evidence.ts ReflexiveProof). */
type Compared<Op extends ComparisonOp, A, B> = Compare<A, B> & Shaped<Comparison<Op, A, B>>

/** What r.allen states under the mask M: an equality of its spans where M holds for exactly equals, else nothing. */
type EqualsStating<M, A, B> =
	HoldsExactly<M, "equals"> extends true ? Stating<EqualityStates<A, B>> : unknown

/**
 * What a rule records beyond its parameters and its pinned, sole and only states, for the evidence its find reads
 * (../evidence/evidence.ts): every occurrence it matched, in order, which the head's keys and origins are read from
 * (HeadKeys, HeadOrigins); what its filters state (evidence/evidence.ts Stating): a variable compared with r.eq against
 * a value fixed per binding is fixed, two variables compared are equal; its filters in order, or UnknownFilters
 * once a where spreads an array of unknown length; and each filter that is one of several predicates, either of which
 * may run, by what each states (Split), which the card reads one at a time (evidence/evidence.ts SplitPinned).
 */
interface RuleFacts<Occurrences extends ReadonlyArray<unknown>, Stated, Filters, Splits> {
	readonly occurrences: Occurrences
	readonly stated: Stated
	readonly filters: Filters
	readonly splits: Splits
}

interface UnknownFilters {
	readonly unknownFilters: true
}
export type NoFacts = RuleFacts<readonly [], never, readonly [], never>
type AfterMatch<F, M> =
	F extends RuleFacts<infer O extends ReadonlyArray<unknown>, infer St, infer Fl, infer Sp>
		? RuleFacts<readonly [...O, M], St, Fl, Sp>
		: never

type AfterWhere<F, Ps> =
	F extends RuleFacts<infer O extends ReadonlyArray<unknown>, infer St, infer Fl, infer Sp>
		? RuleFacts<O, St | StatesOf<Ps>, FiltersAfter<Fl, Ps>, Sp | SplitsOf<Ps>>
		: never

/** The filters at a tuple's positions that are each one of several predicates, by what each states (Split). */
type SplitsOf<Ps> = Ps extends readonly [infer X, ...infer Rest]
	? SplitAt<X> | SplitsOf<Rest>
	: never
type SplitAt<X> = [X] extends [UnionToIntersection<X>] ? never : Split<ReadingsOf<X>>
type ReadingsOf<X> = X extends unknown ? Reading<StatesOf<readonly [X]>> : never

type FiltersAfter<Fl, Ps> =
	Fl extends ReadonlyArray<unknown>
		? Ps extends readonly [] | readonly [unknown, ...ReadonlyArray<unknown>]
			? number extends Ps["length"]
				? UnknownFilters
				: readonly [...Fl, ...Ps]
			: UnknownFilters
		: UnknownFilters

/** What may stand opposite a span term: a span term that meets its type, a span parameter among them. */
type SpanOperand<Sp> = Meets<Sp, "range">

/**
 * A scalar parameter of a descriptor of values H, SQL type Sql, domain D and facts F: an input term the caller binds by
 * name to one of the values, whose map entry is the descriptor's type (ParamType), which a term binding it meets and
 * whose language the caller's value is in. It has its descriptor's facts, a contract's declared ones among them, which
 * PostgreSQL checks of every value as it binds it, its placeholder typed by the refinement's domain (lower/conservative
 * context.ts paramTypeRef), so a partial operation over it stands unguarded.
 */
type ParamTerm<Name extends string, H, Sql extends SqlTag, D, F extends ProvedFacts> = Term<
	D,
	{ readonly [K in Name]: ParamType<D, Sql, H> },
	ParamOrigin,
	Sql,
	H,
	F
>

/**
 * A scalar parameter of the descriptor's type and facts, which the caller binds by name; a term, first included. No
 * parameter is bytes (NotStoredOnly). A rule's `r.param` and the free `param`, which a ChangeSet's deleteWhere equates a
 * field to outside any rule, make the same term.
 */
export type ParamConstructor = <
	const Name extends string,
	H,
	Sql extends SqlTag,
	D,
	F extends ProvedFacts
>(
	name: Name,
	type: Field<H, Sql, D, F> & NotStoredOnly<Sql> & NotSearchDocument<Sql> & NotInstant<D>
) => ParamTerm<Name, H, Sql, D, F>

/** What r.relation takes as a heading: a heading of fields C, or a relation, whose heading C is. */
export type RelationHeading<C> = C | { readonly kind: "relation"; readonly heading: C }

/**
 * What r.relation takes as a heading: a heading of fields C, or a relation named N, whose heading C is. A heading of
 * fields names no relation, so N is no literal there.
 */
type ParamHeading<C, N> = C | { readonly kind: "relation"; readonly name: N; readonly heading: C }

/**
 * The refusal a relation parameter's relation carries: none for a heading of fields, whose N is no literal, or a
 * relation of the schema S by its name N and heading C, as the schema resolves the name the Description records.
 */
type ParamRelationOf<S, N extends string, C> = string extends N
	? unknown
	: 0 extends 1 & S
		? unknown
		: ParamRelationAt<UnderName<RelationsOf<S>, N>, C>

/** The refusal of a relation parameter's relation R, the schema's of its name: none where R is a relation of heading C. */
type ParamRelationAt<R, C> = [R] extends [never]
	? Refusal<"the relation is not in this query's schema">
	: [R] extends [{ readonly kind: "relation"; readonly heading: C }]
		? unknown
		: Refusal<"the relation is not in this query's schema">

/**
 * The refusal a relation parameter's heading carries: none for a heading of at least one field, as a relation has, no
 * bytes field, which no parameter holds, no instant, which no caller states, and no search document, which no parameter
 * holds.
 */
type ParamFields<C> = [keyof C] extends [never]
	? Refusal<"a relation parameter has at least one field, as a relation does">
	: [StoredOnlyFieldsIn<C>] extends [never]
		? [InstantFieldsIn<C>] extends [never]
			? [SearchFieldsIn<C>] extends [never]
				? unknown
				: NotSearchDocument<"tsvector">
			: NotInstant<InstantDomain>
		: NotStoredOnly<StoredOnlySql>

/** The search document fields of a heading C, which no parameter holds. */
type SearchFieldsIn<C> = {
	[K in keyof C]-?: C[K] extends { readonly sql: "tsvector" } ? K : never
}[keyof C]

/** The instant fields of a heading C, the database's and stored ones alike, which no parameter holds. */
type InstantFieldsIn<C> = {
	[K in keyof C]-?: C[K] extends StoredInstantField ? K : never
}[keyof C]

/** The bytes fields of a heading C, which no parameter holds. */
type StoredOnlyFieldsIn<C> = {
	[K in keyof C]-?: C[K] extends { readonly sql: StoredOnlySql } ? K : never
}[keyof C]

/**
 * The SQL types min and max are defined over: the numeric family and money, booleans (bool_and and bool_or), text and
 * closed ids, whose order is their codes', but an unordered roster's, which has none (HasOrder).
 */
type MinMaxSql = NumericSql | "bool" | "text" | "code"

/**
 * How one rule's type relates to another's, its members being functions over the rule they are called on (Rule): its
 * schema invariantly, its parameters covariantly and the contexts it reads contravariantly, as a query's. Its sole-match
 * state and facts are what find reads, never a reason one rule is not another, so a rule a filter narrowed is still the
 * rule it was (a fold over filters keeps one accumulator): they stand where every pair of them is never (`reads`).
 */
interface RulePhantom<S, Params, Sole, Facts, Cx> {
	readonly schema: Invariant<S>
	readonly params: Params
	readonly readsContexts: (read: Cx) => void
	readonly reads?: Extract<readonly [Sole, Facts], never>
}

/** Rule.match: a match of a source of the rule's schema, the rule it is called on (Rule). */
type RuleMatch = <
	S,
	Params,
	Sole,
	Facts,
	Cx,
	R extends Matchable,
	K,
	RN,
	C,
	PK,
	BT,
	const B extends Partial<
		Bindings<
			ShownHeading<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>,
			ShownCarriers<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>
		>
	>
>(
	this: Rule<S, Params, Sole, Facts, Cx>,
	source: R & SourceShows<K, RN, C, PK, BT> & ShownMatch<S, R, OrdinaryKind<K, BT>, RN>,
	bindings: B &
		NoExcess<
			B,
			ShownHeading<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>
		> &
		DeadConstants<
			B,
			ShownHeading<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>,
			ShownCarriers<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>
		>
) => Rule<
	S,
	Params & ShownSourceParams<R, OrdinaryKind<K, BT>> & ParamsOfValues<B>,
	[Sole] extends ["no match"]
		? SoleMatch<
				ShownSource<
					R,
					OrdinaryKind<K, BT>,
					RN,
					ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>,
					PK
				>,
				B
			>
		: "joined",
	AfterMatch<
		Facts,
		SoleMatch<
			ShownSource<
				R,
				OrdinaryKind<K, BT>,
				RN,
				ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>,
				PK
			>,
			B
		>
	>,
	Cx | ShownSourceContexts<R, OrdinaryKind<K, BT>>
>

/** Rule.where: filters of the rule it is called on (Rule). */
type RuleWhere = <S, Params, Sole, Facts, Cx, const Ps extends ReadonlyArray<Predicate<never>>>(
	this: Rule<S, Params, Sole, Facts, Cx>,
	...predicates: Ps
) => Rule<
	S,
	Params & ParamsOfEach<Ps>,
	Ps extends readonly [] ? Sole : "joined",
	AfterWhere<Facts, Ps>,
	Cx | PredicateContexts<Ps>
>

/** Rule.find: the head of the rule it is called on (Rule), whose facts it reads by their parts (RuleFacts). */
type RuleFind = <
	S,
	Params,
	Sole,
	O extends ReadonlyArray<unknown>,
	St,
	Fl,
	Sp,
	Cx,
	const H extends Readonly<Record<string, unknown>>
>(
	this: Rule<S, Params, Sole, RuleFacts<O, St, Fl, Sp>, Cx>,
	head: H & {
		readonly [K in keyof H]: HeadTerm & FoldKeyed<S, O, H[K]> & ProducerAlone<H, H[K]>
	}
) => FinishedHead<S, Params, Sole, O, St, Fl, Sp, Cx, HeadTerms<H>>

/** Rule.interior: a stage over the schema of the rule it is called on (Rule). */
type RuleInterior = <
	S,
	Params,
	Sole,
	Facts,
	Cx,
	Head,
	Ev extends InferredEvidence,
	P2,
	IHead,
	Hc extends Carriers,
	Cx2
>(
	this: Rule<S, Params, Sole, Facts, Cx>,
	rule: (r: Rule<S>) => Finished<Head, Ev, P2, S, IHead, Hc, Cx2>
) => InteriorSource<S, Head, P2, Hc, Cx2, Ev>

/** Rule.relation: a relation parameter of the rule it is called on (Rule), over a relation of its schema or a heading. */
type RuleRelation = <
	S,
	Params,
	Sole,
	Facts,
	Cx,
	const Name extends string,
	C extends Record<string, FieldBase>,
	N extends string
>(
	this: Rule<S, Params, Sole, Facts, Cx>,
	name: Name,
	heading: ParamHeading<C, N> & ParamFields<C> & ParamRelationOf<S, N, C>
) => ParamSource<Name, C>

/**
 * Rule.tokens: the tokens of a text, a term of any text, a parameter or a JavaScript string, as a call's value argument
 * of a text field is (types/compute/call.ts CallArgs): a source a rule matches as it matches a call's rows (CallSource),
 * its facts each token's place and the token, needing what its text needs.
 */
type RuleTokens = <const X extends CallArgs<TokensArgs>["text"]>(
	text: X
) => CallSource<
	FactOfFields<TokenFields>,
	BindMapParams<{ readonly text: X }>,
	TokenFields,
	CallReads<{ readonly text: X }>,
	CallNumberings["split"]["tokens"]
>

/** A token split's one argument (RuleTokens): its text, of any text. */
type TokensArgs = { readonly text: TextField<string> }

/**
 * Rule.split: the pieces of a text between the occurrences of its separator, a term of any text, a parameter or a
 * JavaScript string, as a call's value argument of a text field is (types/compute/call.ts CallArgs): a source a rule
 * matches as it matches a call's rows (CallSource), its facts each piece's place and the piece, needing what its text
 * needs. The separator is a string literal, one Unicode scalar value but U+0000, which the builder holds it to.
 */
type RuleSplit = <const X extends CallArgs<TokensArgs>["text"]>(
	text: X,
	separator: string
) => CallSource<
	FactOfFields<PieceFields>,
	BindMapParams<{ readonly text: X }>,
	PieceFields,
	CallReads<{ readonly text: X }>,
	CallNumberings["split"]["pieces"]
>

/**
 * Rule.rest: the text after a prefix, each a term of any text, a parameter or a JavaScript string, as a call's value
 * argument of a text field is: a source a rule matches as it matches a call's rows (CallSource), one fact, the rest,
 * where the text starts with the prefix and none where it does not, needing what its text and prefix need.
 */
type RuleRest = <
	const X extends CallArgs<RestArgs>["text"],
	const P extends CallArgs<RestArgs>["prefix"]
>(
	text: X,
	prefix: P
) => CallSource<
	FactOfFields<RestFields>,
	BindMapParams<{ readonly text: X; readonly prefix: P }>,
	RestFields,
	CallReads<{ readonly text: X; readonly prefix: P }>,
	CallNumberings["split"]["rest"]
>

/**
 * Rule.decodedPath: the path a percent-encoded URI path spells, a term of any text, a parameter or a JavaScript string,
 * as a call's value argument of a text field is: a source a rule matches as it matches a call's rows (CallSource), one
 * fact, the path, where the text spells one and none where it does not, needing what its text needs.
 */
type RuleDecodedPath = <const X extends CallArgs<TokensArgs>["text"]>(
	text: X
) => CallSource<
	FactOfFields<DecodedPathFields>,
	BindMapParams<{ readonly text: X }>,
	DecodedPathFields,
	CallReads<{ readonly text: X }>,
	CallNumberings["split"]["decodedPath"]
>

/**
 * Rule.resolvedWithin: a reference's target within its base, each a term of any text, a parameter or a JavaScript
 * string, as a call's value argument of a text field is: a source a rule matches as it matches a call's rows
 * (CallSource), one fact, the target, where no `..` climbs past the root of the path its resolution walks and none where
 * one does, needing what its base and reference need.
 */
type RuleResolvedWithin = <
	const B extends CallArgs<WithinArgs>["base"],
	const X extends CallArgs<WithinArgs>["reference"]
>(
	base: B,
	reference: X
) => CallSource<
	FactOfFields<WithinFields>,
	BindMapParams<{ readonly base: B; readonly reference: X }>,
	WithinFields,
	CallReads<{ readonly base: B; readonly reference: X }>,
	CallNumberings["split"]["resolvedWithin"]
>

/**
 * Rule.splitLast: the text split at the last occurrence of its separator, a term of any text, a parameter or a
 * JavaScript string, as a call's value argument of a text field is: a source a rule matches as it matches a call's rows
 * (CallSource), one fact, the text before that occurrence and the text after it, where the text holds the separator and
 * none where it does not, needing what its text needs. The separator is a string literal, one Unicode scalar value but
 * U+0000, which the builder holds it to.
 */
type RuleSplitLast = <const X extends CallArgs<TokensArgs>["text"]>(
	text: X,
	separator: string
) => CallSource<
	FactOfFields<SplitLastFields>,
	BindMapParams<{ readonly text: X }>,
	SplitLastFields,
	CallReads<{ readonly text: X }>,
	CallNumberings["split"]["splitLast"]
>

/** A target within a base's two arguments (RuleResolvedWithin): its base and its reference, each of any text. */
type WithinArgs = { readonly base: TextField<string>; readonly reference: TextField<string> }

/** A rest's two arguments (RuleRest): its text and its prefix, each of any text. */
type RestArgs = { readonly text: TextField<string>; readonly prefix: TextField<string> }

/**
 * Rule.series: each integer from `low` to `high`, both included, a source the rule matches as it matches a call's rows
 * (CallSource), of SeriesFields, needing what its ends need. Each end is a term, a parameter or a typed constant of an
 * integer type (SeriesEnd); every element lies between the least value `low` takes and the greatest `high` takes,
 * which the checker reads of it (check/checker.ts Checker.series), a bound no type here states.
 */
type RuleSeries = <const L extends TermBase, const H extends TermBase>(
	low: L & SeriesEnd<L>,
	high: H & SeriesEnd<H>
) => CallSource<
	FactOfFields<SeriesFields>,
	BindMapParams<{ readonly low: L; readonly high: H }>,
	SeriesFields,
	CallReads<{ readonly low: L; readonly high: H }>,
	CallNumberings["series"]
>

/** The SQL types a series' end is of (RuleSeries): an integer's, a bigint's and an exact integer's. */
type SeriesSql = "int2" | "int4" | "int8" | "exact integer"

/** A series' end (RuleSeries): a term of a SeriesSql type, any other refused by name. */
type SeriesEnd<X> =
	SqlOfTerm<X> extends SeriesSql
		? unknown
		: Refusal<"an integer for each end of r.series: an int2, int4, int8 or exact integer term, parameter or typed constant">

/** A series' heading (RuleSeries): `at`, each element, an exact integer, as integer arithmetic counts. */
type SeriesFields = { readonly at: ExactIntegerField }

/** A token split's heading (RuleTokens): each token's place from 0, and the token, a record of carriers. */
type TokenFields = { readonly at: NaturalField; readonly token: TextField<string> }

/** A separator split's heading (RuleSplit): each piece's place from 0, and the piece, a record of carriers. */
type PieceFields = { readonly at: NaturalField; readonly piece: TextField<string> }

/** A rest's heading (RuleRest): the text after the prefix. */
type RestFields = { readonly rest: TextField<string> }

/** A decoded path's heading (RuleDecodedPath): the path the text spells. */
type DecodedPathFields = { readonly path: TextField<string> }

/** A target within a base's heading (RuleResolvedWithin): the reference's target. */
type WithinFields = { readonly target: TextField<string> }

/** A split at the last separator's heading (RuleSplitLast): the text before that separator and the text after it. */
type SplitLastFields = { readonly before: TextField<string>; readonly after: TextField<string> }

/** Rule.not: a relational negation over a source of the schema of the rule it is called on (Rule). */
type RuleNot = <
	S,
	Params,
	Sole,
	Facts,
	Cx,
	R extends Matchable,
	K,
	RN,
	C,
	PK,
	BT,
	const B extends Partial<
		NegatedBindings<
			ShownHeading<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>,
			ShownCarriers<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>
		>
	>
>(
	this: Rule<S, Params, Sole, Facts, Cx>,
	relation: R & SourceShows<K, RN, C, PK, BT> & ShownMatch<S, R, OrdinaryKind<K, BT>, RN>,
	bindings: B &
		NoExcess<
			B,
			ShownHeading<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>
		> &
		NegatedCarriers<
			B,
			ShownCarriers<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>
		> &
		DeadConstants<
			B,
			ShownHeading<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>,
			ShownCarriers<R, OrdinaryKind<K, BT>, ShownHeadingOf<HeadingIn<R>, C, EachInstanceOf<RN, C>>>
		>
) => Predicate<ShownSourceParams<R, OrdinaryKind<K, BT>> & ParamsOfValues<B>> &
	Shaped<Negation> &
	ReadsContexts<ShownSourceContexts<R, OrdinaryKind<K, BT>>> &
	Negating<true>

/**
 * The rule builder a query arm receives. Every method threads its parameter map: a rule's parameters are the
 * intersection of what its matches, predicates and head use, so they are inferred from their uses. The sole-match
 * state and the rule's facts feed the evidence approximation of ../evidence/evidence.ts. The runtime rule is the builder
 * of query/build/rule.ts, which the public barrel public/query.ts types through QueryBuilder.rule.
 *
 * Sole is the rule's only match while it has no other clause (SoleMatch), NoMatch before any, Joined after more; Facts
 * is what find reads of every match and filter (RuleFacts), from which the head's keys follow (HeadKeys).
 *
 * Each member that reads the rule's own type arguments is a function over the rule it is called on, `this: Rule<S,
 * Params, Sole, Facts, Cx>`, declared once at the top level (RuleMatch, RuleWhere, RuleFind, RuleInterior,
 * RuleRelation, RuleNot), and the rule's phantom says how one rule's type relates to another's (RulePhantom). The
 * checker instantiates a method of a generic interface in two steps, the interface's type arguments, then the call's
 * own, and the second walks every type the first put in: the schema, every relation of it and each relation's field
 * record, an object-literal type the checker takes for one that may hold a type variable, once per call and per
 * inference pass, so every call of a rule over a schema of n relations cost n. A function that reads its rule from
 * `this` holds only its own type parameters, so a call maps S to the schema without walking it, and the member is one
 * type in every rule. A member is called on its rule, as a method is.
 */
export interface Rule<S, Params = unknown, Sole = "no match", Facts = NoFacts, Cx = never> {
	readonly [phantom]?: RulePhantom<S, Params, Sole, Facts, Cx> | undefined
	readonly match: RuleMatch
	readonly where: RuleWhere
	/**
	 * Each entry is checked where it stands (HeadTerm), never through H's constraint: an entry no head holds is refused
	 * at its key, an aggregate over a rule whose matches bind no key of their sources too (FoldKeyed), a span producer
	 * beside an aggregate or another producer too (ProducerAlone), and the query keeps the head as written, so nothing
	 * built on it refuses again.
	 */
	readonly find: RuleFind
	/** A stage over the rule's own schema, so it carries S like the query it is part of. */
	readonly interior: RuleInterior

	/** A scalar parameter of the descriptor's type and facts (ParamConstructor). */
	readonly param: ParamConstructor
	/**
	 * A relation-valued parameter over a heading of fields, or over a relation of the rule's schema, whose heading it
	 * takes; the Description names the relation, which the schema resolves.
	 */
	readonly relation: RuleRelation
	/**
	 * The tokens of a whitespace-separated list (XML Schema Part 2 §3.3.10, a list's lexical space), a source the rule
	 * matches: `at`, each token's place from 0, a natural, and `token`, its run of no XML whitespace, the text collapsed
	 * and split at its spaces, none of a text of whitespace alone (RuleTokens).
	 */
	readonly tokens: RuleTokens
	/**
	 * The pieces of a text between the occurrences of its separator, a source the rule matches: `at`, each piece's place
	 * from 0, a natural, and `piece`, a text that holds no separator, n occurrences giving n + 1 pieces, the empty ones
	 * kept, so the empty text is one empty piece (RuleSplit).
	 */
	readonly split: RuleSplit
	/**
	 * The text after a prefix, a source the rule matches: one fact, `rest`, the text past the prefix, where the text
	 * starts with the prefix, and none where it does not (RuleRest).
	 */
	readonly rest: RuleRest
	/**
	 * The path a percent-encoded URI path spells (RFC 3986 §2.1, §2.5), a source the rule matches: one fact, `path`, each
	 * `%HH` its octet read as UTF-8, where the text spells one, and none where a `%` begins no `%HH`, the octets are no
	 * UTF-8, an escape decodes to U+0000 or `/`, or a dot segment is written `%2E` (RuleDecodedPath).
	 */
	readonly decodedPath: RuleDecodedPath
	/**
	 * A reference's target within its base (RFC 3986 §5.2), a source the rule matches: one fact, `target`, the reference
	 * resolved against the base, where no `..` segment of the path its resolution walks climbs past that path's root, and
	 * none where one does (RuleResolvedWithin).
	 */
	readonly resolvedWithin: RuleResolvedWithin
	/**
	 * The text split at the last occurrence of its separator, a source the rule matches: one fact, `before`, the text
	 * before that occurrence, and `after`, the text after it, a text that holds no separator, where the text holds the
	 * separator, and none where it does not (RuleSplitLast).
	 */
	readonly splitLast: RuleSplitLast
	/**
	 * Each integer from `low` to `high`, both included, none where `low` lies above `high`, a source the rule matches:
	 * `at`, each integer, of the ends' common type, every one between the least value `low` takes and the greatest
	 * `high` takes, which a term of the rule reads of it (RuleSeries).
	 */
	readonly series: RuleSeries

	/**
	 * An equality between a variable and a value fixed per binding fixes the variable, and one between two variables
	 * makes each determine the other (EqualityStates): a key bound to a fixed variable pins its occurrence, and a group
	 * term holding it is one group per binding. A JavaScript value keeps its own type and a typed constant its column's
	 * value, the value it fixes the variable to, which a union compares across its arms (evidence/evidence.ts
	 * UnionEvidence).
	 * Every predicate records its shape for the reflexive proof (../evidence/evidence.ts Shaped). A first operand admits
	 * a JavaScript value beside a term only to refuse it by name (FirstTerm).
	 */
	eq<
		A extends TermBase | FirstValue,
		const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>> | RefinedTerm<A>
	>(
		a: A & FirstTerm<A>,
		b: B & RefinedEquality<A, B>
	): Compared<"eq", A, B> & Stating<EqualityStates<A, B>>
	ne<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"ne", A, B>
	lt<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A> & OrderedOperand<A>,
		b: B
	): Compared<"lt", A, B>
	le<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A> & OrderedOperand<A>,
		b: B
	): Compared<"le", A, B>
	gt<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A> & OrderedOperand<A>,
		b: B
	): Compared<"gt", A, B>
	ge<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A> & OrderedOperand<A>,
		b: B
	): Compared<"ge", A, B>
	between<
		A extends TermBase | FirstValue,
		const L extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>,
		const H extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>
	>(
		a: A & FirstTerm<A> & OrderedOperand<A>,
		low: L,
		high: H
	): Predicate<P<A> & P<L> & P<H>, Reads<readonly [A, L, H]>> & Shaped<Opaque<readonly [A, L, H]>>
	/**
	 * A membership test: over a roster variable it keeps the variable to the handles it lists, which the head that finds
	 * it finds alone (evidence/evidence.ts MembershipStates, FoundOf), as the WHERE holds it.
	 */
	in<A extends TermBase | FirstValue, const Vs extends ReadonlyArray<LiteralOf<LanguageOf<A>>>>(
		a: A & FirstTerm<A>,
		values: Vs
	): Predicate<P<A>, Reads<readonly [A]>> &
		Shaped<Opaque<readonly [A]>> &
		Stating<MembershipStates<A, Vs[number]>>
	/** A conjunction states what each conjunct states; a disjunction states nothing. */
	and<const Ps extends ReadonlyArray<Predicate<never>>>(
		predicates: Ps
	): Predicate<ParamsOfEach<Ps>, Reads<Ps>> &
		Stating<StatesOf<Ps>> &
		Shaped<Conjunction<Ps>> &
		ReadsContexts<PredicateContexts<Ps>> &
		NegatesIn<Ps>
	/** A disjunction holds no relational negation: r.not is a rule-level filter (Negating). */
	or<const Ps extends ReadonlyArray<Predicate<never>>>(
		predicates: NegationFreeEach<Ps>
	): Predicate<ParamsOfEach<Ps>, Reads<Ps>> &
		Shaped<Disjunction<Ps>> &
		ReadsContexts<PredicateContexts<Ps>>
	/**
	 * Relational negation only. It reads a relation, no computation over its operands, so its origin is unknown, and it
	 * stands only as a rule's filter, alone or in a conjunction that does (Negating).
	 */
	readonly not: RuleNot

	/**
	 * The second span may be a parameter of the first span's type: a window is a span parameter.
	 * A mask is any union of ALLEN's members: a bitwise OR of two masks is a number, and `ALLEN.after | ALLEN.metBy`
	 * is a valid mask, so the compiler, not the brand, checks the thirteen-bit range. A mask of exactly equals, as
	 * `ALLEN.equals` and its converse are, is an equality of the two spans, which states what r.eq states
	 * (EqualityStates), as the engine lowers it to one; a number, whose relations the types do not know, states nothing.
	 */
	allen<A extends TermBase | FirstValue, B extends SpanOperand<T<A>>, M extends AllenMask | number>(
		left: A & Requires<IsSpan<A>, "a range term is required"> & FirstTerm<A>,
		mask: M,
		right: B
	): Predicate<P<A> & P<B>, Reads<readonly [A, B]>> &
		Shaped<Opaque<readonly [A, B]>> &
		EqualsStating<M, A, B>
	/** `s @> t`; the span may be a parameter of the point's span type. */
	pointIn<Pt extends TermBase | FirstValue, Sp extends SpanOperand<Span<T<Pt>>>>(
		point: Pt & FirstTerm<Pt>,
		span: Sp
	): Predicate<P<Pt> & P<Sp>, Reads<readonly [Pt, Sp]>> & Shaped<Opaque<readonly [Pt, Sp]>>
	/**
	 * Zero or one fact, of the left span's type: it states it produces an intersection, which a rule pinned to one
	 * binding yields at most one of (evidence/evidence.ts ProducedCard).
	 */
	intersection<A extends TermBase | FirstValue, X, PA, OA, V, L, B extends SpanOperand<X>>(
		left: A & FirstTerm<A> & Term<X, PA, OA, "range", V, ProvedFacts, L>,
		right: B
	): Producer<V, PA & P<B>, X, L, ComputedOrigin<OA | OperandOrigin<B>>> & {
		readonly produces: "intersection"
	}
	/** Zero, one, or two facts, of the left span's type. */
	difference<A extends TermBase | FirstValue, X, PA, OA, V, L, B extends SpanOperand<X>>(
		left: A & FirstTerm<A> & Term<X, PA, OA, "range", V, ProvedFacts, L>,
		right: B
	): Producer<V, PA & P<B>, X, L, ComputedOrigin<OA | OperandOrigin<B>>>
	/** Maximal covered segments. */
	pack<A extends TermBase | FirstValue, X, PA, OA, V, L>(
		spans: A & FirstTerm<A> & Term<X, PA, OA, "range", V, ProvedFacts, L>
	): Producer<V, PA, X, L, ComputedOrigin<OA>>
	/**
	 * Zero or one fact, the range from `start` to `end`, start included and end excluded, of the range type over the
	 * start's type: none where the end is not after the start. The start is a term of a range endpoint's type, int4, int8,
	 * date or a contract over one, never an instant, the database's alone; the end a term of that type, a typed constant
	 * (Type.literal) among them. It states that it produces at most one fact per binding, as an intersection does.
	 */
	range<
		A extends TermBase | FirstValue,
		D,
		PA,
		OA,
		ES extends EndpointSql,
		H,
		L,
		B extends InputTerm<D, never, unknown, ES>
	>(
		start: A & FirstTerm<A> & Term<D, PA, OA, ES, H, ProvedFacts, L> & NotInstant<D>,
		end: B
	): Producer<Span<H>, PA & P<B>, Span<D>, Span<L>, ComputedOrigin<OA | OperandOrigin<B>>> & {
		readonly produces: "span"
	}

	/**
	 * count is a natural, whose host and SQL type are bigint's; sum and mean take their result type off the SUM and AVG
	 * tables by their argument's SQL type (scalar/compute/tables.ts): a sum over any integer is an exact numeric.
	 */
	count(): Aggregate<bigint, unknown, "int8", NaturalDomain, bigint, "count">
	sum<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql>(
		term: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): OfFamily<
		A,
		NumericSql,
		Aggregate<
			PlainHost[SumSql[S]],
			PA,
			SumSql[S],
			PlainHost[SumSql[S]],
			PlainHost[SumSql[S]],
			"sum"
		>
	>
	mean<A extends TermBase | FirstValue, X, PA, OA, S extends keyof AvgSql>(
		term: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): OfFamily<
		A,
		keyof AvgSql,
		Aggregate<
			PlainHost[AvgSql[S]],
			PA,
			AvgSql[S],
			PlainHost[AvgSql[S]],
			PlainHost[AvgSql[S]],
			"mean"
		>
	>
	/**
	 * min and max return an input unchanged, so they keep its type, a contract and a roster included, its values and
	 * its language.
	 */
	min<A extends TermBase | FirstValue, X, PA, OA, S extends MinMaxSql, V, L>(
		term: A & FirstTerm<A> & Term<X, PA, OA, S, V, ProvedFacts, L> & OrderedOperand<A>
	): Admitted<HasOrder<A>, OfFamily<A, MinMaxSql, Aggregate<V, PA, S, X, L, "min">>>
	max<A extends TermBase | FirstValue, X, PA, OA, S extends MinMaxSql, V, L>(
		term: A & FirstTerm<A> & Term<X, PA, OA, S, V, ProvedFacts, L> & OrderedOperand<A>
	): Admitted<HasOrder<A>, OfFamily<A, MinMaxSql, Aggregate<V, PA, S, X, L, "max">>>
}
