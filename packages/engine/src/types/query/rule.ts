import type { AllenMask } from "#compiler/allen/mask.ts"
import type { Built, phantom, Phantom } from "#compiler/core/phantom.ts"
import type { AvgSql, NumericSql, PlainHost, SumSql } from "#compiler/scalar/compute/tables.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type {
	FirstOrigin,
	FirstTerm,
	IsSpan,
	Operand,
	Requires
} from "#compiler/types/compute/scalar.ts"

import type {
	Carriers,
	ComputedOrigin,
	Invariant,
	Literal,
	LiteralOrigin,
	OperandOrigin,
	ParamOrigin,
	ParamsContribution,
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
	PositionsOf,
	Proofs,
	ReflexiveProof,
	Shaped,
	SoleMatch,
	SourceName
} from "#compiler/types/evidence/evidence.ts"
import type { Field, FieldBase, LiteralOf, Span } from "#compiler/types/fields/field.ts"
import type { BoundSource, ContextsOf, Finished } from "#compiler/types/query/query.ts"
import type {
	Aggregate,
	BindingParams,
	Bindings,
	HeadOrigins,
	HeadParams,
	HeadShape,
	NoExcess,
	ParamSource,
	Producer,
	ResultOf
} from "#compiler/types/query/terms.ts"
import type { AnyClosed, AnyRelation, HeadingOf, NameOf } from "#compiler/types/schema/relation.ts"
import type { IsLevelOf, IsRelationOf } from "#compiler/types/schema/schema.ts"
import type { AnyContext, AnyWorld } from "#compiler/types/schema/world.ts"

type T<A> = TypeOfTerm<A>
type P<A> = ParamsOfTerm<A>
/** A predicate's origin: a computation over its operands, terms or predicates. */
type Reads<Os extends ReadonlyArray<unknown>> = ComputedOrigin<OperandOrigin<Os[number]>>

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
 * (../evidence/evidence.ts): every occurrence it matched, in order; the binding position of each variable with an
 * origin, `<origin>@<source>.<field>`; the names of the sources it matched and whether one repeats; what its filters
 * state (evidence/evidence.ts Stating): a variable compared with r.eq against a value fixed per binding is fixed, two
 * variables compared are equal; and its filters in order, or UnknownFilters once a where spreads an array of unknown
 * length.
 */
interface RuleFacts<
	Occurrences extends ReadonlyArray<unknown>,
	Positions extends string,
	Names extends string,
	Repeated extends boolean,
	Stated,
	Filters = readonly []
> {
	readonly occurrences: Occurrences
	readonly positions: Positions
	readonly names: Names
	readonly repeated: Repeated
	readonly stated: Stated
	readonly filters: Filters
}

interface UnknownFilters {
	readonly unknownFilters: true
}
export type NoFacts = RuleFacts<readonly [], never, never, false, never>
type AfterMatch<F, R, B> =
	F extends RuleFacts<
		infer O extends ReadonlyArray<unknown>,
		infer Po extends string,
		infer N extends string,
		infer Re extends boolean,
		infer St,
		infer Fl
	>
		? RuleFacts<
				readonly [...O, SoleMatch<R, B>],
				Po | PositionsOf<R, B>,
				N | SourceName<R>,
				Re extends true ? true : SourceName<R> extends N ? true : false,
				St,
				Fl
			>
		: never

type AfterWhere<F, Ps> =
	F extends RuleFacts<
		infer O extends ReadonlyArray<unknown>,
		infer Po extends string,
		infer N extends string,
		infer Re extends boolean,
		infer St,
		infer Fl
	>
		? RuleFacts<O, Po, N, Re, St | StatesOf<Ps>, FiltersAfter<Fl, Ps>>
		: never

type FiltersAfter<Fl, Ps> =
	Fl extends ReadonlyArray<unknown>
		? Ps extends readonly [] | readonly [unknown, ...ReadonlyArray<unknown>]
			? number extends Ps["length"]
				? UnknownFilters
				: readonly [...Fl, ...Ps]
			: UnknownFilters
		: UnknownFilters

