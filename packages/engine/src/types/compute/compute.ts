import type { Brand } from "effect"
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
	SignedSql,
	SpanWidthSql
} from "#compiler/scalar/compute/tables.ts"
import type { guarded } from "#compiler/scalar/compute/term.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type {
	Admitted,
	AnyRefused,
	CastAdmitted,
	ContractAdmits,
	Every,
	First,
	FirstAmong,
	Fit,
	FirstOrigin,
	FirstTerm,
	FirstValue,
	Guard,
	Holds,
	Literal,
	Operand,
	Precondition,
	Proves,
	Refutes,
	Scalar,
	Takes,
	TakesFirst,
	TakesRest,
	WithinFacts
} from "#compiler/types/compute/scalar.ts"

import type {
	ColumnFacts,
	ComputedOrigin,
	ConstantOrigin,
	Facts,
	InputTerm,
	LanguageOf,
	Meets,
	NegatesIn,
	NegationFree,
	NegationFreeEach,
	OperandOrigin,
	ParamsOfEach,
	ParamsOfTerm,
	Predicate,
	PredicateBase,
	Refusal,
	SqlOfTerm,
	Term,
	TermBase,
	TypeOfTerm,
	UnionToIntersection,
	ValueOfTerm
} from "#compiler/types/core/phantom.ts"
import type { EqualityStates, StatesOf, Stating } from "#compiler/types/evidence/evidence.ts"
import type { Field, LiteralOf, NotStoredOnly, NotRoster } from "#compiler/types/fields/field.ts"
import type { PatternValidate } from "#compiler/types/fields/regex.ts"
import type { Scored } from "#compiler/types/vector/vector.ts"

/** The SQL type a descriptor states, read off the descriptor as written. */
type SqlOfDescriptor<D> = D extends { readonly sql: infer Q extends SqlTag } ? Q : never

/**
 * Whether a span's endpoint descriptor is the one the engine requires: the span's own, of an endpoint's SQL type ES,
 * integer, bigint or date, whose domain D is exactly the span's endpoints' E, a contract's declared facts included, so
 * neither another SQL type nor a contract over a span's plain endpoint type nor the plain type of a span over a
 * contract.
 */
type SpanEndpoint<E, H, ES extends SqlTag> = [ES] extends [EndpointSql]
	? [E] extends [H]
		? [H] extends [E]
			? true
			: false
		: false
	: false

/** Whether a divisor B is proved nonzero where a quotient over S needs it: a float's never does, since IEEE 754 defines its quotient by zero. */
type NonzeroDivisor<S extends SqlTag, B> = [S] extends ["real" | "double precision"]
	? true
	: Proves<B, "nonzero">

/**
 * Whether a first operand a partial operation needs finite, of facts FX and value type LV (Holds), is: numeric's and a
 * float's must be proved so; an integer's, money's and an exact value's are by their types.
 */
type IsFinite<S extends SqlTag, FX extends Facts, LV> = [S] extends [InexactSql]
	? Holds<FX, LV, "finite">
	: true

/** Whether a cast's operand is as finite as its target needs: from numeric or a float into an integer or money, proved finite. */
type FiniteCast<S extends SqlTag, F extends SqlTag, FX extends Facts, LV> = [F] extends [
	"smallint" | "integer" | "bigint" | "money"
]
	? IsFinite<S, FX, LV>
	: true

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

/** Whether a power's base, of facts FA and value type LA, and exponent B meet its precondition (see power). */
type PowerBase<FA extends Facts, LA, B> =
	Holds<FA, LA, "nonnegative"> extends true
		? Holds<FA, LA, "nonzero"> extends true
			? true
			: Proves<B, "nonnegative">
		: false

/**
 * Whether an operation over the SQL types F takes its first operand A, of type (X, S), and an operand B opposite it: a
 * term of X's type, a parameter among them, or a JavaScript value of its language.
 */
type Binary<A, B, X, S extends SqlTag, F extends SqlTag, L = X> = Every<
	[TakesFirst<A, F>, Takes<B, Operand<X, S, L>>]
>

/**
 * The facts a negation keeps of its operand's, of facts FA and, a constant, of value type LA (Holds), as compilation
 * keeps them (lower.ts negationFacts): finite and nonzero, each where the operand has it; never nonnegative, since -x is
 * not, and no fact states a value at or below zero.
 */
type NegatedFacts<FA extends Facts, LA> = Facts &
	(Holds<FA, LA, "finite"> extends true ? { readonly finite: true } : unknown) &
	(Holds<FA, LA, "nonzero"> extends true ? { readonly nonzero: true } : unknown)

/** Whether a cast takes its operand A, of type (X, S), into the target's domain D and SQL type F. */
type Casts<A, X, S extends SqlTag, D, F extends SqlTag> = Every<
	[TakesFirst<A, SqlTag>, CastAdmitted<X, S, D, F>]
>

/** Whether width_bucket takes its operand, its bounds, numeric terms each, and its count. */
type Buckets<AX, AL, AH, C> = Every<
	[
		TakesFirst<AX, "numeric">,
		TakesFirst<AL, "numeric">,
		TakesFirst<AH, "numeric">,
		Takes<C, Meets<number, SqlTag>>
	]
>

/** Whether a regex match's pattern is in the grammar: a string PatternValidate admits, or a term. */
type ValidPattern<B> = B extends string ? ([B] extends [PatternValidate<B>] ? true : false) : true

/** What a guard proves of its subject: the subject term, its facts with the guard's, and a constant's value (Literal). */
type GuardOver<X, PA, OA, S extends SqlTag, V, FA extends Facts, L, LX, G> = Guard<
	Term<X, PA, OA, S, V, FA & G, L> & Literal<LX>,
	PA,
	ComputedOrigin<OA>
>

/** The brands a type carries, by name: a roster's identity (Rostered) and a contract's name. */
type BrandNames<X> = X extends Brand.Brand<infer K> ? K : never

/** Every brand a value of X carries, one Brand per name, as a branded value holds them. */
type BrandsOf<X> = UnionToIntersection<
	BrandNames<X> extends infer K ? (K extends string ? Brand.Brand<K> : never) : never
>

/** A closed id's handle without its brands: a contract over a closed id brands its handles by its name. */
type Unbranded<H> = H extends (infer U extends string) & BrandsOf<H> ? U : H

/**
 * The set over the roster of a closed id of domain X and language L: a set of L's handles, unbranded, under X's
 * roster's identity (Rostered), so it is the Bits of a set field over that roster, and meets a set over no other.
 */
type SetOver<X, L> = ReadonlySet<Unbranded<L>> &
	Brand.Brand<Extract<BrandNames<X>, `roster ${string}`>>

