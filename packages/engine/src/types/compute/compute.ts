import type { Brand } from "effect"
import type { Proving } from "#compiler/core/phantom.ts"
import type {
	ArithmeticSql,
	DivisorSql,
	EndpointSql,
	FloatSql,
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
import type { Sha256 } from "#compiler/scalar/values/sha256.ts"
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
	HasOrder,
	Holds,
	Literal,
	Operand,
	Precondition,
	Proves,
	RefinedEquality,
	RefinedTerm,
	Refutes,
	Scalar,
	Takes,
	TakesFirst,
	TakesRest,
	WholeTerm,
	WithinFacts
} from "#compiler/types/compute/scalar.ts"

import type { Pattern } from "#compiler/scalar/regex/pattern.ts"
import type {
	CallArgs,
	CalledTerm,
	CallFields,
	CallReads,
	CallSource,
	ExactCallArgs,
	RowFunction,
	RowsFunction,
	ValueFunction
} from "#compiler/types/compute/call.ts"
import type {
	BindMapParams,
	Carriers,
	ColumnFacts,
	ComputedOrigin,
	UnhostedOrigin,
	ConstantOrigin,
	Facts,
	InputTerm,
	LanguageOf,
	Meets,
	NegatesIn,
	NegationFree,
	NegationFreeEach,
	OperandOrigin,
	OriginOfTerm,
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
	ValueOfTerm,
	Zoned
} from "#compiler/types/core/phantom.ts"
import type {
	EqualityStates,
	MembershipStates,
	StatesOf,
	Stating
} from "#compiler/types/evidence/evidence.ts"
import type {
	Field,
	FieldBase,
	LiteralOf,
	NotInstant,
	NotRoster,
	NotStoredOnly
} from "#compiler/types/fields/field.ts"
import type { PatternValidate } from "#compiler/types/fields/regex.ts"
import type { FunctionType } from "#compiler/types/schema/function.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"
import type { TextQuery } from "#compiler/types/search/search.ts"
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

/**
 * Whether a divisor B is proved nonzero where a quotient over S needs it: a float's never does, since its quotient by
 * zero is defined.
 */
type NonzeroDivisor<S extends SqlTag, B> = [S] extends ["real" | "double precision"]
	? true
	: Proves<B, "nonzero">

/**
 * Whether every value of a term of SQL type S and host type V is finite by its type, as compilation's facts of a type
 * hold it (scalar/compute/typing.ts carrierFacts): an integer's, money's and an exact value's by their SQL types, and
 * numeric(p, 0)'s by its host type, a bigint (NumericHostOf), an integer type that holds no NaN, which grizzle refuses
 * at every door, and no infinity, which its typmod refuses. Any other numeric and a float may be NaN or infinite.
 */
type FiniteByType<S extends SqlTag, V> = [S] extends [InexactSql]
	? [S] extends ["numeric"]
		? [V] extends [never]
			? false
			: [V] extends [bigint]
				? true
				: false
		: false
	: true

/**
 * Whether a first operand a partial operation needs finite, of SQL type S, host type V, facts FX and value type LV
 * (Holds), is: finite by its type (FiniteByType), or proved so.
 */
type IsFinite<S extends SqlTag, V, FX extends Facts, LV> =
	FiniteByType<S, V> extends true ? true : Holds<FX, LV, "finite">

/**
 * Whether a cast's operand, of host type V, is as finite as its target needs: from numeric or a float into an integer
 * or money, finite by its type or proved so (IsFinite).
 */
type FiniteCast<S extends SqlTag, F extends SqlTag, V, FX extends Facts, LV> = [F] extends [
	"smallint" | "integer" | "bigint" | "money"
]
	? IsFinite<S, V, FX, LV>
	: true

/**
 * A guard's subject that its type does not already prove finite: a term finite by its type (FiniteByType) has no
 * SQL type the guard takes, so Num.isFinite refuses numeric(p, 0) as it refuses an integer, by its subject's type, and
 * compilation as MalformedDescription (scalar/compute/typing.ts constantGuardTests).
 */
type MayBeNonFinite<S extends SqlTag, V> =
	FiniteByType<S, V> extends true ? { readonly sql: never } : unknown

/**
 * The facts a cast keeps of its operand's, of host type V, as compilation keeps them (typing.ts keptFacts): none into a
 * float; every one from an integer, money or an exact value, finite among them by the operand's type; and the others
 * but nonzero from numeric or a float, whose rounding at a typmod no SQL type tells apart may reach zero, finite among
 * them from numeric(p, 0), by its type (FiniteByType).
 */
type CastFacts<S extends SqlTag, F extends SqlTag, V, FX extends Facts> = [F] extends [
	"real" | "double precision"
]
	? Facts
	: [S] extends ["smallint" | "integer" | "bigint" | "exact integer" | "money" | "exact money"]
		? FX & { readonly finite: true }
		: Omit<FX, "nonzero"> &
				Facts &
				(FiniteByType<S, V> extends true ? { readonly finite: true } : unknown)

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
 * keeps them (typing.ts negationFacts): finite and nonzero, each where the operand has it; never nonnegative, since -x is
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

/**
 * What a guard proves of its subject: the subject term, its facts with the guard's, and a constant's value (Literal).
 */
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
/**
 * Whether LEAST or GREATEST takes its first operand A, of type (X, S), and every other operand Bs, terms that meet it.
 */
type Extremes<A, Bs extends ReadonlyArray<unknown>, X, S extends SqlTag> = Every<
	[TakesFirst<A, OrderedSql>, TakesRest<Bs, ReadonlyArray<Meets<X, S>>>]
>
/**
 * LEAST's or GREATEST's first operand's own requirement: an order (HasOrder), stated where the call takes every operand
 * and they share one type, which the engine judges before it reads the common type's order.
 */
type ExtremeOrdered<A, Bs extends ReadonlyArray<unknown>, X, S extends SqlTag> = Precondition<
	Every<[Extremes<A, Bs, X, S>, OneType<S, Bs[number]>]>,
	HasOrder<A>,
	"a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles"
>
/**
 * An operand B's own requirement opposite A: its contract's refusal, where the operation takes both (ContractAdmits).
 */
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
		: Refusal<"operands of one type: an exact value beside a plain value of its family; Type.cast the exact one into the plain one's type">
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
/**
 * What stands opposite an equality's first operand A: what stands opposite any comparison's (Opposite), or a term B of
 * A's base carrier of another type, which the engine types at the carrier (types/compute/scalar.ts RefinedTerm).
 */
