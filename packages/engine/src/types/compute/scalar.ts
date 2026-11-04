import type { guarded } from "#compiler/scalar/compute/term.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"
import type {
	BaseOf,
	ComputedOrigin,
	Facts,
	FactsOf,
	HasOrigin,
	LiteralOrigin,
	Meets,
	OperandOrigin,
	OriginOfTerm,
	ParamsOfTerm,
	Predicate,
	Refusal,
	Term,
	TermBase,
	TypeOfTerm,
	TypeRefusal
} from "#compiler/types/core/phantom.ts"
import type { LiteralOf } from "#compiler/types/fields/field.ts"

/**
 * What may stand opposite a term of host type T and SQL type S: a term that meets T and S (Meets, the one relation, a
 * parameter of them and a value of an exact family among them), or a literal of the term's language L (which adopts
 * T's base and S). A literal never stands in the first operand; a parameter, a term, does (FirstTerm). S is the SQL
 * type the lowering checks the operand against (scalar/compute/lower.ts), so every position that checks it states it.
 */
export type Operand<T, S extends SqlTag, L = T> = Meets<T, S> | LiteralOf<L>

/**
 * What a number or bigint literal type proves of its value, as compilation reads the value (lower.ts factsOfValue): it
 * is finite, nonzero unless zero is one of it, and nonnegative unless one of it is negative. TypeScript has no NaN or
 * infinity literal type, and writes -0 as 0.
 */
export type LiteralFacts<V extends number | bigint> = { readonly finite: true } & ([
	Extract<V, 0 | 0n>
] extends [never]
	? { readonly nonzero: true }
	: unknown) &
	([Extract<`${V}`, `-${string}`>] extends [never] ? { readonly nonnegative: true } : unknown)

/**
 * Whether TypeScript sees a JavaScript value's facts: a number or bigint literal type, unbranded. A wider type (number,
 * bigint, a decimal string, a Decimal, a Money, a contract's branded value) has a value TypeScript cannot see.
 */
type Seen<V> = [V] extends [number | bigint]
	? number extends V
		? false
		: bigint extends V
			? false
			: [BaseOf<V>] extends [V]
				? true
				: false
	: false

/**
 * Whether a JavaScript value V has the fact K: read off its literal type where TypeScript sees it (LiteralFacts), and
 * otherwise admitted, a residue compilation decides from the value itself, which it always holds at compile time.
 */
type ValueProves<V, K extends keyof Facts> = [V] extends [never]
	? false
	: Seen<V> extends true
		? LiteralFacts<V & (number | bigint)> extends { readonly [P in K]-?: true }
			? true
			: false
		: true

/** Whether a JavaScript value TypeScript sees is negative: a literal type whose every value is below zero. */
type Negative<V> =
	Seen<V> extends true
		? [Exclude<`${V & (number | bigint)}`, `-${string}`>] extends [never]
			? true
			: false
		: false

/**
 * What Compute.within proves of its subject from its bounds Lo and Hi, as compilation reads them (lower.ts guardFacts):
 * finite; nonnegative where the low bound is; nonzero where the low bound is above zero or the high one below it. A
 * bound TypeScript cannot see proves nothing beyond finiteness here, though compilation reads its value.
 */
export type WithinFacts<Lo, Hi> = { readonly finite: true } & (ValueProves<
	Lo,
	"nonnegative"
> extends true
	? Seen<Lo> extends true
		? { readonly nonnegative: true }
		: unknown
	: unknown) &
	((
		Seen<Lo> extends true
			? ValueProves<Lo, "nonnegative"> extends true
				? ValueProves<Lo, "nonzero">
				: false
			: false
	) extends true
		? { readonly nonzero: true }
		: Negative<Hi> extends true
			? { readonly nonzero: true }
			: unknown)

declare const literalValue: unique symbol

/** What Compute.literal's constant states beside its type: its JavaScript value's type, whose facts Proves reads. */
export interface Literal<out V> {
	readonly [literalValue]?: V | undefined
}

/** The JavaScript value type a constant states (Literal), and never for any other term. */
type LiteralValueOf<B> = B extends Literal<infer V> ? (unknown extends V ? never : V) : never

/**
 * Whether an operand, a term or a JavaScript value, is proved to have the fact K: a term by its facts (a contract's
 * declared facts, a guard's inside its branch) or, a constant, by its value; a JavaScript value by its value
 * (ValueProves).
 */
export type Proves<B, K extends keyof Facts> = B extends TermBase
	? FactsOf<B> extends { readonly [P in K]-?: true }
		? true
		: ValueProves<LiteralValueOf<B>, K>
	: ValueProves<B, K>

/**
 * Whether a term in a first operand's position, of facts F and, a constant, of JavaScript value type V (unknown for any
 * other term, which states none: `& Proving<F> & Literal<V>` infers both), has the fact K, as Proves reads a term.
 */
export type Holds<F extends Facts, V, K extends keyof Facts> = F extends {
	readonly [P in K]-?: true
}
	? true
	: unknown extends V
		? false
		: ValueProves<V, K>

/**
 * A guard a Compute guard builder made: a predicate over its subject, which a rule's where reads as its test, holding
 * under `guarded` the subject G as its Compute.when branch receives it, with the guard's facts proved
 * (scalar/compute/term.ts GuardValue).
 */