type T<A> = TypeOfTerm<A>
type P<A> = ParamsOfTerm<A>
type O<A> = OperandOrigin<A>
/** The negation of a decided condition. */
type Not<C extends boolean> = [C] extends [true] ? false : true
/** Whether the contract of a term A refuses a JavaScript value B read opposite it, as the types decide it (Refutes). */
type RefutedAt<A, B> = Refutes<ColumnFacts<A>, B>
/** The members of a list of values. */
type MembersOf<Vs> = Vs extends ReadonlyArray<infer E> ? E : never
/**
 * Whether an operation over the SQL types F takes its first operand A and an operand B opposite it (Binary), and B's
 * contract, A's, admits it as far as the types decide (RefutedAt): the call the engine takes past its values.
 */
type Reads<A, B, X, S extends SqlTag, F extends SqlTag> = Every<
	[Binary<A, B, X, S, F>, Not<RefutedAt<A, B>>]
>
/** Whether a range's subject A, of an SQL type of F and language L, takes both its bounds, values of L. */
type Bounds<A, Lo, Hi, F extends SqlTag, L> = Every<
	[TakesFirst<A, F>, Takes<Lo, LiteralOf<L>>, Takes<Hi, LiteralOf<L>>]
>
/** Whether a conditional takes its test C, its first branch A, of type (X, S, L), and its other branch. */
type Conditional<C, A, Otherwise, X, S extends SqlTag, L> = Every<
	[
		Takes<C, PredicateBase | Meets<boolean, "boolean">>,
		TakesFirst<A, SqlTag>,
		Takes<Otherwise, Operand<X, S, L>>
	]
>
/** Whether LEAST or GREATEST takes its first operand A, of type (X, S), and every other operand Bs, terms that meet it. */
type Extremes<A, Bs extends ReadonlyArray<unknown>, X, S extends SqlTag> = Every<
	[TakesFirst<A, OrderedSql>, TakesRest<Bs, ReadonlyArray<Meets<X, S>>>]
>
/** An operand B's own requirement opposite A: its contract's refusal, where the operation takes both (ContractAdmits). */
type ValueAt<A, B, X, S extends SqlTag, F extends SqlTag> = ContractAdmits<
	Binary<A, B, X, S, F>,
	ColumnFacts<A>,
	B
>
/**
 * The values an operand delivers opposite a term whose column delivers V: a term's column's; a JavaScript value its own
 * where it is one of V, and otherwise V, into which the column converts it, as a bigint opposite a numeric is a Decimal.
 */
type ValuesOf<A, V> = A extends TermBase ? ValueOfTerm<A> : A extends V ? A : V
/** The SQL types of the exact families: the integers with the exact integer, money with exact money. */
type IntegerFamily = "smallint" | "integer" | "bigint" | "exact integer"
/**
 * Whether a term B opposite a first operand of SQL type S is of S's exact family without sharing S: an exact value
 * beside a plain one, in either order, which share no type (the engine's MalformedDescription); never for a value.
 */
type MixesExact<S extends SqlTag, B> = B extends TermBase
	? [SqlOfTerm<B>] extends [S]
		? false
		: [S | SqlOfTerm<B>] extends [IntegerFamily]
			? true
			: [S | SqlOfTerm<B>] extends ["money" | "exact money"]
				? true
				: false
	: false
/** Whether no operand B opposite a first operand of SQL type S mixes an exact value with a plain one (MixesExact). */
type OneType<S extends SqlTag, B> = true extends MixesExact<S, B> ? false : true
/**
 * An operand's own requirement opposite a first operand of SQL type S, which types a conditional, LEAST or GREATEST:
 * the refusal of an exact value beside a plain one of its family (OneType), stated only where the call takes the
 * operand (Taken).
 */
type SharesType<Taken extends boolean, S extends SqlTag, B> = [Taken] extends [true]
	? OneType<S, B> extends true
		? unknown
		: Refusal<"operands of one type: an exact value beside a plain value of its family; Compute.cast the exact one into the plain one's type">
	: unknown
/** A comparison of two operands: their parameters, and their reads as its origin. */
type Compared<A, B> = Predicate<P<A> & P<B>, ComputedOrigin<O<A> | O<B>>>
/** What stands opposite a first operand A: a term that meets its type, or a JavaScript value of its language. */
type Opposite<A> = Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>
/**
 * Whether a comparison over the SQL types F takes its operands: a term of one of them first, and opposite it a term that
 * meets its type or a value.
 */
type Compares<A, B, F extends SqlTag> = Every<[TakesFirst<A, F>, Takes<B, Opposite<A>>]>
/** Whether IN takes its first operand A, a term, and its list Vs, values of A's language. */
type Listed<A, Vs> = Every<
	[TakesFirst<A, SqlTag>, Takes<Vs, ReadonlyArray<LiteralOf<LanguageOf<A>>>>]
>
/** Whether BETWEEN takes its operands: a term of an ordered type first, and opposite it two operands (Opposite). */
type Between<A, Lo, Hi> = Every<
	[TakesFirst<A, OrderedSql>, Takes<Lo, Opposite<A>>, Takes<Hi, Opposite<A>>]
>
/** The SQL types whose values are ordered: every one but a set's, whose bit string has no order in grizzle. */
type OrderedSql = Exclude<SqlTag, "bits">
/** An ordering's first operand: a term of an ordered type, and never a set (OrderedSql). */
type Ordered<A> = [SqlOfTerm<A>] extends ["bits"] ? never : unknown

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
 * A call is refused in the engine's order, and its one diagnostic names the engine's reason. A first operand is a term,
 * never a parameter or a JavaScript value (FirstTerm): the checker types those from the term they meet, and each first
 * operand admits a JavaScript value beside its terms only to refuse it by that name. Then each operand's type: the
 * operand families are constraints on the first operand's SQL type, so a type error points at the mistaken operand
 * (arithmetic over booleans, text, uuids, enums, spans and vectors; money products, remainders, negations and absolute
 * values; % over a float; power and sqrt over an integer type), and every other operand is read as it is written and
 * held to its position (Fit), so the types see which operand the operation does not take. Last, a partial
 * operation's precondition (Precondition), stated only where the operation takes every operand, so an operand of
 * another type gets its type refusal and never the precondition's. A precondition the types cannot prove is refused,
 * whatever compilation would find first. Before it, a JavaScript value a contract reads, a constant of one or a value
 * opposite a term of one, states its contract's refusal where the types decide it (Refutes): it lacks a fact the
 * contract declares, which its predicate implies. A bound the predicate states is in no type, so a value outside one is
 * compilation's to refuse (ContractLiteral). A refused call's result is never (Admitted), which meets every position,
 * so a call over it states no refusal of its own, as the engine, which builds a call's operands first, refuses the
 * inner call.
 *
 * test/unit/compute pins the runtime behavior each signature promises, the Compute population
 * (test/support/agreement/compute.ts) the signatures against the engine.
 */
