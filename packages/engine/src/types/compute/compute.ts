import type { Proving } from "#compiler/core/phantom.ts"
import type {
	ArithmeticSql,
	DivisorSql,
	EndpointSql,
	InexactSql,
	IntegralSql,
	NumericSql,
	PlainHost,
	PlainSql,
	PowerSql,
	QuotientSql,
	RemainderSql,
	SignedSql
} from "#compiler/scalar/compute/tables.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type {
	CastAdmitted,
	FirstOrigin,
	FirstTerm,
	FirstValue,
	Guard,
	Holds,
	Literal,
	Operand,
	Proves,
	Requires,
	Scalar,
	WithinFacts
} from "#compiler/types/compute/scalar.ts"

import type {
	ComputedOrigin,
	ConstantOrigin,
	Facts,
	InputTerm,
	LanguageOf,
	Meets,
	OperandOrigin,
	ParamsOfEach,
	ParamsOfTerm,
	Predicate,
	PredicateBase,
	SqlOfTerm,
	Term,
	TermBase,
	TypeOfTerm,
	ValueOfTerm
} from "#compiler/types/core/phantom.ts"
import type { EqualityStates, StatesOf, Stating } from "#compiler/types/evidence/evidence.ts"
import type { Field, LiteralOf, NotRoster } from "#compiler/types/fields/field.ts"

/** A divisor's requirement: proved nonzero, except a float's, whose quotient by zero IEEE 754 defines. */
type Divisor<S extends SqlTag, B> = [S] extends ["real" | "double precision"]
	? unknown
	: Requires<
			Proves<B, "nonzero">,
			"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)"
		>

/**
 * A first operand a partial operation needs finite, of facts FX and value type LV (Holds): numeric's and a float's must
 * be proved so; an integer's, money's and an exact value's are by their types.
 */
type Finite<S extends SqlTag, FX extends Facts, LV> = Requires<
	[S] extends [InexactSql] ? Holds<FX, LV, "finite"> : true,
	"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)"
>

/** A narrowing cast's requirement: from numeric or a float into an integer or money, the value proved finite. */
type FiniteCast<S extends SqlTag, F extends SqlTag, FX extends Facts, LV> = [F] extends [
	"smallint" | "integer" | "bigint" | "money"
]
	? Finite<S, FX, LV>
	: unknown

/**
 * The facts a cast keeps of its operand's, as compilation keeps them (lower.ts keptFacts): none into a float; every
 * one from an integer, money or an exact value, finite among them by the operand's type; and the others but nonzero
 * from numeric or a float, whose rounding at a typmod no SQL type tells apart may reach zero.
 */
type CastFacts<S extends SqlTag, F extends SqlTag, FX extends Facts> = [F] extends [
	"real" | "double precision"
]
	? Facts
	: [S] extends ["smallint" | "integer" | "bigint" | "exact integer" | "money" | "exact money"]
		? FX & { readonly finite: true }
		: Omit<FX, "nonzero"> & Facts

/** A power's requirement on its base, of facts FA and value type LA, and exponent B (see power). */
type PowerBase<FA extends Facts, LA, B> = Requires<
	Holds<FA, LA, "nonnegative"> extends true
		? Holds<FA, LA, "nonzero"> extends true
			? true
			: Proves<B, "nonnegative">
		: false,
	"a power's base proved nonnegative, and nonzero or its exponent nonnegative: guard it with Compute.when(Compute.positive(x), (x) => …, otherwise)"
>

/** What a guard proves of its subject: the subject term, its facts with the guard's. */
type GuardOver<X, PA, OA, S extends SqlTag, V, FA extends Facts, L, G> = Guard<
	Term<X, PA, OA, S, V, FA & G, L>,
	PA,
	ComputedOrigin<OA>
>

type T<A> = TypeOfTerm<A>
type P<A> = ParamsOfTerm<A>
type O<A> = OperandOrigin<A>
/** The values an operand delivers: a term's column's, a JavaScript value's own. */
type ValuesOf<A> = A extends TermBase ? ValueOfTerm<A> : A
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
 * parameter or a JavaScript value (FirstTerm): the checker types those from the term they meet. Each first operand
 * admits a JavaScript value beside its terms only to refuse it by that name.
 *
 * test/unit/compute pins the runtime behavior each signature promises, test/types/compute and test/types/skeleton the
 * signatures.
 */
