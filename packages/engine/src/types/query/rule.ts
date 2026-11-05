import type { AllenMask } from "#compiler/allen/mask.ts"
import type { Built, phantom, Phantom } from "#compiler/core/phantom.ts"
import type { AvgSql, NumericSql, PlainHost, SumSql } from "#compiler/scalar/compute/tables.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type {
	FirstTerm,
	FirstValue,
	IsSpan,
	OfFamily,
	Operand,
	Requires
} from "#compiler/types/compute/scalar.ts"

import type {
	Carriers,
	ComputedOrigin,
	Facts as ProvedFacts,
	InputTerm,
	Invariant,
	LanguageOf,
	Meets,
	OperandOrigin,
	ParamOrigin,
	ParamsContribution,
	ParamType,
	ParamsOfTerm,
	Predicate,
	Refusal,
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
	ArmProofOf,
	Comparison,
	ComparisonOp,
	Conjunction,
	ContainmentProof,
	Disjunction,
	EqualityStates,
	Evidence,
	EvidenceOf,
	StatesOf,
	Stating,
	HeadKeys,
	HeadValues,
	Negation,
	Opaque,
	Proofs,
	ReflexiveProof,
	Shaped,
	SoleMatch
} from "#compiler/types/evidence/evidence.ts"
import type { Field, FieldBase, LiteralOf } from "#compiler/types/fields/field.ts"
import type { BoundSource, ContextsOf, Finished } from "#compiler/types/query/query.ts"
import type {
	Aggregate,
	BindingParams,
	Bindings,
	CarriersOf,
	DeadConstants,
	HeadOrigins,
	HeadParams,
	HeadTerm,
	HeadTerms,
	NoExcess,
	ParamSource,
	Producer,
	ResultOf
} from "#compiler/types/query/terms.ts"
import type { AnyClosed, AnyRelation, HeadingOf, NameOf } from "#compiler/types/schema/relation.ts"
import type { IsLevelOf, IsRelationOf, KeysOf } from "#compiler/types/schema/schema.ts"
import type { AnyContext, AnyWorld } from "#compiler/types/schema/world.ts"

type T<A> = TypeOfTerm<A>
type P<A> = ParamsOfTerm<A>
/**
 * What find returns over a head of terms H, a head whose JavaScript values are its literal terms (HeadTerms): an arm
 * that attaches nothing yet.
 */
type FinishedHead<S, Params, Sole, Facts, Cx, H extends Carriers> = Finished<
	ResultOf<H>,
	EvidenceOf<
		H,
		HeadKeys<S, OccurrencesOf<Facts>, H, StatedAt<Facts>>,
		HeadValues<H, StatedAt<Facts>>,
		HeadOrigins<H, OccurrencesOf<Facts>>,
		ProofsAt<S, Sole, Facts, H>
	>,
	Simplify<Params & HeadParams<H>>,
	S,
	ResultOf<H>,
	H,
	Cx
>
/** A predicate's origin: a computation over its operands, terms or predicates. */
type Reads<Os extends ReadonlyArray<unknown>> = ComputedOrigin<OperandOrigin<Os[number]>>

/**
 * A head with an aggregate folds the facts its rule matches, each read once by a key (the engine's FoldInput): every
 * match binds, by a variable, a parent variable or a constant, every field of one key of its source, a context's one
 * fact by the empty key and a relation parameter, an imported query or an interior stage by its whole heading, a set
 * keyed by its heading. A match that binds no key whole would fold a projection of its facts, and is refused; distinct
 * values are folded by matching a query of them as the source.
 */
type FoldsKeyed<S, Os, H> = [HeadAggregates<H>] extends [never]
	? unknown
	: EveryMatchKeyed<S, Os> extends true
		? unknown
		: Refusal<"a fold reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values">

type HeadAggregates<H> = {
	[K in keyof H]-?: H[K] extends Aggregate<unknown> ? K : never
}[keyof H]

type EveryMatchKeyed<S, Os> = Os extends readonly [infer M, ...infer Rest]
	? MatchKeyed<S, M> extends true
		? EveryMatchKeyed<S, Rest>
		: false
	: true

type MatchKeyed<S, M> =
	M extends SoleMatch<infer R, infer B>
		? R extends AnyContext
			? true
			: R extends AnyRelation | AnyClosed | AnyDerived | AnyWorld
				? BindsAKey<KeysOf<S, R>, keyof B>
				: [keyof HeadingOf<R>] extends [keyof B]
					? true
					: false
		: false

/** Whether one of the keys, each a tuple of fields, has every field among the bound ones. */
type BindsAKey<Keys, Bound> = 0 extends 1 & Keys
	? false
	: true extends (Keys extends ReadonlyArray<infer F> ? ([F] extends [Bound] ? true : false) : false)
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