type Equated<A, B> =
	| Opposite<A>
	| (B extends RefinedTerm<A> ? (unknown extends RefinedEquality<A, B> ? B : never) : never)
/** Whether an equality takes its operands: a term first, and opposite it what it equates (Equated). */
type Equates<A, B> = Every<[TakesFirst<A, SqlTag>, Takes<B, Equated<A, B>>]>
/** Whether IN takes its first operand A, a term, and its list Vs, values of A's language. */
type Listed<A, Vs> = Every<
	[TakesFirst<A, SqlTag>, Takes<Vs, ReadonlyArray<LiteralOf<LanguageOf<A>>>>]
>
/** Whether BETWEEN takes its operands: a term of an ordered type first, and opposite it two operands (Opposite). */
type Between<A, Lo, Hi> = Every<
	[TakesFirst<A, OrderedSql>, Takes<Lo, Opposite<A>>, Takes<Hi, Opposite<A>>]
>
/**
 * The SQL types whose values are ordered: every one but a set's, whose bit string has no order in grizzle. A closed id
 * of a closed.unordered roster is of one, and has no order of its own (HasOrder).
 */
type OrderedSql = Exclude<SqlTag, "bits">
/**
 * An ordering's first operand: a term of an ordered type, never a set (OrderedSql), and, where the ordering takes its
 * other operands (Taken), a term with an order (HasOrder): a closed id of a closed.unordered roster is refused by
 * OrderedOperand's refusal (types/compute/scalar.ts), which the engine states once it has every operand.
 */
type Ordered<A, Taken extends boolean> = [SqlOfTerm<A>] extends ["bits"]
	? never
	: Precondition<
			Taken,
			HasOrder<A>,
			"a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles"
		>
/** Whether an ordering compares its first operand A with B: A of an ordered type with an order, and B opposite it. */
type Orders<A, B> = Every<[Compares<A, B, OrderedSql>, HasOrder<A>]>

/**
 * The scalar catalogue: PostgreSQL's scalar operators, functions and casts, in thirteen namespaces, each member in the
 * one whose domain it reads: Type (constants, contracts and casts), Num (the numeric family), Logic (comparisons,
 * connectives and conditionals over any type), Range (a span's endpoints), Text, Xml (XML Schema's pattern dialect),
 * Crypto, Distance (over vectors), Search (text search documents and queries), Bits (the set algebra), Net (the network
 * types' containment), Time (zones' wall clocks and epoch days) and Fn (declared functions). Each is the runtime
 * builders of packages/engine/src/scalar/compute bound to its public signature here (TypeApi, NumApi, LogicApi, RangeApi,
 * TextApi, XmlApi, CryptoApi, DistanceApi, SearchApi, BitsApi, NetApi, TimeApi, FnApi) by the public barrels
 * public/compute.ts and public/fields.ts (Bits, beside Bits.of); what follows holds of all thirteen.
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
 * test/unit/compute pins the runtime behavior each signature promises, the catalogue's population
 * (test/support/agreement/compute.ts) the signatures against the engine.
 *
 * The first, Type: a typed constant of a descriptor's type, a contract dropped to its base, and a checked cast.
 */
export interface TypeApi {
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
		type: Field<H, S, D, F> &
			([S] extends ["code"] ? NotRoster : unknown) &
			NotStoredOnly<S> &
			NotInstant<D>,
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
				"PostgreSQL has no cast between these types that grizzle admits"
			> &
			Precondition<
				Casts<A, X, S, D, F>,
				FiniteCast<S, F, ValueOfTerm<A>, FX, LX>,
				"a value proved finite: guard it with Logic.when(Num.isFinite(x), (x) => …, otherwise)"
			>,
		to: Field<H, F, D> & NotInstant<D>
	): Admitted<
		Casts<A, X, S, D, F>,
		Term<D, PA, ComputedOrigin<OA>, F, H, CastFacts<S, F, ValueOfTerm<A>, FX>>
	>
}

/**
 * The Num namespace: arithmetic, rounding and the numeric functions over the numeric family, and the guards over it.
 */