export interface ComputeApi {
	/**
	 * A constant of a descriptor's type, of its whole host type: a typed constant, which stands wherever a term of that
	 * type stands, first included. Its value is a JavaScript value of the descriptor's language, its host type: a
	 * refined text's pattern's, uuid_out's spelling. Its value is the one approximation its type keeps: its column
	 * delivers the host type, never x alone. A roster's member is X.handle(member), whose column delivers the member.
	 */
	literal<H, S extends SqlTag, D, F extends Facts, const V extends LiteralOf<H>>(
		type: Field<H, S, D, F> & NotRoster,
		value: V
	): Term<D, unknown, ConstantOrigin, S, H, F> & Literal<V>
	/** Drops a contract to its base explicitly: the plain value of its SQL type, with every fact it states. */
	base<A extends TermBase | FirstValue, X, PA, OA, S extends PlainSql, FX extends Facts>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, S> & Proving<FX>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S, PlainHost[S], FX>
	/**
	 * Re-enters a contract, or converts, through a cast PostgreSQL checks; a violation is a typed execution failure.
	 * The numeric family and money convert among themselves where PostgreSQL has a cast; any other base
	 * casts only into a contract or refinement over itself: its domain D over the same base. The result is of the
	 * target's domain, and delivers its values H, its language.
	 */
	cast<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends SqlTag,
		H,
		F extends SqlTag,
		D,
		FX extends Facts,
		LX
	>(
		x: A &
			FirstTerm<A> &
			InputTerm<X, PA, OA, S> &
			Proving<FX> &
			Literal<LX> &
			Requires<
				CastAdmitted<X, S, D, F>,
				"PostgreSQL has no cast between these types that Compute admits"
			> &
			FiniteCast<S, F, FX, LX>,
		to: Field<H, F, D>
	): Term<D, PA, ComputedOrigin<OA>, F, H, CastFacts<S, F, FX>>