type RequireLevel<S, R> =
	R extends Phantom<{ readonly schema: Invariant<infer QS> }>
		? IsLevelOf<S, QS> extends true
			? unknown
			: Refusal<"the query is not over a level of this query's schema">
		: unknown

export type RequireBound<R> =
	R extends Phantom<{ readonly params: infer QP }>
		? [keyof QP] extends [never]
			? unknown
			: Refusal<"bind the query's parameters before matching it: Q.bind({ ... })">
		: unknown

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
/**
 * The parameters a list of predicates needs: every one any of them may use. A spread array of unknown length, or a
 * conditional between two predicates, may run any of its members, so each member's parameters are required, as the
 * fixed positions of a tuple are.
 */
type PredicateParams<Ps> = Ps extends readonly [infer H, ...infer Rest]
	? AnyMemberParams<H> & PredicateParams<Rest>
	: Ps extends readonly []
		? unknown
		: Ps extends ReadonlyArray<infer X>
			? AnyMemberParams<X>
			: unknown

type AnyMemberParams<X> = UnionToIntersection<
	X extends unknown ? ParamsContribution<ParamsOfTerm<X>> : never
>
/** A comparison records its operator and operands for the reflexive proof (../evidence/evidence.ts ReflexiveProof). */
type Compared<Op extends ComparisonOp, A, B> = Compare<A, B> & Shaped<Comparison<Op, A, B>>

/**
 * What a rule records beyond its parameters and its pinned, sole and only states, for the evidence its find reads
 * (../evidence/evidence.ts): every occurrence it matched, in order, which the head's keys and origins are read from
 * (HeadKeys, HeadOrigins); what its filters state (evidence/evidence.ts Stating): a variable compared with r.eq against
 * a value fixed per binding is fixed, two variables compared are equal; and its filters in order, or UnknownFilters
 * once a where spreads an array of unknown length.
 */
interface RuleFacts<Occurrences extends ReadonlyArray<unknown>, Stated, Filters = readonly []> {
	readonly occurrences: Occurrences
	readonly stated: Stated
	readonly filters: Filters
}

interface UnknownFilters {
	readonly unknownFilters: true
}
export type NoFacts = RuleFacts<readonly [], never>
type AfterMatch<F, R, B> =
	F extends RuleFacts<infer O extends ReadonlyArray<unknown>, infer St, infer Fl>
		? RuleFacts<readonly [...O, SoleMatch<R, B>], St, Fl>
		: never

type AfterWhere<F, Ps> =
	F extends RuleFacts<infer O extends ReadonlyArray<unknown>, infer St, infer Fl>
		? RuleFacts<O, St | StatesOf<Ps>, FiltersAfter<Fl, Ps>>
		: never

type FiltersAfter<Fl, Ps> =
	Fl extends ReadonlyArray<unknown>
		? Ps extends readonly [] | readonly [unknown, ...ReadonlyArray<unknown>]
			? number extends Ps["length"]
				? UnknownFilters
				: readonly [...Fl, ...Ps]
			: UnknownFilters
		: UnknownFilters

/** What the rule's filters state of its variables by origin, each origin the one variable of its scope's field. */
type StatedAt<F> = F extends { readonly stated: infer St } ? St : never
type OccurrencesOf<F> = F extends { readonly occurrences: infer O extends ReadonlyArray<unknown> }
	? O
	: readonly []
type FiltersAt<F> = F extends { readonly filters: infer Fl } ? Fl : UnknownFilters
/** What the rule's clauses prove of a head H (../evidence/evidence.ts Proofs). */
type ProofsAt<S, Sole, F, H> = Proofs<
	ContainmentProof<S, Sole, H>,
	ReflexiveProof<OccurrencesOf<F>, FiltersAt<F>, H>,
	ArmProofOf<S, Sole, H>
>

/** What may stand opposite a span term: a span term that meets its type, a span parameter among them. */
type SpanOperand<Sp> = Meets<Sp, "range">

/**
 * A scalar parameter of a descriptor of values H, SQL type Sql, domain D and facts F: an input term the caller binds by
 * name to one of the values, whose map entry is the descriptor's type (ParamType), which a term binding it meets and
 * whose language the caller's value is in. It has its descriptor's facts, a contract's declared ones among them, which
 * the binding checks of every value (codec/scalar.ts refinedValue), so a partial operation over it stands unguarded.
 */
type ParamTerm<Name extends string, H, Sql extends SqlTag, D, F extends ProvedFacts> = Term<
	D,
	{ readonly [K in Name]: ParamType<D, Sql, H> },
	ParamOrigin,
	Sql,
	H,
	F
>

/** What r.relation takes as a heading: a heading of fields C, or a relation, whose heading C is. */
export type RelationHeading<C> = C | { readonly kind: "relation"; readonly heading: C }