export interface ComputeApi {
	/**
	 * A constant of a descriptor's type, of its whole host type: a typed constant, which stands wherever a term of that
	 * type stands, first included. Its value is a JavaScript value of the descriptor's language, its host type: a
	 * refined text's pattern's, uuid_out's spelling. Its value is the one approximation its type keeps: its column
	 * delivers the host type, never x alone. A roster's member is X.handle(member), whose column delivers the member, so a
	 * closed id's descriptor is refused here, and a set's, of the code-free SQL type bits, is a descriptor like any other.
	 * A contract refuses a value the types see lacking a fact it declares (Refutes), and judges any other when compilation
	 * reads it.
	 */
	literal<H, S extends SqlTag, D, F extends Facts, const V>(
		type: Field<H, S, D, F> & ([S] extends ["code"] ? NotRoster : unknown) & NotStoredOnly<S>,
		value: Fit<V, NoInfer<LiteralOf<H>>> & ContractAdmits<Takes<V, LiteralOf<H>>, F, V>
	): Admitted<
		Every<[Takes<V, LiteralOf<H>>, Not<Refutes<F, V>>]>,
		Term<D, unknown, ConstantOrigin, S, H, F> & Literal<V>
	>
	/** Drops a contract to its base explicitly: the plain value of its SQL type, with every fact it states. */
	base<A extends TermBase | FirstValue, X, PA, OA, S extends PlainSql, FX extends Facts>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, S> & Proving<FX>
	): Admitted<
		TakesFirst<A, PlainSql>,
		Term<PlainHost[S], PA, ComputedOrigin<OA>, S, PlainHost[S], FX>
	>
	/**
	 * Re-enters a contract, or converts, through a cast PostgreSQL checks; a violation is a typed execution failure.
	 * The numeric family and money convert among themselves where PostgreSQL has a cast; any other base
	 * casts only into a contract or refinement over itself: its domain D over the same base. The result is of the
	 * target's domain, and delivers its values H, its language. Whether PostgreSQL has the cast is judged of a term,
	 * and the narrowing's finiteness of a cast it has.
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
			Precondition<
				TakesFirst<A, SqlTag>,
				CastAdmitted<X, S, D, F>,
				"PostgreSQL has no cast between these types that Compute admits"
			> &
			Precondition<
				Casts<A, X, S, D, F>,
				FiniteCast<S, F, FX, LX>,
				"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)"
			>,
		to: Field<H, F, D>
	): Admitted<Casts<A, X, S, D, F>, Term<D, PA, ComputedOrigin<OA>, F, H, CastFacts<S, F, FX>>>

	/**
	 * The numeric of a value: PostgreSQL's conversion into numeric, `x::numeric`, of an integer, money, an exact value,
	 * a numeric or a float. Its result is a computed numeric, the type no field has, whose bound the value's gives
	 * (ir/scalar.ts NumericBound): a numeric(p, s) its typmod dropped, every other value exactly but a float, which
	 * float4_numeric and float8_numeric write with FLT_DIG or DBL_DIG significant digits, NaN and the infinities kept.
	 * It keeps the value's facts as a cast does.
	 */
	numeric<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, FX extends Facts>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, S> & Proving<FX>
	): Admitted<
		TakesFirst<A, NumericSql>,
		Term<Decimal, PA, ComputedOrigin<OA>, "numeric", Decimal, CastFacts<S, "numeric", FX>>
	>

	/**
	 * Arithmetic on contract values yields the base type. Integer and money arithmetic is exact: an exact integer,
	 * delivered as bigint, and exact money, which never overflow; float arithmetic is IEEE 754.
	 */
	add<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Operand<X, S>>> & ValueAt<A, B, X, S, NumericSql>
	): Admitted<
		Reads<A, B, X, S, NumericSql>,
		Term<PlainHost[ArithmeticSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, ArithmeticSql[S]>
	>
	sub<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Operand<X, S>>> & ValueAt<A, B, X, S, NumericSql>
	): Admitted<
		Reads<A, B, X, S, NumericSql>,
		Term<PlainHost[ArithmeticSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, ArithmeticSql[S]>
	>
	/** Money has no product. */
	mul<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Operand<X, S>>> & ValueAt<A, B, X, S, SignedSql>
	): Admitted<
		Reads<A, B, X, S, SignedSql>,
		Term<PlainHost[ArithmeticSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, ArithmeticSql[S]>
	>
	/**
	 * Integer division truncates over the exact integers; money / money is double precision. The divisor is proved
	 * nonzero, except a float's, whose quotient by zero IEEE 754 defines (±Infinity, or NaN over zero).
	 */
	div<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Operand<X, S>>> &
			ValueAt<A, B, X, S, NumericSql> &
			Precondition<
				Reads<A, B, X, S, NumericSql>,
				NonzeroDivisor<S, B>,
				"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)"
			>
	): Admitted<
		Reads<A, B, X, S, NumericSql>,
		Term<PlainHost[QuotientSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, QuotientSql[S]>
	>
	/** PostgreSQL has no float or money %; the divisor is proved nonzero. */
	mod<A extends TermBase | FirstValue, X, PA, OA, S extends IntegralSql, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Operand<X, S>>> &
			ValueAt<A, B, X, S, IntegralSql> &
			Precondition<
				Reads<A, B, X, S, IntegralSql>,
				NonzeroDivisor<S, B>,
				"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)"
			>
	): Admitted<
		Reads<A, B, X, S, IntegralSql>,
		Term<PlainHost[RemainderSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, RemainderSql[S]>
	>
	/**
	 * The negation keeps its operand's finite and nonzero facts, a constant's value's among them, and never its
	 * nonnegative one (NegatedFacts).
	 */
	neg<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql, FA extends Facts, LA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S> & Proving<FA> & Literal<LA>
	): Admitted<
		TakesFirst<A, SignedSql>,
		Term<
			PlainHost[ArithmeticSql[S]],
			PA,
			ComputedOrigin<OA>,
			ArithmeticSql[S],
			PlainHost[ArithmeticSql[S]],
			NegatedFacts<FA, LA>
		>
	>
	quot<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "numeric">,
		b: Fit<B, NoInfer<Operand<X, "numeric">>> &
			ValueAt<A, B, X, "numeric", "numeric"> &
			Precondition<
				Reads<A, B, X, "numeric", "numeric">,
				Proves<B, "nonzero">,
				"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)"
			>
	): Admitted<
		Reads<A, B, X, "numeric", "numeric">,
		Term<Decimal, PA & P<B>, ComputedOrigin<OA | O<B>>, "numeric">
	>
	rem<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "numeric">,
		b: Fit<B, NoInfer<Operand<X, "numeric">>> &
			ValueAt<A, B, X, "numeric", "numeric"> &
			Precondition<
				Reads<A, B, X, "numeric", "numeric">,
				Proves<B, "nonzero">,
				"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)"
			>
	): Admitted<
		Reads<A, B, X, "numeric", "numeric">,
		Term<Decimal, PA & P<B>, ComputedOrigin<OA | O<B>>, "numeric">
	>
	abs<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): Admitted<
		TakesFirst<A, SignedSql>,
		Term<PlainHost[ArithmeticSql[S]], PA, ComputedOrigin<OA>, ArithmeticSql[S]>
	>
	/** sign returns the operand's type, composed over the integer types and real (scalar/compute/registry.ts). */
	sign<A extends TermBase | FirstValue, X, PA, OA, S extends SignedSql>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): Admitted<TakesFirst<A, SignedSql>, Term<PlainHost[S], PA, ComputedOrigin<OA>, S>>
	/**
	 * round, trunc, ceil, and floor are numeric only; there is no exp, ln, or log. A scale is a JavaScript integer, read
	 * as it is written (Sc, a number where none is written).
	 */
	round<A extends TermBase | FirstValue, X, PA, OA, const Sc = number>(
		a: A & First<A, [Sc]> & InputTerm<X, PA, OA, "numeric">,
		scale?: Fit<Sc, NoInfer<number>>
	): Admitted<
		Every<[TakesFirst<A, "numeric">, Takes<Sc, number>]>,
		Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	>
	trunc<A extends TermBase | FirstValue, X, PA, OA, const Sc = number>(
		a: A & First<A, [Sc]> & InputTerm<X, PA, OA, "numeric">,
		scale?: Fit<Sc, NoInfer<number>>
	): Admitted<
		Every<[TakesFirst<A, "numeric">, Takes<Sc, number>]>,
		Term<Decimal, PA, ComputedOrigin<OA>, "numeric">
	>
	ceil<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">
	): Admitted<TakesFirst<A, "numeric">, Term<Decimal, PA, ComputedOrigin<OA>, "numeric">>
	floor<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">
	): Admitted<TakesFirst<A, "numeric">, Term<Decimal, PA, ComputedOrigin<OA>, "numeric">>
	/** Integer and numeric; over smallint they are the integer forms cast back. */
	gcd<A extends TermBase | FirstValue, X, PA, OA, S extends IntegralSql, B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Meets<X, S>>>
	): Admitted<
		Every<[TakesFirst<A, IntegralSql>, Takes<B, Meets<X, S>>]>,
		Term<PlainHost[DivisorSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, DivisorSql[S]>
	>
	lcm<A extends TermBase | FirstValue, X, PA, OA, S extends IntegralSql, B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Meets<X, S>>>
	): Admitted<
		Every<[TakesFirst<A, IntegralSql>, Takes<B, Meets<X, S>>]>,
		Term<PlainHost[DivisorSql[S]], PA & P<B>, ComputedOrigin<OA | O<B>>, DivisorSql[S]>
	>
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
		const B
	>(
		a: A &
			First<A, [B]> &
			InputTerm<X, PA, OA, S> &
			Proving<FA> &
			Literal<LA> &
			Precondition<
				Reads<A, B, X, S, PowerSql>,
				PowerBase<FA, LA, B>,
				"a power's base proved nonnegative, and nonzero or its exponent nonnegative: guard it with Compute.when(Compute.positive(x), (x) => …, otherwise)"
			>,
		b: Fit<B, NoInfer<Operand<X, S>>> & ValueAt<A, B, X, S, PowerSql>
	): Admitted<
		Reads<A, B, X, S, PowerSql>,
		Term<PlainHost[S], PA & P<B>, ComputedOrigin<OA | O<B>>, S>
	>
	/** Numeric's radicand is proved nonnegative; double precision's is IEEE 754's, NaN below zero. */
	sqrt<A extends TermBase | FirstValue, X, PA, OA, S extends PowerSql, FA extends Facts, LA>(
		a: A &
			FirstTerm<A> &
			InputTerm<X, PA, OA, S> &
			Proving<FA> &
			Literal<LA> &
			Precondition<
				TakesFirst<A, PowerSql>,
				[S] extends ["numeric"] ? Holds<FA, LA, "nonnegative"> : true,
				"a radicand proved nonnegative: guard it with Compute.when(Compute.nonnegative(x), (x) => …, otherwise)"
			>
	): Admitted<TakesFirst<A, PowerSql>, Term<PlainHost[S], PA, ComputedOrigin<OA>, S>>
	/**
	 * LEAST and GREATEST return an operand unchanged, so they keep the first operand's type, contract and roster
	 * included, and deliver any operand's values; every other operand is a term of that type. An exact value and a
	 * plain one of its family share none, in either order (SharesType): PostgreSQL widens the plain one, grizzle asks
	 * for Compute.cast of the exact one into the plain one's type.
	 */
	least<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends OrderedSql,
		V,
		L,
		const Bs extends ReadonlyArray<unknown>
	>(
		first: A & First<A, Bs> & Term<X, PA, OA, S, V, Facts, L>,
		...rest: Bs &
			NoInfer<ReadonlyArray<Meets<X, S>>> &
			NoInfer<{ readonly [K in keyof Bs]: SharesType<Extremes<A, Bs, X, S>, S, Bs[K]> }>
	): Admitted<
		Every<[Extremes<A, Bs, X, S>, OneType<S, Bs[number]>]>,
		Term<
			X,
			PA & ParamsOfEach<Bs>,
			ComputedOrigin<OA | O<Bs[number]>>,
			S,
			V | ValueOfTerm<Bs[number]>,
			Facts,
			L
		>
	>
	greatest<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends OrderedSql,
		V,
		L,
		const Bs extends ReadonlyArray<unknown>
	>(
		first: A & First<A, Bs> & Term<X, PA, OA, S, V, Facts, L>,
		...rest: Bs &
			NoInfer<ReadonlyArray<Meets<X, S>>> &
			NoInfer<{ readonly [K in keyof Bs]: SharesType<Extremes<A, Bs, X, S>, S, Bs[K]> }>
	): Admitted<
		Every<[Extremes<A, Bs, X, S>, OneType<S, Bs[number]>]>,
		Term<
			X,
			PA & ParamsOfEach<Bs>,
			ComputedOrigin<OA | O<Bs[number]>>,
			S,
			V | ValueOfTerm<Bs[number]>,
			Facts,
			L
		>
	>
	/**
	 * The operand and the bounds are numeric terms proved finite; that the bounds differ and the count lies in
	 * 1..2147483646 rests on their magnitudes, which compilation proves or refuses as PartialOperation. The engine reads
	 * each of the three as a term before it reads any one's type, so one of another type states the literal-first
	 * refusal of a later one (FirstAmong).
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
		C
	>(
		x: AX &
			FirstAmong<AX, "numeric", [AL, AH, C], [AL, AH]> &
			InputTerm<XX, PX, OX, "numeric"> &
			Proving<FXX> &
			Literal<LXX> &
			Precondition<
				Buckets<AX, AL, AH, C>,
				Holds<FXX, LXX, "finite">,
				"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)"
			>,
		low: AL &
			FirstAmong<AL, "numeric", [AX, AH, C], [AH]> &
			InputTerm<XL, PL, OL, "numeric"> &
			Proving<FXL> &
			Literal<LXL> &
			Precondition<
				Buckets<AX, AL, AH, C>,
				Holds<FXL, LXL, "finite">,
				"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)"
			>,
		high: AH &
			First<AH, [AX, AL, C]> &
			InputTerm<XH, PH, OH, "numeric"> &
			Proving<FXH> &
			Literal<LXH> &
			Precondition<
				Buckets<AX, AL, AH, C>,
				Holds<FXH, LXH, "finite">,
				"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)"
			>,
		count: Fit<C, NoInfer<Meets<number, SqlTag>>>
	): Admitted<
		Buckets<AX, AL, AH, C>,
		Term<number, PX & PL & PH & P<C>, ComputedOrigin<OX | OL | OH | O<C>>, "integer">
	>
	/** min_scale of a value proved finite. */
	minScale<A extends TermBase | FirstValue, X, PA, OA, FA extends Facts, LA>(
		a: A &
			FirstTerm<A> &
			InputTerm<X, PA, OA, "numeric"> &
			Proving<FA> &
			Literal<LA> &
			Precondition<
				TakesFirst<A, "numeric">,
				Holds<FA, LA, "finite">,
				"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)"
			>
	): Admitted<TakesFirst<A, "numeric">, Term<number, PA, ComputedOrigin<OA>, "integer">>

	/**
	 * The first branch, a term and never a parameter or a JavaScript value (FirstTerm), types the conditional, contract
	 * and roster included; the other is a term that meets its type (a parameter among them) or a literal of it, and the
	 * conditional delivers either's values. An exact value and a plain one of its family share no type, in either order
	 * (SharesType): PostgreSQL widens the plain branch, grizzle asks for Compute.cast of the exact one into the plain
	 * one's type. A boolean field is a predicate here, so
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
		const Otherwise
	>(
		p: C & First<C, [A, Otherwise]> & NegationFree<C>,
		then: A & First<A, [C, Otherwise]> & Term<X, PT, OT, S, V, Facts, L>,
		otherwise: Fit<Otherwise, NoInfer<Operand<X, S, L>>> &
			ContractAdmits<Conditional<C, A, Otherwise, X, S, L>, ColumnFacts<A>, Otherwise> &
			SharesType<Conditional<C, A, Otherwise, X, S, L>, S, Otherwise>
	): Admitted<
		Every<
			[Conditional<C, A, Otherwise, X, S, L>, Not<RefutedAt<A, Otherwise>>, OneType<S, Otherwise>]
		>,
		Term<
			X,
			P<C> & PT & P<Otherwise>,
			ComputedOrigin<O<C> | OT | O<Otherwise>>,
			S,
			V | ValuesOf<Otherwise, V>,
			Facts,
			L
		>
	>
	/**
	 * The one guard of a partial operation: CASE WHEN <guard> THEN <branch> ELSE <otherwise> END. The branch is a
	 * function of the guard's subject, which it receives with the guard's facts proved, so a partial operation over it
	 * type-checks inside the branch and nowhere else; the otherwise branch, a term that meets the branch's type or a
	 * literal of it, is the caller's value where the guard fails: Compute.when(Compute.nonzero(b), (b) => Compute.div(a,
	 * b), 0n). The subject is read off the guard itself, so a guard its builder refused, never (Admitted), hands the
	 * branch never, and the refusal is its one diagnostic. Its branch and its otherwise share one type (SharesType), so an
	 * exact quotient beside an integer otherwise is refused: cast the quotient into the integer's type.
	 */
	when<Gd extends Guard<TermBase, never>, X, PT, OT, S extends SqlTag, V, L, const Otherwise>(
		guard: Gd,
		then: (subject: Gd[typeof guarded]) => Term<X, PT, OT, S, V, Facts, L> & FirstOrigin<OT>,
		otherwise: Fit<Otherwise, NoInfer<Operand<X, S, L>>> &
			ContractAdmits<
				Every<[Takes<Gd, Guard<TermBase, never>>, Takes<Otherwise, Operand<X, S, L>>]>,
				ColumnFacts<Term<X, PT, OT, S, V, Facts, L>>,
				Otherwise
			> &
			SharesType<
				Every<[Takes<Gd, Guard<TermBase, never>>, Takes<Otherwise, Operand<X, S, L>>]>,
				S,
				Otherwise
			>
	): Admitted<
		Every<
			[
				Takes<Gd, Guard<TermBase, never>>,
				Takes<Otherwise, Operand<X, S, L>>,
				Not<RefutedAt<Term<X, PT, OT, S, V, Facts, L>, Otherwise>>,
				OneType<S, Otherwise>
			]
		>,
		Term<
			X,
			P<Gd> & PT & P<Otherwise>,
			ComputedOrigin<O<Gd> | OT | O<Otherwise>>,
			S,
			V | ValuesOf<Otherwise, V>,
			Facts,
			L
		>
	>
	/** A guard that its subject, a numeric-family term, is nonzero: `x <> 0`. */
	nonzero<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends NumericSql,
		V,
		FA extends Facts,
		L,
		LX
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L> & Literal<LX>
	): Admitted<
		TakesFirst<A, NumericSql>,
		GuardOver<X, PA, OA, S, V, FA, L, LX, { readonly nonzero: true }>
	>
	/** A guard that its subject is nonnegative: `x >= 0`. */
	nonnegative<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends NumericSql,
		V,
		FA extends Facts,
		L,
		LX
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L> & Literal<LX>
	): Admitted<
		TakesFirst<A, NumericSql>,
		GuardOver<X, PA, OA, S, V, FA, L, LX, { readonly nonnegative: true }>
	>
	/** A guard that its subject is positive, so nonzero and nonnegative: `x > 0`. */
	positive<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends NumericSql,
		V,
		FA extends Facts,
		L,
		LX
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L> & Literal<LX>
	): Admitted<
		TakesFirst<A, NumericSql>,
		GuardOver<X, PA, OA, S, V, FA, L, LX, { readonly nonzero: true; readonly nonnegative: true }>
	>
	/** A guard that its subject, numeric or a float, is finite: `x > -Infinity AND x < Infinity`. */
	isFinite<
		A extends TermBase | FirstValue,
		X,
		PA,
		OA,
		S extends InexactSql,
		V,
		FA extends Facts,
		L,
		LX
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L> & Literal<LX>
	): Admitted<
		TakesFirst<A, InexactSql>,
		GuardOver<X, PA, OA, S, V, FA, L, LX, { readonly finite: true }>
	>
	/**
	 * A guard that its subject lies within two finite literal bounds: `x BETWEEN low AND high`. It proves the subject
	 * finite, nonnegative from a low bound at or above zero, and nonzero from bounds on one side of zero (WithinFacts);
	 * compilation reads the bounds too, for the preconditions that rest on magnitudes (a narrowing's range, a power's, a
	 * bucket's): Compute.when(Compute.within(x, 0n, 1000n), (x) => Compute.power(x, 2n), 0n). Over a contract a bound is a
	 * value of it, which its contract refuses where it lacks a fact the contract declares (ContractAdmits).
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
		LX,
		const Lo,
		const Hi
	>(
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L> & Literal<LX>,
		low: Fit<Lo, NoInfer<LiteralOf<L>>> &
			ContractAdmits<Bounds<A, Lo, Hi, NumericSql, L>, ColumnFacts<A>, Lo>,
		high: Fit<Hi, NoInfer<LiteralOf<L>>> &
			ContractAdmits<Bounds<A, Lo, Hi, NumericSql, L>, ColumnFacts<A>, Hi>
	): Admitted<
		Every<[Bounds<A, Lo, Hi, NumericSql, L>, Not<RefutedAt<A, Lo | Hi>>]>,
		GuardOver<X, PA, OA, S, V, FA, L, LX, WithinFacts<Lo, Hi>>
	>
	/** A negation holds no relational negation, which is a rule-level filter (Negating). */
	not<Q extends PredicateBase>(p: Q & NegationFree<Q>): Predicate<P<Q>, ComputedOrigin<O<Q>>>
	/**
	 * A conjunction states what each conjunct states, as the rule's does, and holds a relational negation where one of
	 * them does; a disjunction states nothing and holds none.
	 */
	and<const Qs extends ReadonlyArray<PredicateBase>>(
		...ps: Qs
	): Predicate<ParamsOfEach<Qs>, ComputedOrigin<O<Qs[number]>>> &
		Stating<StatesOf<Qs>> &
		NegatesIn<Qs>
	or<const Qs extends ReadonlyArray<PredicateBase>>(
		...ps: Qs & NegationFreeEach<Qs>
	): Predicate<ParamsOfEach<Qs>, ComputedOrigin<O<Qs[number]>>>
	/**
	 * In a rule's where, an equality between a variable and a value fixed per binding fixes the variable, and one between
	 * two variables makes each determine the other, as r.eq's do (evidence/evidence.ts EqualityStates). A first operand
	 * admits a JavaScript value beside a term only to refuse it by name (FirstTerm).
	 */
	eq<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, SqlTag>, ColumnFacts<A>, B>
	): Admitted<
		Every<[Compares<A, B, SqlTag>, Not<RefutedAt<A, B>>]>,
		Compared<A, B> & Stating<EqualityStates<A, B>>
	>
	ne<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, SqlTag>, ColumnFacts<A>, B>
	): Admitted<Every<[Compares<A, B, SqlTag>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	lt<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Compares<A, B, OrderedSql>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	le<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Compares<A, B, OrderedSql>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	gt<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Compares<A, B, OrderedSql>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	ge<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Compares<A, B, OrderedSql>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	between<A extends TermBase | FirstValue, const Lo, const Hi>(
		a: A & First<A, [Lo, Hi]> & Ordered<A>,
		low: Fit<Lo, NoInfer<Opposite<A>>> & ContractAdmits<Between<A, Lo, Hi>, ColumnFacts<A>, Lo>,
		high: Fit<Hi, NoInfer<Opposite<A>>> & ContractAdmits<Between<A, Lo, Hi>, ColumnFacts<A>, Hi>
	): Admitted<
		Every<[Between<A, Lo, Hi>, Not<RefutedAt<A, Lo | Hi>>]>,
		Predicate<P<A> & P<Lo> & P<Hi>, ComputedOrigin<O<A> | O<Lo> | O<Hi>>>
	>
	/**
	 * The list is read as it is written (Fit), every member a value of the first operand's language, so a member of
	 * another type refuses the list as one argument; over a refused first operand it states nothing.
	 */
	in<A extends TermBase | FirstValue, const Vs>(
		a: A & FirstTerm<A>,
		values: AnyRefused<[A]> extends true
			? Vs
			: Fit<Vs, NoInfer<ReadonlyArray<LiteralOf<LanguageOf<A>>>>> &
					ContractAdmits<Listed<A, Vs>, ColumnFacts<A>, MembersOf<Vs>>
	): Admitted<
		Every<[Listed<A, Vs>, Not<RefutedAt<A, MembersOf<Vs>>>]>,
		Predicate<P<A>, ComputedOrigin<O<A>>>
	>

	/**
	 * A span's endpoints, of its endpoint descriptor's type, contract included, and its width, the plain value of the
	 * endpoint's SQL type: the endpoint descriptor states what a span term's type alone cannot carry, and must be the
	 * span's own exactly (SpanEndpoint), as the engine requires of a span: an endpoint is of the descriptor's domain D,
	 * with the facts its contract declares, and delivers its values H, the span's endpoints.
	 */
	lower<A extends TermBase | FirstValue, E, PA, OA, ES extends SqlTag, H, D, F extends Facts>(
		s: A & FirstTerm<A> & InputTerm<Span<E>, PA, OA, "range">,
		endpoint: Field<H, ES, D, F> &
			Precondition<
				TakesFirst<A, "range">,
				SpanEndpoint<E, D, ES>,
				"the span's own endpoint descriptor: a descriptor of another type is no endpoint of the span"
			>
	): Admitted<
		Every<[TakesFirst<A, "range">, SpanEndpoint<E, D, ES>]>,
		Term<D, PA, ComputedOrigin<OA>, ES, H, F>
	>
	upper<A extends TermBase | FirstValue, E, PA, OA, ES extends SqlTag, H, D, F extends Facts>(
		s: A & FirstTerm<A> & InputTerm<Span<E>, PA, OA, "range">,
		endpoint: Field<H, ES, D, F> &
			Precondition<
				TakesFirst<A, "range">,
				SpanEndpoint<E, D, ES>,
				"the span's own endpoint descriptor: a descriptor of another type is no endpoint of the span"
			>
	): Admitted<
		Every<[TakesFirst<A, "range">, SpanEndpoint<E, D, ES>]>,
		Term<D, PA, ComputedOrigin<OA>, ES, H, F>
	>
	/**
	 * The difference of the endpoints, of the SQL type its endpoint's has (SpanWidthSql): an exact integer of integers,
	 * which never overflows, and an integer count of days of dates. The endpoint descriptor is read as it is written
	 * (Ep), so one of another SQL type states the endpoint's refusal.
	 */
	width<A extends TermBase | FirstValue, E, PA, OA, Ep, ES extends EndpointSql, H, D>(
		s: A & FirstTerm<A> & InputTerm<Span<E>, PA, OA, "range">,
		endpoint: Ep &
			Field<H, ES, D> &
			Precondition<
				TakesFirst<A, "range">,
				SpanEndpoint<E, D, SqlOfDescriptor<Ep>>,
				"the span's own endpoint descriptor: a descriptor of another type is no endpoint of the span"
			>
	): Admitted<
		Every<[TakesFirst<A, "range">, SpanEndpoint<E, D, SqlOfDescriptor<Ep>>]>,
		Term<PlainHost[SpanWidthSql[ES]], PA, ComputedOrigin<OA>, SpanWidthSql[ES]>
	>

	/** char_length; admitted only in contract predicates and row checks, never in a query. */
	charLength<A extends TermBase | FirstValue, X, PA, OA>(
		s: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Scalar<number, PA, ComputedOrigin<OA>, "integer">>
	/**
	 * octet_length, the text's UTF-8 bytes; admitted only in contract predicates and row checks, never in a query. A
	 * contract's octetLength bound bounds the text's bytes in a key exactly.
	 */
	octetLength<A extends TermBase | FirstValue, X, PA, OA>(
		s: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Scalar<number, PA, ComputedOrigin<OA>, "integer">>
	/**
	 * a || b, PostgreSQL's textcat: text of no pattern, which compilation reads within a's bytes and b's where both are
	 * bounded, a string by its own. The second operand is a text term the first meets, a parameter among them, or a
	 * string. Admitted in contract predicates, row checks, generated fields and folds; in a query only as a side of
	 * Compute.eq or Compute.ne, which is decided without building the concatenation, since it allocates its result,
	 * which PostgreSQL refuses past 1 GB, and a read never fails on a value.
	 */
	concat<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "text">,
		b: Fit<B, NoInfer<Meets<X, "text"> | string>>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | string>]>,
		Term<string, PA & P<B>, ComputedOrigin<OA | O<B>>, "text">
	>
	/** Whether a begins with b, PostgreSQL's starts_with: by code points, as text compares. */
	startsWith<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "text">,
		b: Fit<B, NoInfer<Meets<X, "text"> | string>>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | string>]>,
		Term<boolean, PA & P<B>, ComputedOrigin<OA | O<B>>, "boolean">
	>
	/** Whether a ends with b: `right(a, char_length(b)) = b`, since PostgreSQL has no ends_with. */
	endsWith<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "text">,
		b: Fit<B, NoInfer<Meets<X, "text"> | string>>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | string>]>,
		Term<boolean, PA & P<B>, ComputedOrigin<OA | O<B>>, "boolean">
	>
	/**
	 * PostgreSQL's translate, by characters: x with each character of from replaced by the character of to at its
	 * position. from and to are strings of one length, from holding each character once, so no character is deleted;
	 * compilation reads the result as text of the image of x's language under the map, so a bounded pattern stays
	 * bounded, within the most bytes the image of a text of x's byte bound takes, x's own bound for a map that takes no
	 * character to a wider one. Admitted in contract predicates, row checks and generated fields; in a query only over a
	 * text whose type bounds it within 268,435,454 bytes, since PostgreSQL's translate allocates four bytes for every
	 * byte of its operand and refuses past 1 GB. The engine reads from and to before the subject, so a subject that is no
	 * term is refused as one only beside two strings.
	 */
	translate<A extends TermBase | FirstValue, X, PA, OA, const Fr, const To>(
		x: A &
			(Every<[Takes<Fr, string>, Takes<To, string>]> extends true ? FirstTerm<A> : unknown) &
			InputTerm<X, PA, OA, "text">,
		from: Fr & string,
		to: To & string
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<Fr, string>, Takes<To, string>]>,
		Term<string, PA, ComputedOrigin<OA>, "text">
	>
	/**
	 * ASCII's case fold, translate(x, "A…Z", "a…z"): only the 26 capitals lower, every other character, a non-ASCII
	 * letter included, stays, so the fold is one map whatever the collation, as an IMMUTABLE expression needs, and
	 * compilation reads the result within x's byte bound.
	 */
	lowerAscii<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<string, PA, ComputedOrigin<OA>, "text">>
	/**
	 * XML Schema's whiteSpace replace: translate(x, "\t\n\r", "   "), tab, LF and CR each a space, as Compute.translate
	 * is admitted, and within x's byte bound.
	 */
	replaceWhitespace<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<string, PA, ComputedOrigin<OA>, "text">>
	/**
	 * XML Schema's whiteSpace collapse: each run of tab, LF, CR and space one space, and none at either end,
	 * `btrim(regexp_replace(x, '[ \t\n\r]+', ' ', 'g'))`, IMMUTABLE. Compilation reads the result as text of a language
	 * holding its values within x's length and byte bounds, which it never lengthens: exactly the image of x's where it
	 * is cheap to state, and otherwise more. Admitted in contract predicates, row checks and generated fields; in a query
	 * only over a text whose type bounds it within 268,435,454 bytes, since PostgreSQL's regex engine widens its operand
	 * to four bytes a byte.
	 */
	collapse<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<string, PA, ComputedOrigin<OA>, "text">>
	/**
	 * The double a decimal text names, IEEE 754-2019's conversion from decimal character sequences: the text's exact
	 * value rounded to the nearest double, ties to even, ±Infinity past the greatest finite double and a zero of the
	 * mantissa's sign below half the least subnormal; `INF`, `+INF`, `-INF` and `NaN` name themselves. Its text is
	 * `doubleText`, the grammar of XML Schema 1.1's xs:double lexical space, of any digits and any exponent:
	 * compilation proves the operand's pattern lies inside it, or refuses the parse as PartialOperation (`lexical`),
	 * remedied by `Compute.when(Compute.matches(x, doubleText), (x) => Compute.parseDouble(x), otherwise)`. Admitted
	 * in contract predicates, row checks, generated fields and queries.
	 */
	parseDouble<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<number, PA, ComputedOrigin<OA>, "double precision">>
	/**
	 * The numeric a decimal text names, exactly, by XML Schema's xs:decimal lexical mapping: its digits, signed, over ten
	 * to the count of its fraction digits, a computed numeric of no typmod, so no count of digits changes its value. Its
	 * text is `decimalText`, the grammar of XML Schema 1.1's xs:decimal lexical space, within `decimalTextMaxBytes`
	 * UTF-8 bytes, 16,384, past which a text may name a value numeric does not hold: compilation proves the operand's
	 * pattern lies inside it and its bytes within them, by its type (`str.bytes(16384, str.regex(decimalText))` or a
	 * refinement of it) or by guards, `Compute.when(Compute.matches(x, decimalText), (x) =>
	 * Compute.when(Compute.within(Compute.octetLength(x), 0, 16384), () => Compute.parseDecimal(x), otherwise),
	 * otherwise)`, or refuses the parse as PartialOperation (`lexical`). Its result has at most as many integer digits
	 * as the operand has bytes, and one fewer fraction digits. Admitted in contract predicates, row checks, generated
	 * fields and queries.
	 */
	parseDecimal<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<Decimal, PA, ComputedOrigin<OA>, "numeric">>
	/**
	 * Whether the text holds a match of the pattern, PostgreSQL's `~` (textregexeq), as a str.regex refinement holds
	 * one: the pattern is in grizzle's grammar under the flags "u", and `^` and `$` anchor it. The pattern is a string,
	 * which the grammar check reads at the type level as str.regex's does, or a text term that meets the subject's type,
	 * a contract's text only its own, whose every value the schema holds: a closed relation's text payload, `C.at(field, …)`, or a Compute.cond of such terms; every value is
	 * admitted inside PostgreSQL's regex compile space when the term is compiled, and any other term, which can be any
	 * text, is refused. A match is also a guard: Compute.when's branch receives its subject, which compilation reads as
	 * text of the pattern's language where the pattern is a string, and as it is where it is a term, whose values hold
	 * no one language, so the when is then a conditional over the match.
	 */
	matches<A extends TermBase | FirstValue, X, PA, OA, V, FA extends Facts, L, const B>(
		subject: A & First<A, [B]> & Term<X, PA, OA, "text", V, FA, L>,
		pattern: Fit<B, NoInfer<Meets<X, "text"> | string>> &
			(B extends string ? PatternValidate<B> : unknown)
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | string>, ValidPattern<B>]>,
		Guard<Term<X, PA, OA, "text", V, FA, L>, PA & P<B>, ComputedOrigin<OA | O<B>>>
	>

	/**
	 * double precision in [0, 2]; schema-qualified cosine_distance(a, b), never the <=> operator. The second operand is
	 * a vector term of the first's dimensions or a literal vector, which takes the first operand's type. The term states
	 * its operands' origins (Scored), which an approximate search reads to rank by it.
	 */
	cosineDistance<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "vector">,
		b: Fit<B, NoInfer<Operand<X, "vector">>>
	): Admitted<
		Binary<A, B, X, "vector", "vector">,
		Term<number, PA & P<B>, ComputedOrigin<OA | O<B>>, "double precision"> & Scored<OA, O<B>>
	>

	/**
	 * The set algebra over sets of one roster: the second operand is a set term of the first's roster, or a set value
	 * (Bits.of), which takes the first operand's type. union is a | b, intersection a & b, difference a & ~b; no
	 * complement is public, since ~a would hold the codes the roster has removed.
	 */
	union<A extends TermBase | FirstValue, X, PA, OA, V, L, const B>(
		a: A & First<A, [B]> & Term<X, PA, OA, "bits", V, Facts, L>,
		b: Fit<B, NoInfer<Operand<X, "bits", L>>>
	): Admitted<
		Binary<A, B, X, "bits", "bits", L>,
		Term<X, PA & P<B>, ComputedOrigin<OA | O<B>>, "bits", V, Facts, L>
	>
	intersection<A extends TermBase | FirstValue, X, PA, OA, V, L, const B>(
		a: A & First<A, [B]> & Term<X, PA, OA, "bits", V, Facts, L>,
		b: Fit<B, NoInfer<Operand<X, "bits", L>>>
	): Admitted<
		Binary<A, B, X, "bits", "bits", L>,
		Term<X, PA & P<B>, ComputedOrigin<OA | O<B>>, "bits", V, Facts, L>
	>
	difference<A extends TermBase | FirstValue, X, PA, OA, V, L, const B>(
		a: A & First<A, [B]> & Term<X, PA, OA, "bits", V, Facts, L>,
		b: Fit<B, NoInfer<Operand<X, "bits", L>>>
	): Admitted<
		Binary<A, B, X, "bits", "bits", L>,
		Term<X, PA & P<B>, ComputedOrigin<OA | O<B>>, "bits", V, Facts, L>
	>
	/** The count of a set's handles, bit_count. */
	cardinality<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "bits">
	): Admitted<TakesFirst<A, "bits">, Term<bigint, PA, ComputedOrigin<OA>, "bigint">>
	/** Whether every handle of a is one of b's: bit_count(a & ~b) = 0. */
	subset<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "bits">,
		b: Fit<B, NoInfer<Operand<X, "bits">>>
	): Admitted<
		Binary<A, B, X, "bits", "bits">,
		Term<boolean, PA & P<B>, ComputedOrigin<OA | O<B>>, "boolean">
	>
	/** Whether a and b share no handle: bit_count(a & b) = 0. */
	disjoint<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "bits">,
		b: Fit<B, NoInfer<Operand<X, "bits">>>
	): Admitted<
		Binary<A, B, X, "bits", "bits">,
		Term<boolean, PA & P<B>, ComputedOrigin<OA | O<B>>, "boolean">
	>
	/**
	 * The set over a closed id's roster holding exactly its handle: the empty set with the id's code's bit set,
	 * `set_bit`, the set Bits.of writes for that one handle. A NULL id, a closed read's at an absent key, gives a NULL
	 * set, as every operation of the algebra does. A handle's membership in a set is subset(singleton(id), set), which
	 * refuses a set over another roster.
	 */
	singleton<A extends TermBase | FirstValue, X, PA, OA, L>(
		id: A & FirstTerm<A> & Term<X, PA, OA, "code", unknown, Facts, L>
	): Admitted<TakesFirst<A, "code">, Term<SetOver<X, L>, PA, ComputedOrigin<OA>, "bits">>
}

/** The comparison and boolean helpers a row check sees beside its fields. */
export type ScalarHelpers = Pick<
	ComputeApi,
	| "eq"
	| "ne"
	| "lt"
	| "le"
	| "gt"
	| "ge"
	| "between"
	| "in"
	| "and"
	| "or"
	| "not"
	| "charLength"
	| "octetLength"
>
