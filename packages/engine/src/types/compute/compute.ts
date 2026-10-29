import type {
	EndpointSql,
	IntegralSql,
	NumericSql,
	PlainHost,
	PlainSql,
	PowerSql,
	QuotientSql,
	SignedSql
} from "#compiler/scalar/compute/tables.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type {
	CastAdmitted,
	FirstOrigin,
	FirstTerm,
	Operand,
	Requires,
	Scalar
} from "#compiler/types/compute/scalar.ts"

import type {
	ComputedOrigin,
	InputOrigin,
	OperandOrigin,
	ParamsOfEach,
	ParamsOfTerm,
	Predicate,
	PredicateBase,
	SqlOfTerm,
	Term,
	TermBase,
	TypeOfTerm
} from "#compiler/types/core/phantom.ts"
import type { EqualityStates, StatesOf, Stating } from "#compiler/types/evidence/evidence.ts"
import type { Field, LiteralOf, Span } from "#compiler/types/fields/field.ts"

type T<A> = TypeOfTerm<A>
type P<A> = ParamsOfTerm<A>
type O<A> = OperandOrigin<A>
/** A comparison of two operands: their parameters, and their reads as its origin. */
type Compared<A, B> = Predicate<P<A> & P<B>, ComputedOrigin<O<A> | O<B>>>

/**
 * The Compute catalogue: PostgreSQL's scalar operators, functions and casts. `Compute` is the runtime catalogue of
 * packages/engine/src/scalar/compute, bound to its public signature ComputeApi by the public barrel public/compute.ts.
 *
 * Every method threads the parameter maps of its operands into its result, and types its result as PostgreSQL's
 * overload does, over its operand's SQL type, the term's `sql`: arithmetic keeps the operand's SQL type without its
 * contract, so arithmetic over a contract is never the contract, and money / money is double precision. A result that
 * is no operand's own value is read off a table keyed by that SQL type (scalar/compute/tables.ts), so its column is the
 * table's plain column; LEAST, GREATEST, a conditional, a cast, a literal and a span's endpoints take the column of the
 * operand or descriptor they return the value of, contract included.
 *
 * Every result's origin, a term's or a predicate's, is a computation over its operands' origins (ComputedOrigin), so a
 * computed head term is determined wherever the variables they read are, as the engine reads a computed output
 * (evidence/evidence.ts Needs): a head of computations over a pinned match is at most one row per binding, a
 * conditional over a comparison included.
 *
 * The operand families are constraints on the operand's SQL type, so a type error points at the mistaken operand:
 * arithmetic over booleans, text, uuids, enums, spans and vectors; money products, remainders, negations and absolute
 * values; % over a float; power and sqrt over an integer type. The first operand of an operation is a term, never a
 * parameter or a head literal (FirstOrigin): the checker types those from the term they meet.
 *
 * test/unit/compute pins the runtime behavior each signature promises, test/types/compute and test/types/skeleton the
 * signatures.
 */