/**
 * What the rule's filters state of its variables by origin: under R1 of the one variable of each origin, in a rule that
 * matches no source twice.
 */
type StatedAt<F> = F extends {
	readonly repeated: infer Re extends boolean
	readonly stated: infer St
}
	? Re extends true
		? never
		: St
	: never
type OccurrencesOf<F> = F extends { readonly occurrences: infer O } ? O : readonly []
type PositionsAt<F> = F extends { readonly positions: infer Po extends string } ? Po : never
type RepeatedAt<F> = F extends { readonly repeated: infer Re extends boolean } ? Re : true
type FiltersAt<F> = F extends { readonly filters: infer Fl } ? Fl : UnknownFilters
/** What the rule's clauses prove of a head H (../evidence/evidence.ts Proofs). */
type ProofsAt<S, Sole, F, H> = Proofs<
	ContainmentProof<S, Sole, H>,
	ReflexiveProof<OccurrencesOf<F>, FiltersAt<F>, H>,
	ArmProofOf<S, Sole, H>
>

/** What may stand opposite a span term: a span term of exactly its type, a span parameter among them. */
type SpanOperand<Sp> = Term<Sp>

/** A scalar parameter of a descriptor's host type H and SQL type Sql: an input term the caller binds by name. */
type ParamTerm<Name extends string, H, Sql extends SqlTag> = Term<
	H,
	{ readonly [K in Name]: H },
	ParamOrigin,
	Sql
>

/** What r.relation takes as a heading: a heading of fields C, or a relation, whose heading C is. */
export type RelationHeading<C> = C | { readonly kind: "relation"; readonly heading: C }

/**
 * The SQL types min and max are defined over: the numeric family and money, booleans (bool_and and bool_or), text and
 * enums (min(anyenum)).
 */