export interface NumApi {
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
		Term<
			Decimal,
			PA,
			UnhostedOrigin<OA>,
			"numeric",
			Decimal,
			CastFacts<S, "numeric", ValueOfTerm<A>, FX>
		>
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
	 * nonzero, except a float's, whose quotient by zero is the infinity of the dividend's sign, NaN over a zero or NaN
	 * dividend, whichever zero divides.
	 */
	div<A extends TermBase | FirstValue, X, PA, OA, S extends NumericSql, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Operand<X, S>>> &
			ValueAt<A, B, X, S, NumericSql> &
			Precondition<
				Reads<A, B, X, S, NumericSql>,
				NonzeroDivisor<S, B>,
				"a divisor proved nonzero: guard it with Logic.when(Num.nonzero(x), (x) => …, otherwise)"
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
				"a divisor proved nonzero: guard it with Logic.when(Num.nonzero(x), (x) => …, otherwise)"
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
				"a divisor proved nonzero: guard it with Logic.when(Num.nonzero(x), (x) => …, otherwise)"
			>
	): Admitted<
		Reads<A, B, X, "numeric", "numeric">,
		Term<Decimal, PA & P<B>, UnhostedOrigin<OA | O<B>>, "numeric">
	>
	rem<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "numeric">,
		b: Fit<B, NoInfer<Operand<X, "numeric">>> &
			ValueAt<A, B, X, "numeric", "numeric"> &
			Precondition<
				Reads<A, B, X, "numeric", "numeric">,
				Proves<B, "nonzero">,
				"a divisor proved nonzero: guard it with Logic.when(Num.nonzero(x), (x) => …, otherwise)"
			>
	): Admitted<
		Reads<A, B, X, "numeric", "numeric">,
		Term<Decimal, PA & P<B>, UnhostedOrigin<OA | O<B>>, "numeric">
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
		Term<Decimal, PA, UnhostedOrigin<OA>, "numeric">
	>
	trunc<A extends TermBase | FirstValue, X, PA, OA, const Sc = number>(
		a: A & First<A, [Sc]> & InputTerm<X, PA, OA, "numeric">,
		scale?: Fit<Sc, NoInfer<number>>
	): Admitted<
		Every<[TakesFirst<A, "numeric">, Takes<Sc, number>]>,
		Term<Decimal, PA, UnhostedOrigin<OA>, "numeric">
	>
	ceil<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">
	): Admitted<TakesFirst<A, "numeric">, Term<Decimal, PA, UnhostedOrigin<OA>, "numeric">>
	floor<A extends TermBase | FirstValue, X, PA, OA>(
		a: A & FirstTerm<A> & InputTerm<X, PA, OA, "numeric">
	): Admitted<TakesFirst<A, "numeric">, Term<Decimal, PA, UnhostedOrigin<OA>, "numeric">>
	/** Integer and numeric; over smallint they are the integer forms cast back. */
	gcd<A extends TermBase | FirstValue, X, PA, OA, S extends IntegralSql, B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Meets<X, S>>>
	): Admitted<
		Every<[TakesFirst<A, IntegralSql>, Takes<B, Meets<X, S>>]>,
		Term<PlainHost[DivisorSql[S]], PA & P<B>, UnhostedOrigin<OA | O<B>>, DivisorSql[S]>
	>
	lcm<A extends TermBase | FirstValue, X, PA, OA, S extends IntegralSql, B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, S>,
		b: Fit<B, NoInfer<Meets<X, S>>>
	): Admitted<
		Every<[TakesFirst<A, IntegralSql>, Takes<B, Meets<X, S>>]>,
		Term<PlainHost[DivisorSql[S]], PA & P<B>, UnhostedOrigin<OA | O<B>>, DivisorSql[S]>
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
				"a power's base proved nonnegative, and nonzero or its exponent nonnegative: guard it with Logic.when(Num.positive(x), (x) => …, otherwise)"
			>,
		b: Fit<B, NoInfer<Operand<X, S>>> & ValueAt<A, B, X, S, PowerSql>
	): Admitted<
		Reads<A, B, X, S, PowerSql>,
		Term<PlainHost[S], PA & P<B>, UnhostedOrigin<OA | O<B>>, S>
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
				"a radicand proved nonnegative: guard it with Logic.when(Num.nonnegative(x), (x) => …, otherwise)"
			>
	): Admitted<TakesFirst<A, PowerSql>, Term<PlainHost[S], PA, UnhostedOrigin<OA>, S>>
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
				IsFinite<"numeric", ValueOfTerm<AX>, FXX, LXX>,
				"a value proved finite: guard it with Logic.when(Num.isFinite(x), (x) => …, otherwise)"
			>,
		low: AL &
			FirstAmong<AL, "numeric", [AX, AH, C], [AH]> &
			InputTerm<XL, PL, OL, "numeric"> &
			Proving<FXL> &
			Literal<LXL> &
			Precondition<
				Buckets<AX, AL, AH, C>,
				IsFinite<"numeric", ValueOfTerm<AL>, FXL, LXL>,
				"a value proved finite: guard it with Logic.when(Num.isFinite(x), (x) => …, otherwise)"
			>,
		high: AH &
			First<AH, [AX, AL, C]> &
			InputTerm<XH, PH, OH, "numeric"> &
			Proving<FXH> &
			Literal<LXH> &
			Precondition<
				Buckets<AX, AL, AH, C>,
				IsFinite<"numeric", ValueOfTerm<AH>, FXH, LXH>,
				"a value proved finite: guard it with Logic.when(Num.isFinite(x), (x) => …, otherwise)"
			>,
		count: Fit<C, NoInfer<Meets<number, SqlTag>>>
	): Admitted<
		Buckets<AX, AL, AH, C>,
		Term<number, PX & PL & PH & P<C>, UnhostedOrigin<OX | OL | OH | O<C>>, "integer">
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
				IsFinite<"numeric", ValueOfTerm<A>, FA, LA>,
				"a value proved finite: guard it with Logic.when(Num.isFinite(x), (x) => …, otherwise)"
			>
	): Admitted<TakesFirst<A, "numeric">, Term<number, PA, UnhostedOrigin<OA>, "integer">>

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
	/**
	 * A guard that its subject, numeric or a float, is finite, testing exactly the values its type holds that are not:
	 * `x > -Infinity AND x < Infinity` of a float or a numeric of no typmod, `x <> 'NaN'` of numeric(p, s), whose typmod
	 * holds no infinity. numeric(p, 0), finite by its type (FiniteByType), is no subject of it, as an integer is not.
	 */
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
		x: A & FirstTerm<A> & Term<X, PA, OA, S, V, FA, L> & Literal<LX> & MayBeNonFinite<S, V>
	): Admitted<
		Every<[TakesFirst<A, InexactSql>, Not<FiniteByType<S, V>>]>,
		GuardOver<X, PA, OA, S, V, FA, L, LX, { readonly finite: true }>
	>
	/**
	 * A guard that its subject lies within two finite literal bounds: `x BETWEEN low AND high`. It proves the subject
	 * finite, nonnegative from a low bound at or above zero, and nonzero from bounds on one side of zero (WithinFacts);
	 * compilation reads the bounds too, for the preconditions that rest on magnitudes (a narrowing's range, a power's, a
	 * bucket's): Logic.when(Num.within(x, 0n, 1000n), (x) => Num.power(x, 2n), 0n). Over a contract a bound is a
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
	/**
	 * A float's identity image: float8send's 8 bytes, the bits of its IEEE 754 binary64 encoding, read as a signed
	 * bigint, a real widened exactly to double precision first, every NaN in one form (0x7ff8000000000000), as Java's
	 * doubleToLongBits reads them; `floatBits(value)` is the same function on the host. Two floats have one image
	 * exactly when they are one value: -0 and 0 differ, where Logic.eq holds them equal. IMMUTABLE and defined on
	 * every float, it stands in row checks, selections, generated fields and queries, so a key over a float by identity
	 * is a key over its image: a stated `bits: pg.bigint` in the key, held by `check(name, R, (r) => r.eq(r.bits,
	 * Num.floatBits(r.value)))`, the float kept beside it for reads by `=`.
	 */
	floatBits<A extends TermBase | FirstValue, X, PA, OA, S extends FloatSql>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): Admitted<TakesFirst<A, FloatSql>, Term<bigint, PA, ComputedOrigin<OA>, "bigint">>
}

/**
 * The Logic namespace: the comparisons, LEAST and GREATEST, the connectives and the conditionals, over any type they
 * order or compare.
 */