export interface ComputeApi {
	literal<H, S extends SqlTag>(
		type: Field<H, S>,
		value: LiteralOf<H>
	): Term<H, unknown, InputOrigin, S>
	/** Drops a contract to its base explicitly: the plain value of its SQL type. */
	base<X, PA, OA, S extends PlainSql>(
		x: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S>
	/**
	 * Re-enters a contract, or converts, through a cast PostgreSQL checks; a violation is a typed execution failure.
	 * The numeric family and money convert among themselves where PostgreSQL has a cast; any other base
	 * casts only into a contract or refinement over itself.
	 */
	cast<X, PA, OA, S extends SqlTag, H, F extends SqlTag>(
		x: Term<X, PA, OA, S> &
			Requires<
				CastAdmitted<X, S, H, F>,
				"PostgreSQL has no cast between these types that Compute admits"
			> &
			FirstOrigin<OA>,
		to: Field<H, F>
	): Term<H, PA, ComputedOrigin<OA>, F>

	/** Arithmetic on contract values yields the base type. */
	add<X, PA, OA, S extends NumericSql, B extends Operand<X, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	sub<X, PA, OA, S extends NumericSql, B extends Operand<X, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	/** Money has no product. */
	mul<X, PA, OA, S extends SignedSql, B extends Operand<X, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	/** money / money is double precision. */
	div<X, PA, OA, S extends NumericSql, B extends Operand<X, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[QuotientSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, QuotientSql[S]>
	/** PostgreSQL has no float or money %. */
	mod<X, PA, OA, S extends IntegralSql, B extends Operand<X, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	neg<X, PA, OA, S extends SignedSql>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S>
	quot<X, PA, OA, B extends Operand<X, "numeric">>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>,
		b: B
	): Term<Decimal, PA & P<B>, ComputedOrigin<OA | O<B>>, "numeric">
	rem<X, PA, OA, B extends Operand<X, "numeric">>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>,
		b: B
	): Term<Decimal, PA & P<B>, ComputedOrigin<OA | O<B>>, "numeric">
	abs<X, PA, OA, S extends SignedSql>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S>
	/** sign returns the operand's type, composed over the integer types and real (scalar/compute/registry.ts). */
	sign<X, PA, OA, S extends SignedSql>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S>
	/** round, trunc, ceil, and floor are numeric only; there is no exp, ln, or log. */
	round<X, PA, OA>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>,
		scale?: number
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	trunc<X, PA, OA>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>,
		scale?: number
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	ceil<X, PA, OA>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	floor<X, PA, OA>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	/** Integer and numeric; over smallint they are the integer forms cast back. */
	gcd<X, PA, OA, S extends IntegralSql, B extends Term<X, unknown, unknown, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	lcm<X, PA, OA, S extends IntegralSql, B extends Term<X, unknown, unknown, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	/** Numeric and double precision. */
	power<X, PA, OA, S extends PowerSql, B extends Operand<X, S>>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	sqrt<X, PA, OA, S extends PowerSql>(
		a: Term<X, PA, OA, S> & FirstOrigin<OA>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S>
	/**
	 * LEAST and GREATEST return an operand unchanged, so they keep the first operand's type, contract included; every
	 * other operand is a term of that exact type.
	 */
	least<X, PA, OA, S extends SqlTag, const Bs extends ReadonlyArray<Term<X, unknown, unknown, S>>>(
		first: Term<X, PA, OA, S> & FirstOrigin<OA>,
		...rest: Bs
	): Term<X, PA & ParamsOfEach<Bs>, ComputedOrigin<OA | O<Bs[number]>>, S>
	greatest<
		X,
		PA,
		OA,
		S extends SqlTag,
		const Bs extends ReadonlyArray<Term<X, unknown, unknown, S>>
	>(
		first: Term<X, PA, OA, S> & FirstOrigin<OA>,
		...rest: Bs
	): Term<X, PA & ParamsOfEach<Bs>, ComputedOrigin<OA | O<Bs[number]>>, S>
	widthBucket<XX, PX, OX, XL, PL, OL, XH, PH, OH, C extends Term<number>>(
		x: Term<XX, PX, OX, "numeric"> & FirstOrigin<OX>,
		low: Term<XL, PL, OL, "numeric"> & FirstOrigin<OL>,
		high: Term<XH, PH, OH, "numeric"> & FirstOrigin<OH>,
		count: C
	): Term<number, PX & PL & PH & P<C>, ComputedOrigin<OX | OL | OH | O<C>>, "integer">
	scale<X, PA, OA>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>
	): Term<number, PA, ComputedOrigin<OA>, "integer">
	minScale<X, PA, OA>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>
	): Term<number, PA, ComputedOrigin<OA>, "integer">
	trimScale<X, PA, OA>(
		a: Term<X, PA, OA, "numeric"> & FirstOrigin<OA>
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">

	/**
	 * The first branch, a term and never a parameter, types the conditional, contract included; the other is a term of
	 * its type (a parameter among them) or a literal of it. A boolean field is a predicate here, so
	 * r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0)) is a conditional count.
	 */
	cond<
		C extends PredicateBase | Term<boolean>,
		X,
		PT,
		OT,
		S extends SqlTag,
		Otherwise extends Operand<X, S>
	>(
		p: C & FirstTerm<C>,
		then: Term<X, PT, OT, S> & FirstOrigin<OT>,
		otherwise: Otherwise
	): Term<X, P<C> & PT & P<Otherwise>, ComputedOrigin<O<C> | OT | O<Otherwise>>, S>
	not<Q extends PredicateBase>(p: Q): Predicate<P<Q>, ComputedOrigin<O<Q>>>
	/** A conjunction states what each conjunct states, as the rule's does; a disjunction states nothing. */
	and<const Qs extends ReadonlyArray<PredicateBase>>(
		...ps: Qs
	): Predicate<ParamsOfEach<Qs>, ComputedOrigin<O<Qs[number]>>> & Stating<StatesOf<Qs>>
	or<const Qs extends ReadonlyArray<PredicateBase>>(
		...ps: Qs
	): Predicate<ParamsOfEach<Qs>, ComputedOrigin<O<Qs[number]>>>
	/**
	 * In a rule's where, an equality between a variable and a value fixed per binding fixes the variable, and one between
	 * two variables makes each determine the other, as r.eq's do (evidence/evidence.ts EqualityStates).
	 */
	eq<A extends TermBase, const B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B> & Stating<EqualityStates<A, B>>
	ne<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	lt<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	le<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	gt<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	ge<A extends TermBase, B extends Operand<T<A>, SqlOfTerm<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	between<
		A extends TermBase,
		L extends Operand<T<A>, SqlOfTerm<A>>,
		H extends Operand<T<A>, SqlOfTerm<A>>
	>(
		a: A & FirstTerm<A>,
		low: L,
		high: H
	): Predicate<P<A> & P<L> & P<H>, ComputedOrigin<O<A> | O<L> | O<H>>>
	in<A extends TermBase>(
		a: A & FirstTerm<A>,
		values: ReadonlyArray<LiteralOf<T<A>>>
	): Predicate<P<A>, ComputedOrigin<O<A>>>

	/**
	 * A span's endpoints, of its endpoint descriptor's type, contract included, and its width, the plain value of the
	 * endpoint's SQL type: the endpoint descriptor states what a span term's type alone cannot carry, and must be the
	 * span's own.
	 */
	lower<E, PA, OA, ES extends EndpointSql>(
		s: Term<Span<E>, PA, OA, "range"> & FirstOrigin<OA>,
		endpoint: Field<E, ES>
	): Term<E, PA, ComputedOrigin<OA>, ES>
	upper<E, PA, OA, ES extends EndpointSql>(
		s: Term<Span<E>, PA, OA, "range"> & FirstOrigin<OA>,
		endpoint: Field<E, ES>
	): Term<E, PA, ComputedOrigin<OA>, ES>
	width<E, PA, OA, ES extends EndpointSql>(
		s: Term<Span<E>, PA, OA, "range"> & FirstOrigin<OA>,
		endpoint: Field<E, ES>
	): Term<PlainHost[ES], PA, ComputedOrigin<OA>, ES>

	/** char_length; admitted only in contract predicates and row checks, never in a query. */
	charLength<X, PA, OA>(
		s: Term<X, PA, OA, "text"> & FirstOrigin<OA>
	): Scalar<number, PA, ComputedOrigin<OA>, "integer">

	/**
	 * double precision in [0, 2]; schema-qualified cosine_distance(a, b), never the <=> operator. The second operand is
	 * a vector term of the first's dimensions or a literal vector, which takes the first operand's type.
	 */
	cosineDistance<X, PA, OA, B extends Operand<X, "vector">>(
		a: Term<X, PA, OA, "vector"> & FirstOrigin<OA>,
		b: B
	): Term<number, PA & P<B>, ComputedOrigin<OA | O<B>>, "double precision">
}

/** The comparison and boolean helpers a row check sees beside its fields. */
export type ScalarHelpers = Pick<
	ComputeApi,
	"eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in" | "and" | "or" | "not" | "charLength"
>