type MinMaxSql = NumericSql | "boolean" | "text" | "enum"

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
	match<R extends Matchable, const B extends Partial<Bindings<HeadingOf<R>>>>(
		source: R & MatchCheck<S, R>,
		bindings: B & NoExcess<B, HeadingOf<R>>
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
	find<const H extends HeadShape>(
		head: H
	): Finished<
		ResultOf<H>,
		EvidenceOf<
			H,
			HeadKeys<S, OccurrencesOf<Facts>, H, RepeatedAt<Facts>, StatedAt<Facts>>,
			HeadValues<H, StatedAt<Facts>>,
			HeadOrigins<H, PositionsAt<Facts>, RepeatedAt<Facts>>,
			ProofsAt<S, Sole, Facts, H>
		>,
		Simplify<Params & HeadParams<H>>,
		S,
		ResultOf<H>,
		H,
		Cx
	>
	/** A stage over the rule's own schema, so it carries S like the query it is part of. */
	interior<Head, Ev extends Evidence, P2, IHead, Hc extends Carriers, Cx2>(
		rule: (r: Rule<S>) => Finished<Head, Ev, P2, S, IHead, Hc, Cx2>
	): BoundSource<S, Head, P2, Hc, Cx2>

	/** A scalar parameter of the descriptor's host type, which the caller binds by name. */
	param<const Name extends string, H, Sql extends SqlTag>(
		name: Name,
		type: Field<H, Sql>
	): ParamTerm<Name, H, Sql>
	/** A relation-valued parameter over a heading of fields, or over a relation, whose heading it takes. */
	relation<const Name extends string, C extends Record<string, FieldBase>>(
		name: Name,
		heading: RelationHeading<C>
	): ParamSource<Name, C>
	/**
	 * A literal a head holds, typically a discriminant: a term of the value's own literal type. The checker types it by
	 * the field it writes, else by the type its union's term-typed arms agree on when that type admits it, else by its
	 * value's JavaScript default; X.handle(member) is a roster's typed handle.
	 */
	literal<const X extends Literal>(value: X): Term<X, unknown, LiteralOrigin>

	/**
	 * An equality between a variable and a value fixed per binding fixes the variable, and one between two variables
	 * makes each determine the other (EqualityStates): a key bound to a fixed variable pins its occurrence, and a group
	 * term holding it is one group per binding. A literal operand keeps its own type, the value it fixes the variable
	 * to, which a union compares across its arms (evidence/evidence.ts UnionEvidence).
	 * Every predicate records its shape for the reflexive proof (../evidence/evidence.ts Shaped).
	 */
	eq<A extends TermBase, const B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"eq", A, B> & Stating<EqualityStates<A, B>>
	ne<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"ne", A, B>
	lt<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"lt", A, B>
	le<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"le", A, B>
	gt<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"gt", A, B>
	ge<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<"ge", A, B>
	between<
		A extends TermBase,
		L extends Operand<T<A>, SqlOfTerm<A>>,
		H extends Operand<T<A>, SqlOfTerm<A>>
	>(
		a: A & FirstTerm<A>,
		low: L,
		high: H
	): Predicate<P<A> & P<L> & P<H>, Reads<readonly [A, L, H]>> & Shaped<Opaque<readonly [A, L, H]>>
	inSet<A extends TermBase>(
		a: A & FirstTerm<A>,
		values: ReadonlyArray<LiteralOf<T<A>>>
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
	not<R extends Matchable, const B extends Partial<Bindings<HeadingOf<R>>>>(
		relation: R & MatchCheck<S, R>,
		bindings: B & NoExcess<B, HeadingOf<R>>
	): Predicate<SourceParamsOf<R> & BindingParams<B>> &
		Shaped<Negation> &
		ReadsContexts<SourceContexts<R>>

	/**
	 * The second span may be a parameter of the first span's type: a window is a span parameter.
	 * A mask is any union of ALLEN's members: a bitwise OR of two masks is a number, and `ALLEN.after | ALLEN.metBy`
	 * is a valid mask, so the compiler, not the brand, checks the thirteen-bit range.
	 */
	allen<A extends TermBase, B extends SpanOperand<T<A>>>(
		left: A & Requires<IsSpan<A>, "a span term is required"> & FirstTerm<A>,
		mask: AllenMask | number,
		right: B
	): Predicate<P<A> & P<B>, Reads<readonly [A, B]>> & Shaped<Opaque<readonly [A, B]>>
	/** `s @> t`; the span may be a parameter of the point's span type. */
	pointIn<Pt extends TermBase, Sp extends SpanOperand<Span<T<Pt>>>>(
		point: Pt & FirstTerm<Pt>,
		span: Sp
	): Predicate<P<Pt> & P<Sp>, Reads<readonly [Pt, Sp]>> & Shaped<Opaque<readonly [Pt, Sp]>>
	/** Zero or one fact, of the left span's type. */
	intersection<X, PA, OA, B extends SpanOperand<X>>(
		left: Term<X, PA, OA, "range"> & FirstOrigin<OA>,
		right: B
	): Producer<X, PA & P<B>>
	/** Zero, one, or two facts, of the left span's type. */
	difference<X, PA, OA, B extends SpanOperand<X>>(
		left: Term<X, PA, OA, "range"> & FirstOrigin<OA>,
		right: B
	): Producer<X, PA & P<B>>
	/** Maximal covered segments. */
	pack<X, PA, OA>(spans: Term<X, PA, OA, "range"> & FirstOrigin<OA>): Producer<X, PA>

	/**
	 * count is bigint; sum and mean take PostgreSQL's result type over their argument's SQL type
	 * (scalar/compute/tables.ts).
	 */
	count(): Aggregate<bigint, unknown, "bigint">
	sum<X, PA, OA, S extends NumericSql>(
		term: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Aggregate<PlainHost[SumSql[S]], PA, SumSql[S]>
	mean<X, PA, OA, S extends keyof AvgSql>(
		term: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Aggregate<PlainHost[AvgSql[S]], PA, AvgSql[S]>
	/** min and max return an input unchanged, so they keep a contract. */
	min<X, PA, OA, S extends MinMaxSql>(
		term: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Aggregate<X, PA, S>
	max<X, PA, OA, S extends MinMaxSql>(
		term: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Aggregate<X, PA, S>
}