/** The refusal a relation parameter's heading carries: none for a heading of at least one field, as a relation has. */
export type ParamFields<C> = [keyof C] extends [never]
	? Refusal<"a relation parameter has at least one field, as a relation does">
	: unknown

/**
 * The SQL types min and max are defined over: the numeric family and money, booleans (bool_and and bool_or), text and
 * closed ids, whose order is their codes'.
 */
type MinMaxSql = NumericSql | "boolean" | "text" | "code"

/**
 * The rule builder a query arm receives. Every method threads its parameter map: a rule's parameters are the
 * intersection of what its matches, predicates and head use, so they are inferred from their uses. The sole-match
 * state and the rule's facts feed the evidence approximation of ../evidence/evidence.ts. The runtime rule is the builder
 * of query/build/rule.ts, which the public barrel public/query.ts types through QueryBuilder.rule.
 *
 * Sole is the rule's only match while it has no other clause (SoleMatch), NoMatch before any, Joined after more; Facts
 * is what find reads of every match and filter (RuleFacts), from which the head's keys follow (HeadKeys).
 */
export interface Rule<S, Params = unknown, Sole = "no match", Facts = NoFacts, Cx = never> {
	match<R extends Matchable, const B extends Partial<Bindings<HeadingOf<R>, CarriersOf<R>>>>(
		source: R & MatchCheck<S, R>,
		bindings: B & NoExcess<B, HeadingOf<R>> & DeadConstants<B, HeadingOf<R>, CarriersOf<R>>
	): Rule<
		S,
		Params & SourceParamsOf<R> & BindingParams<B>,
		[Sole] extends ["no match"] ? SoleMatch<R, B> : "joined",
		AfterMatch<Facts, R, B>,
		Cx | SourceContexts<R>
	>
	where<const Ps extends ReadonlyArray<Predicate>>(
		...predicates: Ps
	): Rule<
		S,
		Params & PredicateParams<Ps>,
		Ps extends readonly [] ? Sole : "joined",
		AfterWhere<Facts, Ps>,
		Cx | PredicateContexts<Ps>
	>
	/**
	 * Each entry is checked where it stands (HeadTerm), never through H's constraint: an entry no head holds is refused
	 * at its key, and the query keeps the head as written, so nothing built on it refuses again.
	 */
	find<const H extends Readonly<Record<string, unknown>>>(
		head: H & { readonly [K in keyof H]: HeadTerm } & FoldsKeyed<S, OccurrencesOf<Facts>, H>
	): FinishedHead<S, Params, Sole, Facts, Cx, HeadTerms<H>>
	/** A stage over the rule's own schema, so it carries S like the query it is part of. */
	interior<Head, Ev extends Evidence, P2, IHead, Hc extends Carriers, Cx2>(
		rule: (r: Rule<S>) => Finished<Head, Ev, P2, S, IHead, Hc, Cx2>
	): BoundSource<S, Head, P2, Hc, Cx2>

	/** A scalar parameter of the descriptor's type and facts, which the caller binds by name; a term, first included. */
	param<const Name extends string, H, Sql extends SqlTag, D, F extends ProvedFacts>(
		name: Name,
		type: Field<H, Sql, D, F>
	): ParamTerm<Name, H, Sql, D, F>
	/** A relation-valued parameter over a heading of fields, or over a relation, whose heading it takes. */
	relation<const Name extends string, C extends Record<string, FieldBase>>(
		name: Name,
		heading: RelationHeading<C> & ParamFields<C>
	): ParamSource<Name, C>