	/**
	 * Arithmetic on contract values yields the base type. Integer and money arithmetic is exact: an exact integer,
	 * delivered as bigint, and exact money, which never overflow; float arithmetic is IEEE 754.
	 */
	add<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, B extends Operand<X, S>>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>,
		b: B
	): Term<PlainHost[ArithmeticSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, ArithmeticSql[S]>
	sub<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, B extends Operand<X, S>>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>,
		b: B
	): Term<PlainHost[ArithmeticSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, ArithmeticSql[S]>
	/** Money has no product. */
	mul<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql, B extends Operand<X, S>>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>,
		b: B
	): Term<PlainHost[ArithmeticSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, ArithmeticSql[S]>
	/**
	 * Integer division truncates over the exact integers; money / money is double precision. The divisor is proved
	 * nonzero, except a float's, whose quotient by zero IEEE 754 defines (±Infinity, or NaN over zero).
	 */
	div<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends NumericSql,
		const B extends Operand<X, S>
	>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>,
		b: B & Divisor<S, B>
	): Term<PlainHost[QuotientSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, QuotientSql[S]>
	/** PostgreSQL has no float or money %; the divisor is proved nonzero. */
	mod<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends IntegralSql,
		const B extends Operand<X, S>
	>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>,
		b: B & Divisor<S, B>
	): Term<PlainHost[RemainderSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, RemainderSql[S]>
	neg<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): Term<PlainHost[ArithmeticSql[S]], PA, ComputedOrigin<OA>, ArithmeticSql[S]>
	quot<A extends TermBase | FirstValue, X, PA, OA, const B extends Operand<X, "numeric">>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">,
		b: B & Divisor<"numeric", B>
	): Term<Decimal, PA & P<B>, ComputedOrigin<OA | O<B>>, "numeric">
	rem<A extends TermBase | FirstValue, X, PA, OA, const B extends Operand<X, "numeric">>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">,
		b: B & Divisor<"numeric", B>
	): Term<Decimal, PA & P<B>, ComputedOrigin<OA | O<B>>, "numeric">
	abs<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): Term<PlainHost[ArithmeticSql[S]], PA, ComputedOrigin<OA>, ArithmeticSql[S]>
	/** sign returns the operand's type, composed over the integer types and real (scalar/compute/registry.ts). */
	sign<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S>
	/** round, trunc, ceil, and floor are numeric only; there is no exp, ln, or log. */
	round<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">,
		scale?: number
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	trunc<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">,
		scale?: number
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	ceil<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	floor<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">
	): Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	/** Integer and numeric; over smallint they are the integer forms cast back. */
	gcd<A extends TermBase | FirstValue, X, PA, OA, S extends IntegralSql, B extends Meets<X, S>>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>,
		b: B
	): Term<PlainHost[DivisorSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, DivisorSql[S]>
	lcm<A extends TermBase | FirstValue, X, PA, OA, S extends IntegralSql, B extends Meets<X, S>>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>,
		b: B
	): Term<PlainHost[DivisorSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, DivisorSql[S]>
	/**
	 * Numeric and double precision. The base is proved nonnegative, and nonzero or the exponent nonnegative; that the
	 * result stays in range rests on the operands' magnitudes, which compilation proves or refuses as PartialOperation.
	 */
	power<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends PowerSql,
		FA extends Facts,
		LA,
		const B extends Operand<X, S>
	>(
		a: A &
			FirstTerm<A> &
			InputTerm<X, PA, OA, S> &
			Proving<FA> &
			Literal<LA> &
			PowerBase<FA, LA, B>,
		b: B
	): Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	/** Numeric's radicand is proved nonnegative; double precision's is IEEE 754's, NaN below zero. */
	sqrt<A extends TermBase | FirstValue, X, PA, OA, S extends PowerSql, FA extends Facts, LA>(
		a: A &
			FirstTerm<A> &
			InputTerm<X, PA, OA, S> &
			Proving<FA> &
			Literal<LA> &
			Requires<
				[S] extends ["numeric"] ? Holds<FA, LA, "nonnegative"> : true,
				"a radicand proved nonnegative: guard it with Compute.when(Compute.nonnegative(x), (x) => …, otherwise)"
			>
	): Term<PlainHost[S], PA, ComputedOrigin<OA>, S>
	/**
	 * LEAST and GREATEST return an operand unchanged, so they keep the first operand's type, contract and roster
	 * included, and deliver any operand's values; every other operand is a term that meets that type.
	 */
	least<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends SqlTag,
		V,
		L,
		const Bs extends ReadonlyArray<Meets<X, S>>
	>(
		first: A & FirstTerm<A> & Term<X, PA, OA, S, V, Facts, L>,
		...rest: Bs
	): Term<
		X,
		PA & ParamsOfEach<Bs>,
		ComputedOrigin<OA | O<Bs[number]>>,
		S,
		V | ValueOfTerm<Bs[number]>,
		Facts,
		L
	>
	greatest<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends SqlTag,
		V,
		L,
		const Bs extends ReadonlyArray<Meets<X, S>>
	>(
		first: A & FirstTerm<A> & Term<X, PA, OA, S, V, Facts, L>,
		...rest: Bs
	): Term<
		X,
		PA & ParamsOfEach<Bs>,
		ComputedOrigin<OA | O<Bs[number]>>,
		S,
		V | ValueOfTerm<Bs[number]>,
		Facts,
		L
	>
	/**
	 * The operand and the bounds are proved finite; that the bounds differ and the count lies in 1..2147483646 rests on
	 * their magnitudes, which compilation proves or refuses as PartialOperation.
	 */
	widthBucket<
		AX extends TermBase | FirstValue,
		XX,
		PX,
		OX,
		FXX extends Facts,
		LXX,
		AL extends TermBase | FirstValue,
		XL,
		PL,
		OL,
		FXL extends Facts,
		LXL,
		AH extends TermBase | FirstValue,
		XH,
		PH,
		OH,
		FXH extends Facts,
		LXH,
		C extends Meets<number, SqlTag>
	>(
		x: AX &
			FirstTerm<AX> &
			InputTerm<XX, PX, OX, "numeric"> &
			Proving<FXX> &
			Literal<LXX> &
			Finite<"numeric", FXX, LXX>,
		low: AL &
			FirstTerm<AL> &
			InputTerm<XL, PL, OL, "numeric"> &
			Proving<FXL> &
			Literal<LXL> &
			Finite<"numeric", FXL, LXL>,
		high: AH &
			FirstTerm<AH> &
			InputTerm<XH, PH, OH, "numeric"> &
			Proving<FXH> &
			Literal<LXH> &
			Finite<"numeric", FXH, LXH>,
		count: C
	): Term<number, PX & PL & PH & P<C>, ComputedOrigin<OX | OL | OH | O<C>>, "integer">
	/** min_scale of a value proved finite. */
	minScale<A extends TermBase | FirstValue, X, PA, OA, FA extends Facts, LA>(
		a: A &
			FirstTerm<A> &
			InputTerm<X, PA, OA, "numeric"> &
			Proving<FA> &
			Literal<LA> &
			Finite<"numeric", FA, LA>
	): Term<number, PA, ComputedOrigin<OA>, "integer">

	/**
	 * The first branch, a term and never a parameter or a JavaScript value (FirstTerm), types the conditional, contract
	 * and roster included; the other is a term that meets its type (a parameter among them) or a literal of it, and the
	 * conditional delivers either's values. A boolean field is a predicate here, so
	 * r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0)) is a conditional count.
	 */
	cond<
		C extends PredicateBase | Meets<boolean, "boolean">,
		A extends TermBase | FirstValue,
		X,
		PT,
		OT,
		S extends SqlTag,
		V,
		L,
		Otherwise extends Operand<X, S, L>
	>(
		p: C & FirstTerm<C>,
		then: A & FirstTerm<A> & Term<X, PT, OT, S, V, Facts, L>,
		otherwise: Otherwise
	): Term<
		X,
		P<C> & PT & P<Otherwise>,
		ComputedOrigin<O<C> | OT | O<Otherwise>>,
		S,
		V | ValuesOf<Otherwise>,
		Facts,
		L
	>
	/**
	 * The one guard of a partial operation: CASE WHEN <guard> THEN <branch> ELSE <otherwise> END. The branch is a
	 * function of the guard's subject, which it receives with the guard's facts proved, so a partial operation over it
	 * type-checks inside the branch and nowhere else; the otherwise branch, a term that meets the branch's type or a
	 * literal of it, is the caller's value where the guard fails: Compute.when(Compute.nonzero(b), (b) => Compute.div(a,
	 * b), 0n).
	 */
	when<
		G extends TermBase,
		PG,
		OG,
		X,
		PT,
		OT,
		S extends SqlTag,
		V,
		L,
		Otherwise extends Operand<X, S, L>
	>(
		guard: Guard<G, PG, OG>,
		then: (subject: G) => Term<X, PT, OT, S, V, Facts, L> & FirstOrigin<OT>,
		otherwise: Otherwise
	): Term<
		X,
		PG & PT & P<Otherwise>,
		ComputedOrigin<OG | OT | O<Otherwise>>,
		S,
		V | ValuesOf<Otherwise>,
		Facts,
		L
	>
	/** A guard that its subject, a numeric-family term, is nonzero: `x <> 0`. */
	nonzero<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, V, FA extends Facts, L>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L>
	): GuardOver<X, PA, OA, S, V, FA, L, { readonly nonzero: true }>
	/** A guard that its subject is nonnegative: `x >= 0`. */
	nonnegative<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends NumericSql,
		V,
		FA extends Facts,
		L
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L>
	): GuardOver<X, PA, OA, S, V, FA, L, { readonly nonnegative: true }>
	/** A guard that its subject is positive, so nonzero and nonnegative: `x > 0`. */
	positive<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends NumericSql,
		V,
		FA extends Facts,
		L
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L>
	): GuardOver<X, PA, OA, S, V, FA, L, { readonly nonzero: true; readonly nonnegative: true }>
	/** A guard that its subject, numeric or a float, is finite: `x > -Infinity AND x < Infinity`. */
	isFinite<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends InexactSql,
		V,
		FA extends Facts,
		L
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L>
	): GuardOver<X, PA, OA, S, V, FA, L, { readonly finite: true }>
	/**
	 * A guard that its subject lies within two finite literal bounds: `x BETWEEN low AND high`. It proves the subject
	 * finite, nonnegative from a low bound at or above zero, and nonzero from bounds on one side of zero (WithinFacts);
	 * compilation reads the bounds too, for the preconditions that rest on magnitudes (a narrowing's range, a power's, a
	 * bucket's): Compute.when(Compute.within(x, 0n, 1000n), (x) => Compute.power(x, 2n), 0n).
	 */
	within<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends NumericSql,
		V,
		FA extends Facts,
		L,
		const Lo extends LiteralOf<L>,
		const Hi extends LiteralOf<L>
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L>,
		low: Lo,
		high: Hi
	): GuardOver<X, PA, OA, S, V, FA, L, WithinFacts<Lo, Hi>>
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
	 * two variables makes each determine the other, as r.eq's do (evidence/evidence.ts EqualityStates). A first operand
	 * admits a JavaScript value beside a term only to refuse it by name (FirstTerm).
	 */
	eq<A extends TermBase | FirstValue, const B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B> & Stating<EqualityStates<A, B>>
	ne<A extends TermBase | FirstValue, B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	lt<A extends TermBase | FirstValue, B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	le<A extends TermBase | FirstValue, B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	gt<A extends TermBase | FirstValue, B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	ge<A extends TermBase | FirstValue, B extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>>(
		a: A & FirstTerm<A>,
		b: B
	): Compared<A, B>
	between<
		A extends TermBase | FirstValue,
		L extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>,
		H extends Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>
	>(
		a: A & FirstTerm<A>,
		low: L,
		high: H
	): Predicate<P<A> & P<L> & P<H>, ComputedOrigin<O<A> | O<L> | O<H>>>
	in<A extends TermBase | FirstValue>(
		a: A & FirstTerm<A>,
		values: ReadonlyArray<LiteralOf<LanguageOf<A>>>
	): Predicate<P<A>, ComputedOrigin<O<A>>>

	/**
	 * A span's endpoints, of its endpoint descriptor's type, contract included, and its width, the plain value of the
	 * endpoint's SQL type: the endpoint descriptor states what a span term's type alone cannot carry, and must be the
	 * span's own.
	 */
	lower<A extends TermBase | FirstValue, E, PA, OA, ES extends EndpointSql>(
		s: A & FirstTerm<A> & InputTerm<Span<E>, PA, OA, "range">,
		endpoint: Field<E, ES>
	): Term<E, PA, ComputedOrigin<OA>, ES>
	upper<A extends TermBase | FirstValue, E, PA, OA, ES extends EndpointSql>(
		s: A & FirstTerm<A> & InputTerm<Span<E>, PA, OA, "range">,
		endpoint: Field<E, ES>
	): Term<E, PA, ComputedOrigin<OA>, ES>
	/** The exact difference of the endpoints, which never overflows. */
	width<A extends TermBase | FirstValue, E, PA, OA, ES extends EndpointSql>(
		s: A & FirstTerm<A> & InputTerm<Span<E>, PA, OA, "range">,
		endpoint: Field<E, ES>
	): Term<bigint, PA, ComputedOrigin<OA>, "exact integer">

	/** char_length; admitted only in contract predicates and row checks, never in a query. */
	charLength<A extends TermBase | FirstValue, X, PA, OA>(
		s: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Scalar<number, PA, ComputedOrigin<OA>, "integer">

	/**
	 * double precision in [0, 2]; schema-qualified cosine_distance(a, b), never the <=> operator. The second operand is
	 * a vector term of the first's dimensions or a literal vector, which takes the first operand's type.
	 */
	cosineDistance<A extends TermBase | FirstValue, X, PA, OA, B extends Operand<X, "vector">>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "vector">,
		b: B
	): Term<number, PA & P<B>, ComputedOrigin<OA | O<B>>, "double precision">
}

/** The comparison and boolean helpers a row check sees beside its fields. */
export type ScalarHelpers = Pick<
	ComputeApi,
	"eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in" | "and" | "or" | "not" | "charLength"
>