export interface Guard<out G, out P = unknown, out O = unknown> extends Predicate<P, O> {
	readonly [guarded]: G
}

/**
 * Scalar terms with comparison methods, operands, and PostgreSQL's native result typing. A scalar's language L is its
 * values, which its JavaScript operands are of.
 *
 * An operation's result type is read off a table keyed by its operand's SQL type, the term's `sql` member
 * (scalar/compute/tables.ts): arithmetic keeps the operand's SQL type without its contract, money / money is double
 * precision, SUM over integer is bigint. The operand families each operation admits are SQL types too, a type
 * parameter's constraint, and the tables follow the overload registry of packages/engine/src/scalar/compute, which
 * test/pg/compute verifies against PostgreSQL 19's catalog.
 *
 * A scalar with comparison methods: a contract predicate's value, a row check's fields. A comparison's origin is what
 * its operands read.
 */
export interface Scalar<
	in out T,
	out P = unknown,
	out O = unknown,
	out Sql extends SqlTag = SqlTag,
	in out L = T
> extends Term<T, P, O, Sql, L, Facts, L> {
	eq<B extends Operand<T, Sql, L>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	ne<B extends Operand<T, Sql, L>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	lt<B extends Operand<T, Sql, L>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	le<B extends Operand<T, Sql, L>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	gt<B extends Operand<T, Sql, L>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	ge<B extends Operand<T, Sql, L>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	between<Lo extends Operand<T, Sql, L>, Hi extends Operand<T, Sql, L>>(
		low: Lo,
		high: Hi
	): Predicate<
		P & ParamsOfTerm<Lo> & ParamsOfTerm<Hi>,
		ComputedOrigin<O | OperandOrigin<Lo> | OperandOrigin<Hi>>
	>
	in(values: ReadonlyArray<LiteralOf<L>>): Predicate<P, ComputedOrigin<O>>
}

/** A comparison's origin: a computation over the scalar, of origin O, and the operand B. */
type ComparisonOrigin<O, B> = ComputedOrigin<O | OperandOrigin<B>>

/**
 * A precondition on an inferred argument: `a: A & Requires<Cond, "message">` keeps A inferable from the argument and
 * names the failure when Cond is false.
 */
export type Requires<Cond extends boolean, Message extends TypeRefusal> = [Cond] extends [true]
	? unknown
	: Refusal<Message>

/** Whether a term is a JavaScript value in a head (LiteralOrigin), which a Description records untyped. */
type IsHeadLiteral<A> =
	HasOrigin<A> extends true ? ([OriginOfTerm<A>] extends [LiteralOrigin] ? true : false) : false

/**
 * The first operand of an operation is a term, a parameter among them, never a head literal: a Description records one
 * untyped, and the checker types it from the term it meets. FirstTerm reads a term's own origin, and refuses a
 * JavaScript value by the same name: every first operand admits one beside its terms (A extends TermBase | FirstValue),
 * so its refusal names the rule rather than the members a value lacks. FirstOrigin reads the origin a callback's
 * returned term was inferred with (Compute.when's branch), where no type parameter holds the value itself.
 */
export type FirstTerm<A> = A extends FirstValue
	? Refusal<"a term first: a literal takes its place opposite a term, never first">
	: Requires<
			IsHeadLiteral<A> extends true ? false : true,
			"a term first: a literal takes its place opposite a term, never first"
		>
/** A JavaScript value written where a first operand belongs: a primitive, a Decimal, a Money, a vector or a span. */
export type FirstValue =
	| string
	| number
	| bigint
	| boolean
	| Decimal
	| Money
	| Vector
	| Span<number>
	| Span<bigint>
export type FirstOrigin<O> = Requires<
	[O] extends [LiteralOrigin] ? false : true,
	"a term first: a literal takes its place opposite a term, never first"
>

export type IsSpan<A> =
	TypeOfTerm<A> extends { readonly start: unknown; readonly end: unknown } ? true : false

/**
 * Compute.cast, following the registry's cast table, over the source's domain X and SQL type S and the target's
 * domain D and SQL type F: smallint, integer, bigint, numeric, real and double precision convert among themselves in every
 * direction; money is a target only from integer, bigint, numeric and an exact integer (PostgreSQL has no smallint,
 * real or double precision cast to money), and a source only to numeric; an exact integer narrows into the numeric
 * family and money, exact money into money and numeric; and any other base casts only into a contract or refinement
 * over its own SQL type.
 */
type NumericFamilySql = "smallint" | "integer" | "bigint" | "numeric" | "real" | "double precision"
export type CastAdmitted<X, S extends SqlTag, D, F extends SqlTag> = [S] extends [NumericFamilySql]
	? [F] extends [NumericFamilySql]
		? true
		: [F] extends ["money"]
			? [S] extends ["integer" | "bigint" | "numeric"]
				? true
				: false
			: false
	: [S] extends ["exact integer"]
		? [F] extends [NumericFamilySql | "money"]
			? true
			: false
		: [S] extends ["money" | "exact money"]
			? [F] extends ["numeric" | "money"]
				? true
				: false
			: [BaseOf<X>] extends [BaseOf<D>]
				? [F] extends [S]
					? true
					: false
				: false