	/**
	 * An equality between a variable and a value fixed per binding fixes the variable, and one between two variables
	 * makes each determine the other (EqualityStates): a key bound to a fixed variable pins its occurrence, and a group
	 * term holding it is one group per binding. A JavaScript value keeps its own type and a typed constant its column's
	 * value, the value it fixes the variable to, which a union compares across its arms (evidence/evidence.ts
	 * UnionEvidence).
	 * Every predicate records its shape for the reflexive proof (../evidence/evidence.ts Shaped). A first operand admits
	 * a JavaScript value beside a term only to refuse it by name (FirstTerm).
	 */
	eq<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"eq", A, B> & Stating<EqualityStates<A, B>>
	ne<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"ne", A, B>
	lt<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"lt", A, B>
	le<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"le", A, B>
	gt<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"gt", A, B>
	ge<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"ge", A, B>
	between<
		A extends TermBase | FirstValue,
		const L extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>,
		const H extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>
	>(
		a: A & FirstTerm<A>,
		low: L,
		high: H
	): Predicate<P<A> & P<L> & P<H>, Reads<readonly [A, L, H]>> & Shaped<Opaque<readonly [A, L, H]>>
	inSet<A extends TermBase | FirstValue>(
		a: A & FirstTerm<A>,
		values: ReadonlyArray<LiteralOf<LanguageOf<A>>>
	): Predicate<P<A>, Reads<readonly [A]>> & Shaped<Opaque<readonly [A]>>
	/** A conjunction states what each conjunct states; a disjunction states nothing. */
	and<const Ps extends ReadonlyArray<Predicate>>(
		...predicates: Ps
	): Predicate<PredicateParams<Ps>, Reads<Ps>> &
		Stating<StatesOf<Ps>> &
		Shaped<Conjunction<Ps>> &
		ReadsContexts<PredicateContexts<Ps>>
	or<const Ps extends ReadonlyArray<Predicate>>(
		...predicates: Ps
	): Predicate<PredicateParams<Ps>, Reads<Ps>> &
		Shaped<Disjunction<Ps>> &
		ReadsContexts<PredicateContexts<Ps>>
	/** Relational negation only. It reads a relation, no computation over its operands, so its origin is unknown. */
	not<R extends Matchable, const B extends Partial<Bindings<HeadingOf<R>, CarriersOf<R>>>>(
		relation: R & MatchCheck<S, R>,
		bindings: B & NoExcess<B, HeadingOf<R>> & DeadConstants<B, HeadingOf<R>, CarriersOf<R>>
	): Predicate<SourceParamsOf<R> & BindingParams<B>> &
		Shaped<Negation> &
		ReadsContexts<SourceContexts<R>>

	/**
	 * The second span may be a parameter of the first span's type: a window is a span parameter.
	 * A mask is any union of ALLEN's members: a bitwise OR of two masks is a number, and `ALLEN.after | ALLEN.metBy`
	 * is a valid mask, so the compiler, not the brand, checks the thirteen-bit range.
	 */
	allen<A extends TermBase | FirstValue, B extends SpanOperand<T<A>>>(
		left: A & Requires<IsSpan<A>, "a span term is required"> & FirstTerm<A>,
		mask: AllenMask | number,
		right: B
	): Predicate<P<A> & P<B>, Reads<readonly [A, B]>> & Shaped<Opaque<readonly [A, B]>>
	/** `s @> t`; the span may be a parameter of the point's span type. */
	pointIn<Pt extends TermBase | FirstValue, Sp extends SpanOperand<Span<T<Pt>>>>(
		point: Pt & FirstTerm<Pt>,
		span: Sp
	): Predicate<P<Pt> & P<Sp>, Reads<readonly [Pt, Sp]>> & Shaped<Opaque<readonly [Pt, Sp]>>
	/** Zero or one fact, of the left span's type. */
	intersection<A extends TermBase | FirstValue, X, PA, OA, V, L, B extends SpanOperand<X>>(
		left: A & FirstTerm<A> & Term<X, PA, OA, "range", V, ProvedFacts, L>,
		right: B
	): Producer<V, PA & P<B>, X, L>
	/** Zero, one, or two facts, of the left span's type. */
	difference<A extends TermBase | FirstValue, X, PA, OA, V, L, B extends SpanOperand<X>>(
		left: A & FirstTerm<A> & Term<X, PA, OA, "range", V, ProvedFacts, L>,
		right: B
	): Producer<V, PA & P<B>, X, L>
	/** Maximal covered segments. */
	pack<A extends TermBase | FirstValue, X, PA, OA, V, L>(
		spans: A & FirstTerm<A> & Term<X, PA, OA, "range", V, ProvedFacts, L>
	): Producer<V, PA, X, L>

	/**
	 * count is bigint; sum and mean take PostgreSQL's result type over their argument's SQL type
	 * (scalar/compute/tables.ts).
	 */
	count(): Aggregate<bigint, unknown, "bigint">
	sum<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql>(
		term: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): OfFamily<A, NumericSql, Aggregate<PlainHost[SumSql[S]], PA, SumSql[S]>>
	mean<A extends TermBase | FirstValue, X, PA, OA, S extends keyof AvgSql>(
		term: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): OfFamily<A, keyof AvgSql, Aggregate<PlainHost[AvgSql[S]], PA, AvgSql[S]>>
	/**
	 * min and max return an input unchanged, so they keep its type, a contract and a roster included, its values and
	 * its language.
	 */
	min<A extends TermBase | FirstValue, X, PA, OA, S extends MinMaxSql, V, L>(
		term: A & FirstTerm<A> & Term<X, PA, OA, S, V, ProvedFacts, L>
	): OfFamily<A, MinMaxSql, Aggregate<V, PA, S, X, L>>
	max<A extends TermBase | FirstValue, X, PA, OA, S extends MinMaxSql, V, L>(
		term: A & FirstTerm<A> & Term<X, PA, OA, S, V, ProvedFacts, L>
	): OfFamily<A, MinMaxSql, Aggregate<V, PA, S, X, L>>
}