export interface LogicApi {
	/**
	 * LEAST and GREATEST return an operand unchanged, so they keep the first operand's type, contract and roster
	 * included, and deliver any operand's values; every other operand is a term of that type. An exact value and a
	 * plain one of its family share none, in either order (SharesType): PostgreSQL widens the plain one, grizzle asks
	 * for Type.cast of the exact one into the plain one's type.
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
		first: A & First<A, Bs> & Term<X, PA, OA, S, V, Facts, L> & ExtremeOrdered<A, Bs, X, S>,
		...rest: Bs &
			NoInfer<ReadonlyArray<Meets<X, S>>> &
			NoInfer<{ readonly [K in keyof Bs]: SharesType<Extremes<A, Bs, X, S>, S, Bs[K]> }>
	): Admitted<
		Every<[Extremes<A, Bs, X, S>, OneType<S, Bs[number]>, HasOrder<A>]>,
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
		first: A & First<A, Bs> & Term<X, PA, OA, S, V, Facts, L> & ExtremeOrdered<A, Bs, X, S>,
		...rest: Bs &
			NoInfer<ReadonlyArray<Meets<X, S>>> &
			NoInfer<{ readonly [K in keyof Bs]: SharesType<Extremes<A, Bs, X, S>, S, Bs[K]> }>
	): Admitted<
		Every<[Extremes<A, Bs, X, S>, OneType<S, Bs[number]>, HasOrder<A>]>,
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
	 * The first branch, a term and never a parameter or a JavaScript value (FirstTerm), types the conditional, contract
	 * and roster included; the other is a term that meets its type (a parameter among them) or a literal of it, and the
	 * conditional delivers either's values. An exact value and a plain one of its family share no type, in either order
	 * (SharesType): PostgreSQL widens the plain branch, grizzle asks for Type.cast of the exact one into the plain
	 * one's type. A boolean field is a predicate here, so
	 * r.sum(Logic.cond(passed, Type.literal(pg.integer, 1), 0)) is a conditional count.
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
	 * type-checks inside the branch and nowhere else, and only over the parameter: the subject read past it, a term the
	 * branch captures, keeps its own facts, as compilation reads it; the otherwise branch, a term that meets the
	 * branch's type or a literal of it, is the caller's value where the guard fails: Logic.when(Num.nonzero(b),
	 * (b) => Num.div(a, b), 0n). The subject is read off the guard itself, so a guard its builder refused, never (Admitted), hands the
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
		b: Fit<B, NoInfer<Equated<A, B>>> & ContractAdmits<Equates<A, B>, ColumnFacts<A>, B>
	): Admitted<
		Every<[Equates<A, B>, Not<RefutedAt<A, B>>]>,
		Compared<A, B> & Stating<EqualityStates<A, B>>
	>
	ne<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, SqlTag>, ColumnFacts<A>, B>
	): Admitted<Every<[Compares<A, B, SqlTag>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	lt<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A, Compares<A, B, OrderedSql>>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Orders<A, B>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	le<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A, Compares<A, B, OrderedSql>>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Orders<A, B>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	gt<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A, Compares<A, B, OrderedSql>>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Orders<A, B>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	ge<A extends TermBase | FirstValue, const B>(
		a: A & First<A, [B]> & Ordered<A, Compares<A, B, OrderedSql>>,
		b: Fit<B, NoInfer<Opposite<A>>> & ContractAdmits<Compares<A, B, OrderedSql>, ColumnFacts<A>, B>
	): Admitted<Every<[Orders<A, B>, Not<RefutedAt<A, B>>]>, Compared<A, B>>
	between<A extends TermBase | FirstValue, const Lo, const Hi>(
		a: A & First<A, [Lo, Hi]> & Ordered<A, Between<A, Lo, Hi>>,
		low: Fit<Lo, NoInfer<Opposite<A>>> & ContractAdmits<Between<A, Lo, Hi>, ColumnFacts<A>, Lo>,
		high: Fit<Hi, NoInfer<Opposite<A>>> & ContractAdmits<Between<A, Lo, Hi>, ColumnFacts<A>, Hi>
	): Admitted<
		Every<[Between<A, Lo, Hi>, HasOrder<A>, Not<RefutedAt<A, Lo | Hi>>]>,
		Predicate<P<A> & P<Lo> & P<Hi>, ComputedOrigin<O<A> | O<Lo> | O<Hi>>>
	>
	/**
	 * The list is read as it is written (Fit), every member a value of the first operand's language, so a member of
	 * another type refuses the list as one argument; over a refused first operand it states nothing. In a rule's where,
	 * over a roster variable, it keeps the variable to the handles it lists, as r.in does (evidence/evidence.ts
	 * MembershipStates).
	 */
	in<A extends TermBase | FirstValue, const Vs>(
		a: A & FirstTerm<A>,
		values: AnyRefused<[A]> extends true
			? Vs
			: Fit<Vs, NoInfer<ReadonlyArray<LiteralOf<LanguageOf<A>>>>> &
					ContractAdmits<Listed<A, Vs>, ColumnFacts<A>, MembersOf<Vs>>
	): Admitted<
		Every<[Listed<A, Vs>, Not<RefutedAt<A, MembersOf<Vs>>>]>,
		Predicate<P<A>, ComputedOrigin<O<A>>> & Stating<MembershipStates<A, MembersOf<Vs>>>
	>
}

/** The Range namespace: a span's endpoints and width. */
export interface RangeApi {
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
}

/**
 * The Text namespace: text's lengths, concatenation, prefixes, suffixes and containment, patterns in grizzle's grammar
 * and their matches, transforms, references and lexical parses.
 */
export interface TextApi {
	/** char_length; admitted only in contract predicates and row checks, never in a query. */
	charLength<A extends TermBase | FirstValue, X, PA, OA>(
		s: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Scalar<number, PA, ComputedOrigin<OA>, "integer">>
	/**
	 * octet_length, the text's UTF-8 bytes, total, so admitted everywhere, a query included. A contract's octetLength
	 * bound bounds the text's bytes in a key exactly, and a guard on it, `Logic.when(Num.within(Text.octetLength(x),
	 * 0, bytes), (n) => ..., otherwise)`, bounds x's bytes in its branch, which is how a query reads an unbounded text by
	 * Text.matches or Text.translate.
	 */
	octetLength<A extends TermBase | FirstValue, X, PA, OA>(
		s: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Scalar<number, PA, ComputedOrigin<OA>, "integer">>
	/**
	 * A text's UTF-16 code units, JavaScript's String.length: its code points, and its supplementary ones once more,
	 * `char_length(x) + regexp_count(x, '[\U00010000-\U0010FFFF]')`; admitted only in contract predicates and row
	 * checks, never in a query. PostgreSQL's regex engine reads at most 268,435,454 bytes, so the text is bounded within
	 * them by its type or by a guard, `Logic.when(Num.within(Text.octetLength(x), 0, bytes), (x) =>
	 * Text.utf16Length(x), otherwise)`, or the operation is PartialOperation (`bounded`), and no law that reads it
	 * raises on a long text. A UTF-16 code unit is at most three UTF-8 bytes, so a text of more than 3n bytes is more than
	 * n units.
	 */
	utf16Length<A extends TermBase | FirstValue, X, PA, OA>(
		s: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Scalar<number, PA, ComputedOrigin<OA>, "integer">>
	/**
	 * a || b, PostgreSQL's textcat: text of no pattern, which compilation reads within a's bytes and b's where both are
	 * bounded, a string by its own. The second operand is a text term the first meets, a parameter among them, or a
	 * string. Admitted in contract predicates, row checks, generated fields and folds; in a query wherever a's and b's
	 * types bound its bytes within the most one varlena holds, a query's head among them, since it allocates its
	 * result, which PostgreSQL refuses past 1 GB, and a read never fails on a value; and over any texts as a side of
	 * Logic.eq or Logic.ne, which is decided as t's equality with the concatenation built only where its bytes are
	 * within that bound; past it the lengths decide it false. So a probe reads t by its key. Concatenations nested in
	 * that side are its parts, read in order: `Logic.eq(t, Text.concat(Text.concat(a, b), c))` is t against a, b and c
	 * built in order, in a query as in a check.
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
	 * Whether haystack holds needle, its characters together: `strpos(haystack, needle) > 0`. No pattern: the needle is
	 * read as its characters, `%`, `_` and `\` among them, so nothing is escaped, and the empty needle is in every text.
	 * The second operand is a text term the first meets, a parameter among them, or a string. Defined on every pair of
	 * texts, so it stands in a query as in a check; a query filters by it, reading no index for it and drafting none. It
	 * folds no case: `Text.contains(Text.lowerAscii(name), Text.lowerAscii(term))` folds A to Z on both sides, and no
	 * other letter.
	 */
	contains<A extends TermBase | FirstValue, X, PA, OA, const B>(
		haystack: A & First<A, [B]> & InputTerm<X, PA, OA, "text">,
		needle: Fit<B, NoInfer<Meets<X, "text"> | string>>
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
	 * term is refused as one only beside two strings. from and to are read as every operand is (Fit): a literal keeps
	 * its type, and a string TypeScript types as string, a map computed at run time, is a string here too, whose values
	 * compilation judges as a literal map's.
	 */
	translate<A extends TermBase | FirstValue, X, PA, OA, const Fr, const To>(
		x: A &
			(Every<[Takes<Fr, string>, Takes<To, string>]> extends true ? FirstTerm<A> : unknown) &
			InputTerm<X, PA, OA, "text">,
		from: Fit<Fr, string>,
		to: Fit<To, string>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<Fr, string>, Takes<To, string>]>,
		Term<string, PA, ComputedOrigin<OA>, "text">
	>
	/**
	 * ASCII's case fold, translate(x, "A…Z", "a…z"): only the 26 capitals lower, every other character, a non-ASCII
	 * letter included, stays, so the fold is one map whatever the collation, as an IMMUTABLE expression needs, and
	 * compilation reads the result within x's byte bound. PostgreSQL computes it as lower under the C collation, which
	 * allocates x's own length, so it folds any text, in a query as in a check or a generated field.
	 */
	lowerAscii<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<string, PA, ComputedOrigin<OA>, "text">>
	/**
	 * XML Schema's whiteSpace replace: translate(x, "\t\n\r", "   "), tab, LF and CR each a space, as Text.translate
	 * is admitted, and within x's byte bound.
	 */
	replaceWhitespace<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<string, PA, ComputedOrigin<OA>, "text">>
	/**
	 * XML Schema's whiteSpace collapse: each run of tab, LF, CR and space one space, and none at either end, by
	 * PostgreSQL's replace and btrim, IMMUTABLE and defined on every text. Compilation reads the result as text of a
	 * language holding its values within x's length and byte bounds, which it never lengthens: exactly the image of x's
	 * where it is cheap to state, and otherwise more. Admitted in contract predicates, row checks, generated fields and
	 * queries, over any text.
	 */
	collapse<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<string, PA, ComputedOrigin<OA>, "text">>
	/**
	 * The target of `reference` resolved against `base`, RFC 3986 §5.2's strict transformation and §5.3's
	 * recomposition: the reference's components where it states them and the base's where it does not, its path merged
	 * with the base's and its dot segments removed, as @bjornpagen/grizzle-text/uri resolveReference computes it, which
	 * the host evaluates by. Text of no pattern, which compilation reads within the operands' bytes and one more where
	 * both are bounded. PostgreSQL computes it by a function of grizzle's library the installation installs where its
	 * schema calls it, defined on every pair of texts. Admitted in contract predicates, row checks and generated fields;
	 * in a query only over texts whose types bound the target within 1 GB, since it is built by concatenation, which
	 * PostgreSQL refuses past 1 GB, and a read never fails on a value. The reference is a text term the base meets, a
	 * parameter among them, or a string.
	 */
	resolveReference<A extends TermBase | FirstValue, X, PA, OA, const B>(
		base: A & First<A, [B]> & InputTerm<X, PA, OA, "text">,
		reference: Fit<B, NoInfer<Meets<X, "text"> | string>>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | string>]>,
		Term<string, PA & P<B>, ComputedOrigin<OA | O<B>>, "text">
	>
	/**
	 * `x` before its first character among `chars`, all of x where it holds none, as @bjornpagen/grizzle-text/text
	 * cutBefore computes it, which the host evaluates by: `Text.cutBefore(href, "?#")` is an href's path, the text up to
	 * its query or fragment. Characters are code points, as PostgreSQL's strpos and left count them, and each character of
	 * chars is one member of the set, so a chars of none cuts nowhere. Text of no pattern, which compilation reads within
	 * x's bytes. PostgreSQL computes it by a function of grizzle's library the installation installs where its schema
	 * calls it, which allocates at most x's own bytes, so it is defined on every pair of texts, in a query as in a check
	 * or a generated field. chars is a text term x meets, a parameter among them, or a string.
	 */
	cutBefore<A extends TermBase | FirstValue, X, PA, OA, const B>(
		x: A & First<A, [B]> & InputTerm<X, PA, OA, "text">,
		chars: Fit<B, NoInfer<Meets<X, "text"> | string>>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | string>]>,
		Term<string, PA & P<B>, ComputedOrigin<OA | O<B>>, "text">
	>
	/**
	 * `x` from its first character among `chars` on, that character included, the empty text where it holds none, as
	 * @bjornpagen/grizzle-text/text cutFrom computes it: the rest of Text.cutBefore's cut, so `Text.cutFrom(href, "?#")`
	 * is an href's query and fragment and the two concatenate to x. Typed, lowered and admitted as Text.cutBefore is.
	 */
	cutFrom<A extends TermBase | FirstValue, X, PA, OA, const B>(
		x: A & First<A, [B]> & InputTerm<X, PA, OA, "text">,
		chars: Fit<B, NoInfer<Meets<X, "text"> | string>>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | string>]>,
		Term<string, PA & P<B>, ComputedOrigin<OA | O<B>>, "text">
	>
	/**
	 * `x` with every occurrence of `from` replaced by `to`, PostgreSQL's replace: x read left to right, each occurrence
	 * not overlapping the one before it, x itself where from is empty, so `Text.replace(Text.replace(name, "%", "%25"),
	 * "?", "%3F")` writes an entry's name as a URI path segment, one character by several. Characters are code points
	 * and texts compare exactly, as pg_c_utf8 does. Text of no pattern, which compilation reads within x's bytes and
	 * what each occurrence of from adds where x's and to's are bounded, a string by its own. It allocates its result,
	 * which PostgreSQL refuses past 1 GB, so a query holds it only where that bound is within the most bytes one varlena
	 * holds, and a check or generated field over longer texts fails its write. from and to are text terms x meets,
	 * parameters among them, or strings.
	 */
	replace<A extends TermBase | FirstValue, X, PA, OA, const B, const C>(
		x: A & First<A, [B, C]> & InputTerm<X, PA, OA, "text">,
		from: Fit<B, NoInfer<Meets<X, "text"> | string>>,
		to: Fit<C, NoInfer<Meets<X, "text"> | string>>
	): Admitted<
		Every<
			[
				TakesFirst<A, "text">,
				Takes<B, Meets<X, "text"> | string>,
				Takes<C, Meets<X, "text"> | string>
			]
		>,
		Term<string, PA & P<B> & P<C>, ComputedOrigin<OA | O<B> | O<C>>, "text">
	>
	/**
	 * The double a decimal text names, IEEE 754-2019's conversion from decimal character sequences: the text's exact
	 * value rounded to the nearest double, ties to even, ±Infinity past the greatest finite double and a zero of the
	 * mantissa's sign below half the least subnormal; `INF`, `-INF` and `NaN` name themselves. Its text is
	 * `doubleText`, XML Schema 1.0's xs:double lexical space, of any digits and any exponent:
	 * compilation proves the operand's pattern lies inside it, or refuses the parse as PartialOperation (`lexical`),
	 * remedied by `Logic.when(Text.matches(x, doubleText), (x) => Text.parseDouble(x), otherwise)`. Admitted
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
	 * pattern lies inside it and its bytes within them, by its type (`str.bytes(16384, str.regex(decimalText.source))` or a
	 * refinement of it) or by guards, `Logic.when(Text.matches(x, decimalText), (x) =>
	 * Logic.when(Num.within(Text.octetLength(x), 0, 16384), () => Text.parseDecimal(x), otherwise),
	 * otherwise)`, or refuses the parse as PartialOperation (`lexical`). Its result has at most as many integer digits
	 * as the operand has bytes, and one fewer fraction digits. Admitted in contract predicates, row checks, generated
	 * fields and queries.
	 */
	parseDecimal<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<Decimal, PA, ComputedOrigin<OA>, "numeric">>
	/**
	 * A pattern for Text.matches: `source` in grizzle's grammar under the flags "u", which the grammar check reads at
	 * the type level as str.regex's does, admitted once, here, inside PostgreSQL's regex compile space and matched by
	 * some text, so a refused source throws where it is written and every match over the pattern reads its admission.
	 * doubleText, decimalText and lexicalForm(T) are grizzle's own.
	 */
	pattern<const S extends string>(source: PatternValidate<S>): Pattern<S>
	/**
	 * Whether the text holds a match of the pattern, PostgreSQL's `~` (textregexeq), as a str.regex refinement holds
	 * one: the pattern is in grizzle's grammar under the flags "u", and `^` and `$` anchor it. The pattern is a Pattern,
	 * Text.pattern(source), admitted where it was made, or a text term that meets the subject's type, a contract's
	 * text only its own, whose every value the schema holds: a closed relation's text payload, `C.at(field, …)`, or a
	 * Logic.cond of such terms; every value is admitted inside PostgreSQL's regex compile space when the term is
	 * compiled, and any other term, which can be any text, is refused. A string is no pattern. A match is also a guard:
	 * Logic.when's branch receives its subject, which compilation reads as text of the pattern's language where the
	 * pattern is a Pattern, and as it is where it is a term, whose values hold no one language, so the when is then a
	 * conditional over the match. In a query the subject's bytes are proved within the 268,435,454 PostgreSQL's regex
	 * engine reads, by its type or by a guard whose branch the match stands in, `Logic.when(Num.within(
	 * Text.octetLength(x), 0, bytes), () => Text.matches(x, p), false)`, which lowers to CASE, so PostgreSQL reads
	 * the match only where the guard holds; the answer past the bound is the program's own.
	 */
	matches<A extends TermBase | FirstValue, X, PA, OA, V, FA extends Facts, L, const B>(
		subject: A & First<A, [B]> & Term<X, PA, OA, "text", V, FA, L>,
		pattern: Fit<B, NoInfer<Meets<X, "text"> | Pattern>>
	): Admitted<
		Every<[TakesFirst<A, "text">, Takes<B, Meets<X, "text"> | Pattern>]>,
		Guard<Term<X, PA, OA, "text", V, FA, L>, PA & P<B>, ComputedOrigin<OA | O<B>>>
	>
}

/**
 * The Xml namespace: XML Schema 1.0's pattern dialect, a pattern facet written in it and the test that a text is one.
 */
export interface XmlApi {
	/**
	 * Whether x is an XML Schema 1.0 pattern, a string of Appendix F's regExp production, as grizzle-text's reader of
	 * that grammar reads it (regex/xsd.ts xsdPattern): groups and class subtractions nested to any depth and counts of any
	 * size, refused at a construct Appendix F does not define (`(?`, a back-reference, an unclosed `[` or `(`, a `{`
	 * that opens no count) or a category or block its tables do not name. PostgreSQL judges it by a function of grizzle's
	 * library, the reader's moves as a table its recursive query reads once over the text's characters, so the law holds
	 * in a contract predicate, a row check, a generated field and a query alike, on every text.
	 */
	isPattern<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, Term<boolean, PA, ComputedOrigin<OA>, "boolean">>
	/**
	 * A pattern for Text.matches written in XML Schema 1.0's dialect, a pattern facet (Part 2, Appendix F): read by
	 * grizzle's one front end of that dialect, anchored at both ends as XML Schema reads every facet, its `\\i` and `\\c` XML
	 * 1.0 Second Edition's name characters and its alphabet XML's Char, printed in grizzle's grammar, which the
	 * Pattern's source holds, and admitted as Text.pattern admits one, so a refused facet throws where it is written.
	 */
	pattern(source: string): Pattern
}

/** The Crypto namespace: a value's SHA-256 digest. */
export interface CryptoApi {
	/**
	 * The SHA-256 digest of a bytes value, or of a text's UTF-8 bytes: its 32 bytes, a sha256 value (public/fields.ts
	 * sha256, Sha256), `sha256(x)`, the one operation that reads a bytes value, read whole. IMMUTABLE and defined on every
	 * value, it stands in row checks, selections, generated fields and queries: `generated(sha256, Crypto.sha256(row.body))`
	 * is a field whose every value PostgreSQL computes from the text it stores, which a key may hold where the text is
	 * past any index entry, and `Crypto.sha256(row.content)` the digest of a bytes value.
	 */
	sha256<A extends TermBase | FirstValue, X, PA, OA>(
		x: A & WholeTerm<A> & InputTerm<X, PA, OA, "bytea" | "text">
	): Admitted<TakesFirst<A, "bytea" | "text">, Term<Sha256, PA, ComputedOrigin<OA>, "sha256">>
}

/** The Distance namespace: the distance between two vectors. */
export interface DistanceApi {
	/**
	 * double precision in [0, 2]; schema-qualified cosine_distance(a, b), never the <=> operator. The second operand is
	 * a vector term of the first's dimensions or a literal vector, which takes the first operand's type. The term states
	 * its operands' origins (Scored), which an approximate search reads to rank by it.
	 */
	cosine<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, "vector">,
		b: Fit<B, NoInfer<Operand<X, "vector">>>
	): Admitted<
		Binary<A, B, X, "vector", "vector">,
		Term<number, PA & P<B>, UnhostedOrigin<OA | O<B>>, "double precision"> & Scored<OA, O<B>>
	>
}

/**
 * The Search namespace: a text search query made under a document's configuration, a document's match of one and its
 * ranks.
 */
export interface SearchApi {
	/**
	 * A query of full text search over a text term, read by websearch_to_tsquery: the syntax of a web search engine,
	 * quoted phrases, `or` and a leading `-` for not, which never raises on a text. It is no term: a match or a rank
	 * reads it, parsing its text under the configuration of the document it meets, so no query is read under another.
	 * In a query its text is bounded within textQueryMaxBytes by its type or a byte guard.
	 */
	websearch<A extends TermBase | FirstValue, X, PA, OA>(
		text: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, TextQuery<PA, OA>>
	/** A query of full text search over a text term, read by plainto_tsquery: every word of it required. */
	plain<A extends TermBase | FirstValue, X, PA, OA>(
		text: A & FirstTerm<A> & InputTerm<X, PA, OA, "text">
	): Admitted<TakesFirst<A, "text">, TextQuery<PA, OA>>
	/**
	 * Whether a search document matches a query, `d @@ websearch_to_tsquery('<configuration>', q)` or plainto_tsquery's,
	 * the configuration the document's own. PostgreSQL alone computes it, so a contract predicate, a row check and a
	 * generated field refuse it; a query's filter over a stored document is what a GIN index serves.
	 */
	matches<A extends TermBase | FirstValue, X, PA, OA, Q extends TextQuery<never>>(
		document: A & FirstTerm<A> & InputTerm<X, PA, OA, "tsvector">,
		query: Q
	): Admitted<
		TakesFirst<A, "tsvector">,
		Predicate<PA & ParamsOfTerm<Q>, UnhostedOrigin<OA | OriginOfTerm<Q>>>
	>
	/**
	 * A search document's rank for a query, ts_rank(d, q) in its two-argument form, PostgreSQL's default weights (A 1.0,
	 * B 0.4, C 0.2, D 0.1) and no normalization, a real, the query parsed under the document's configuration.
	 */
	rank<A extends TermBase | FirstValue, X, PA, OA, Q extends TextQuery<never>>(
		document: A & FirstTerm<A> & InputTerm<X, PA, OA, "tsvector">,
		query: Q
	): Admitted<
		TakesFirst<A, "tsvector">,
		Term<number, PA & ParamsOfTerm<Q>, UnhostedOrigin<OA | OriginOfTerm<Q>>, "real">
	>
	/** A search document's cover density rank for a query, ts_rank_cd(d, q), as textRank's. */
	rankCd<A extends TermBase | FirstValue, X, PA, OA, Q extends TextQuery<never>>(
		document: A & FirstTerm<A> & InputTerm<X, PA, OA, "tsvector">,
		query: Q
	): Admitted<
		TakesFirst<A, "tsvector">,
		Term<number, PA & ParamsOfTerm<Q>, UnhostedOrigin<OA | OriginOfTerm<Q>>, "real">
	>
}

/**
 * The Bits namespace's set algebra over sets of one roster's handles, beside Bits.of, the set value (public/fields.ts).
 */
export interface BitsApi {
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

/**
 * The Time namespace: a zone's wall clock at an instant by PostgreSQL's tzdata, and a date's epoch day and the date of
 * one, the integers a calendar's arithmetic is written over: a local day of the week is (epochDay + 4) mod 7, 1970-01-01
 * a Thursday, and a local wall clock's instant is a guess less the zone's offset at it (README "Time zones").
 */
export interface TimeApi {
	/**
	 * The zone's wall clock at an instant, both in milliseconds, the instant's since the Unix epoch and the wall clock's
	 * since the local epoch, 1970-01-01 00:00 on the zone's clock, as PostgreSQL's tzdata reads the zone: a bigint term,
	 * a millis reading of the database's clock among them (clocked(program, { now: "millis" })), never an instant, which
	 * counts microseconds; and a closed id of a zone roster (closed.zones), whose handle is the zone's IANA name. Defined
	 * where the instant lies in timestamptz's range, which its bounds prove, a reading's among them, or a Num.within
	 * guard. The host holds no tzdata, so it stands in a query alone: a check, a contract predicate or a generated field
	 * refuses it.
	 */
	wall<A extends TermBase | FirstValue, X, PA, OA, Z extends Zoned, PZ, OZ>(
		instant: A & FirstTerm<A> & InputTerm<X, PA, OA, "bigint"> & NotInstant<X>,
		zone: Term<Z, PZ, OZ, "code", unknown, Facts, unknown>
	): Admitted<TakesFirst<A, "bigint">, Term<bigint, PA & PZ, ComputedOrigin<OA | OZ>, "bigint">>
	/**
	 * A date's days after 1970-01-01, negative before it, `x - '1970-01-01'::date`: an integer, defined on every date,
	 * standing in a query, a check and a generated field alike.
	 */
	epochDay<A extends TermBase | FirstValue, X, PA, OA>(
		date: A & FirstTerm<A> & InputTerm<X, PA, OA, "date">
	): Admitted<TakesFirst<A, "date">, Term<number, PA, ComputedOrigin<OA>, "integer">>
	/**
	 * The date an integer or bigint term counts days after 1970-01-01, `'1970-01-01'::date + n`: defined where n is the
	 * epoch day of a date of 0001-01-01 to 9999-12-31, which its bounds prove or a Num.within guard. An exact integer is
	 * cast into a bigint first, Type.cast(n, pg.bigint).
	 */
	dateOfEpochDay<A extends TermBase | FirstValue, X, PA, OA, S extends "integer" | "bigint">(
		days: A & FirstTerm<A> & InputTerm<X, PA, OA, S>
	): Admitted<
		TakesFirst<A, "integer" | "bigint">,
		Term<PlainHost["date"], PA, ComputedOrigin<OA>, "date">
	>
}

/** The SQL types of PostgreSQL's network address types, which Net's containment reads on either side. */
type NetSql = "inet" | "cidr"

/**
 * An operand of a network containment beside its first: an inet or a cidr term, of either type whatever the first's,
 * or a JavaScript value of the first operand's language, which takes its type.
 */
type NetOperand<X> = (TermBase & { readonly sql: NetSql }) | LiteralOf<X>

/**
 * The Net namespace: the containment of PostgreSQL's network address types, inet and cidr, each test over an inet or a
 * cidr term and an inet or a cidr operand, a term or a value of the first's type, and each false across the address
 * families, as PostgreSQL defines it (network.c). `>>=` and `>>` are within and strictlyWithin with their operands
 * swapped, so neither has a name of its own.
 */
export interface NetApi {
	/** Whether a is within b or equals it, `a <<= b`: a's mask no shorter than b's, a's address b's on b's mask. */
	within<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, NetSql>,
		b: Fit<B, NoInfer<NetOperand<X>>>
	): Admitted<
		Every<[TakesFirst<A, NetSql>, Takes<B, NetOperand<X>>]>,
		Predicate<PA & P<B>, ComputedOrigin<OA | O<B>>>
	>
	/** Whether a is within b and not b itself, `a << b`: a's mask longer than b's, a's address b's on b's mask. */
	strictlyWithin<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, NetSql>,
		b: Fit<B, NoInfer<NetOperand<X>>>
	): Admitted<
		Every<[TakesFirst<A, NetSql>, Takes<B, NetOperand<X>>]>,
		Predicate<PA & P<B>, ComputedOrigin<OA | O<B>>>
	>
	/** Whether a and b overlap, `a && b`: one is within the other, their addresses one on the shorter mask. */
	overlaps<A extends TermBase | FirstValue, X, PA, OA, const B>(
		a: A & First<A, [B]> & InputTerm<X, PA, OA, NetSql>,
		b: Fit<B, NoInfer<NetOperand<X>>>
	): Admitted<
		Every<[TakesFirst<A, NetSql>, Takes<B, NetOperand<X>>]>,
		Predicate<PA & P<B>, ComputedOrigin<OA | O<B>>>
	>
}

/**
 * The Fn namespace: a declared function (schema/function.ts fn) called at its arguments, for its value, its rows or its
 * one row.
 */
export interface FnApi {
	/**
	 * A declared function's value at its arguments (schema/function.ts fn): a function that returns a value of a field,
	 * immutable or stable, each argument by its declared name, every one and none other, a term meeting its declared
	 * domain or a JavaScript value of its language. The value is a term of the result field, which PostgreSQL alone
	 * computes: of an origin no host evaluates (UnhostedOrigin), so a contract predicate, a row check and a generated
	 * field refuse it (Hosted), and a NULL result raises where the query reads it (SQLSTATE 22004). A strict
	 * function's value at a NULL argument (a closed read at an absent key) is NULL, its body never run there, as a
	 * strict operation's is, never that refusal.
	 */
	call<
		const Args extends Readonly<Record<string, FunctionType>>,
		H,
		S extends SqlTag,
		D,
		F extends Facts,
		const A extends CallArgs<Args>
	>(
		f: ValueFunction<Args, H, S, D, F>,
		args: A & ExactCallArgs<A, Args>
	): CalledTerm<A, H, S, D, F>
	/**
	 * The rows a declared function that returns rows of a heading returns at its arguments, a source a rule matches as
	 * it matches a bound query: each argument by its declared name, a value as Fn.call takes one, or rows, a query
	 * or a bound query whose facts are the argument's heading's. Its facts are the result heading's, a set; a row of a
	 * NULL field raises where the query reads it (SQLSTATE 22004).
	 */
	rows<
		const Args extends Readonly<Record<string, FunctionType>>,
		Fields extends Readonly<Record<string, FieldBase>> & Carriers,
		const A extends CallArgs<Args>
	>(
		f: RowsFunction<Args, Fields>,
		args: A & ExactCallArgs<A, Args>
	): CallSource<FactOfFields<Fields>, BindMapParams<A>, Fields, CallReads<A>>
	/**
	 * The fields of the one row a declared function of one row returns at its arguments, immutable or stable, each
	 * argument as Fn.rows takes one: each field of the row that holds rows of a heading of values, by its name, a
	 * source a rule matches, its facts the heading's, a set. Every read of them reads one evaluation of the call, so a
	 * statement that reads several of them calls the function once at its arguments. A row holding NULL at any field
	 * raises where it is evaluated, and a row of a field holding NULL where the field is read (SQLSTATE 22004); a field
	 * of no rows is the empty source.
	 */
	row<
		const Args extends Readonly<Record<string, FunctionType>>,
		Fields extends Readonly<Record<string, FunctionType>>,
		const A extends CallArgs<Args>
	>(
		f: RowFunction<Args, Fields>,
		args: A & ExactCallArgs<A, Args>
	): CallFields<A, Fields>
}

/** The comparison and boolean helpers a row check sees beside its fields. */
export type ScalarHelpers = Pick<
	LogicApi,
	"eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in" | "and" | "or" | "not"
> &
	Pick<TextApi, "charLength" | "octetLength" | "utf16Length">
