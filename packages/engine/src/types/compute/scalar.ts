import type { Refused } from "#compiler/core/refusals.ts"
import type { CastTargetsBySql } from "#compiler/scalar/compute/registry.ts"
import type { guarded } from "#compiler/scalar/compute/term.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Numeric } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"
import type {
	BaseOf,
	DeclaredOf,
	Facts,
	FactsOf,
	HasOrigin,
	LanguageOf,
	LiteralOrigin,
	Meets,
	OneBaseCarrier,
	OriginOfTerm,
	Predicate,
	Refusal,
	SqlOfTerm,
	Term,
	TermBase,
	TypeOfTerm,
	Unmarked,
	Unordered
} from "#compiler/types/core/phantom.ts"
import type {
	InstantDomain,
	LiteralOf,
	NotStoredOnly,
	ValueLiteralOf
} from "#compiler/types/fields/field.ts"

/**
 * What may stand opposite a term of host type T and SQL type S: a term that meets T and S (Meets, the one relation, a
 * parameter of them and a value of an exact family among them), or a literal of the term's language L (which adopts
 * T's base and S), never opposite an instant, which no caller states (types/fields InstantDomain). A literal never stands in the first operand; a parameter, a term, does (FirstTerm). S is the SQL
 * type the typing checks the operand against (scalar/compute/typing.ts), so every position that checks it states it.
 * Every type parameter an Operand constrains is const, so a JavaScript value keeps its literal type: widened, a
 * roster's member, a uuid or a refined text's member is no value of L, and TypeScript would type the operand as the
 * constraint, whose terms read an unknown origin, so nothing computed over it would be determined.
 */
export type Operand<T, S extends SqlTag, L = T> =
	| Meets<T, S>
	| ([T] extends [InstantDomain] ? never : LiteralOf<L>)

/**
 * What may stand where it becomes a value of a term's type, of host type T, SQL type S and language L: a conditional's
 * other arm and a variant arm's field. A term that meets T and S (Meets), as opposite a term, or a literal that becomes a
 * value of L (ValueLiteralOf): a contract's host value, which its consumer's mint alone makes, and any other type's
 * literal as a comparison takes it; never a value of an instant, which no caller states.
 */
export type ValueOperand<T, S extends SqlTag, L = T> =
	| Meets<T, S>
	| ([T] extends [InstantDomain] ? never : ValueLiteralOf<L>)

/**
 * What an equality admits opposite a first operand A beside what every comparison does (Operand): a term of A's base
 * carrier of another type, a refinement of it either way (OneBaseCarrier), which the engine types at the carrier
 * (scalar/compute/typing.ts refined); RefinedEquality holds such a term to it.
 */
export type RefinedTerm<A> = TermBase & { readonly sql: SqlOfTerm<A> }

/**
 * Holds an equality's second operand B to its first A: a term of A's base carrier (RefinedTerm) of another type stands
 * as it is, and any other operand must meet A as every comparison's does (Operand).
 */
export type RefinedEquality<A, B> =
	B extends Operand<TypeOfTerm<A>, SqlOfTerm<A>, LanguageOf<A>>
		? unknown
		: B extends TermBase
			? OneBaseCarrier<TypeOfTerm<A>, SqlOfTerm<A>, TypeOfTerm<B>, SqlOfTerm<B>> extends true
				? unknown
				: Operand<TypeOfTerm<A>, SqlOfTerm<A>, LanguageOf<A>>
			: unknown

/**
 * What a number or bigint literal type proves of its value, as compilation reads the value (typing.ts factsOfValue): it
 * is finite, nonzero unless zero is one of it, and nonnegative unless one of it is negative. TypeScript has no NaN or
 * infinity literal type, and writes -0 as 0.
 */
type LiteralFacts<V extends number | bigint> = { readonly finite: true } & ([
	Extract<V, 0 | 0n>
] extends [never]
	? { readonly nonzero: true }
	: unknown) &
	([Extract<`${V}`, `-${string}`>] extends [never] ? { readonly nonnegative: true } : unknown)

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"

/** The sign of a run of digits, zero where every digit is, read past the digits Z already holds; unread at any other character. */
type DigitsSign<S extends string, Z extends "zero" | "positive"> = S extends ""
	? Z
	: S extends `0${infer R}`
		? DigitsSign<R, Z>
		: S extends `${Exclude<Digit, "0">}${infer R}`
			? DigitsSign<R, "positive">
			: "unread"

/** The sign of one or more digits: unread where there are none. */
type SomeDigitsSign<S extends string> = S extends `${Digit}${string}`
	? DigitsSign<S, "zero">
	: "unread"

/** The sign of an unsigned decimal's digits: digits, or digits, a point and digits. */
type UnsignedSign<S extends string> = S extends `${infer I}.${infer F}`
	? SomeDigitsSign<I> extends infer A
		? SomeDigitsSign<F> extends infer B
			? A extends "unread"
				? "unread"
				: B extends "unread"
					? "unread"
					: A extends "positive"
						? "positive"
						: B
			: never
		: never
	: SomeDigitsSign<S>

/**
 * The sign of the value a string literal type spells as an exact decimal, as the engine reads its text
 * (values/decimal.ts fromString): zero, positive or negative, for an optional sign, digits and an optional point with
 * digits. Every other spelling, one the engine reads (an exponent, "NaN", a bare point) or refuses, is unread here, and
 * its value is the engine's to judge; so is `string` and a template's, whose spelling no one literal fixes.
 */
type DecimalSign<S extends string> = S extends `-${infer R}`
	? UnsignedSign<R> extends "positive"
		? "negative"
		: UnsignedSign<R>
	: S extends `+${infer R}`
		? UnsignedSign<R>
		: UnsignedSign<S>

/** What a decimal's text proves of its value: finite, nonzero unless it is zero, nonnegative unless it is negative. */
type TextFacts<V extends string> = { readonly finite: true } & ([
	Extract<DecimalSign<V>, "zero">
] extends [never]
	? { readonly nonzero: true }
	: unknown) &
	([Extract<DecimalSign<V>, "negative">] extends [never] ? { readonly nonnegative: true } : unknown)

/**
 * Whether TypeScript sees a JavaScript value's facts: a number or bigint literal type, or a string literal type spelling
 * an exact decimal (DecimalSign), unbranded, read under a contract's host marks (Unmarked), so a value its consumer's
 * mint made of a literal, `toCents(0n)`, is that literal's. A wider type (number, bigint, string, a Numeric, a Money)
 * has a value TypeScript cannot see.
 */
type Seen<V> = SeenValue<Unmarked<V>>

/** Seen of a value its marks are read off. */
type SeenValue<V> = [V] extends [number | bigint]
	? number extends V
		? false
		: bigint extends V
			? false
			: [BaseOf<V>] extends [V]
				? true
				: false
	: [V] extends [string]
		? [BaseOf<V>] extends [V]
			? "unread" extends DecimalSign<V & string>
				? false
				: true
			: false
		: false

/**
 * The facts a value TypeScript sees proves, under its marks (Unmarked): a number's or a bigint's (LiteralFacts), or a
 * decimal text's (TextFacts).
 */
type SeenFacts<V> =
	Unmarked<V> extends infer U
		? [U] extends [string]
			? TextFacts<U & string>
			: LiteralFacts<U & (number | bigint)>
		: never

/**
 * Whether a JavaScript value V has the fact K: read off its literal type where TypeScript sees it (SeenFacts), and
 * otherwise admitted, a residue compilation decides from the value itself, which it always holds at compile time.
 */
type ValueProves<V, K extends keyof Facts> = [V] extends [never]
	? false
	: Seen<V> extends true
		? SeenFacts<V> extends { readonly [P in K]-?: true }
			? true
			: false
		: true

/** Whether a JavaScript value TypeScript sees is negative: a literal type whose every value is below zero. */
type Negative<V> =
	Seen<V> extends true
		? Unmarked<V> extends infer U
			? [U] extends [string]
				? [Exclude<DecimalSign<U & string>, "negative">] extends [never]
					? true
					: false
				: [Exclude<`${U & (number | bigint)}`, `-${string}`>] extends [never]
					? true
					: false
			: false
		: false

/**
 * What Num.within proves of its subject from its bounds Lo and Hi, as compilation reads them (typing.ts guardFacts):
 * finite; nonnegative where the low bound is; nonzero where the low bound is above zero or the high one below it. A low
 * bound TypeScript cannot see is a residue compilation decides from its value, as a divisor's is (ValueProves); a high
 * bound proves nonzero only where TypeScript sees it below zero.
 */
export type WithinFacts<Lo, Hi> = { readonly finite: true } & (ValueProves<
	Lo,
	"nonnegative"
> extends true
	? { readonly nonnegative: true }
	: unknown) &
	((ValueProves<Lo, "nonnegative"> extends true ? ValueProves<Lo, "nonzero"> : false) extends true
		? { readonly nonzero: true }
		: Negative<Hi> extends true
			? { readonly nonzero: true }
			: unknown)

declare const literalValue: unique symbol

/** What Type.literal's constant states beside its type: its JavaScript value's type, whose facts Proves reads. */
export interface Literal<out V> {
	readonly [literalValue]?: V | undefined
}

/** The JavaScript value type a constant states (Literal), and never for any other term. */
type LiteralValueOf<B> = B extends Literal<infer V> ? (unknown extends V ? never : V) : never

/** Whether a contract's values have the fact K (F) and a JavaScript value TypeScript sees, of facts G, lacks it. */
type Lacks<F, G, K extends keyof Facts> = F extends { readonly [P in K]-?: true }
	? G extends { readonly [P in K]-?: true }
		? false
		: true
	: false

/**
 * Whether a contract whose values have the facts F refuses a JavaScript value V that TypeScript sees: V lacks one of
 * them, a zero where the contract declares nonzero, a negative value where it declares nonnegative. A contract declares
 * only facts its predicate implies, which compilation verifies, so its predicate refuses V (ContractLiteral). A value
 * TypeScript cannot see, and one outside bounds its predicate states, which no type carries, is compilation's to judge.
 */
export type Refutes<F, V> =
	Seen<V> extends true
		? true extends
				| Lacks<F, SeenFacts<V>, "nonzero">
				| Lacks<F, SeenFacts<V>, "nonnegative">
				| Lacks<F, SeenFacts<V>, "finite">
			? true
			: false
		: false

/**
 * A JavaScript value's own requirement where a contract whose values have the facts F reads it: its contract's refusal
 * where the types decide it (Refutes), stated only where the call takes the value's type (Taken).
 */
export type ContractAdmits<Taken extends boolean, F, V> = [Taken] extends [true]
	? Refutes<F, V> extends true
		? Refusal<"a value its contract refuses: it lacks a fact the contract declares">
		: unknown
	: unknown

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
 * A guard a scalar guard builder made: a predicate over its subject, which a rule's where reads as its test, holding
 * under `guarded` the subject G as its Logic.when branch receives it, with the guard's facts proved
 * (scalar/compute/term.ts GuardValue).
 */
export interface Guard<out G, in P = unknown, out O = unknown> extends Predicate<P, O> {
	readonly [guarded]: G
}

/**
 * A scalar: a term whose facts are the ones its type declares (DeclaredOf) and whose column delivers its language L,
 * its values, which its JavaScript operands are of: a contract predicate's value, a row check's fields and a length
 * the scalar catalogue measures. A value of a contract has its facts wherever it is read, a stored field's as a heading column's
 * (ColumnFacts), as compilation reads a value's facts off its type. A scalar carries no comparison of its own: Logic's,
 * a row's helpers' and a rule's compare it.
 *
 * An operation's result type is read off a table keyed by its operand's SQL type, the term's `sql` member
 * (scalar/compute/tables.ts): arithmetic keeps the operand's SQL type without its contract, money / money is double
 * precision, SUM over integer is bigint. The operand families each operation admits are SQL types too, a type
 * parameter's constraint, and the tables follow the overload registry of packages/engine/src/scalar/compute, which
 * test/pg/compute verifies against PostgreSQL 19's catalog.
 */
export type Scalar<T, P = unknown, O = unknown, Sql extends SqlTag = SqlTag, L = T> = Term<
	T,
	P,
	O,
	Sql,
	L,
	DeclaredOf<T>,
	L
>

/**
 * Whether a term's values have no order: its type carries Unordered, a closed id of a closed.unordered roster, whose
 * codes are history and none of whose handles comes before another (types/core/phantom.ts RosterBrands). Never for a
 * JavaScript value or a refused term, whose type is never.
 */
export type HasNoOrder<A> = [TypeOfTerm<A>] extends [never]
	? false
	: [TypeOfTerm<A>] extends [Unordered]
		? true
		: false

/**
 * Whether an ordered operation takes a term A by its order: every term but a closed id of a closed.unordered roster
 * (HasNoOrder), which no comparison, range, orderBy, least, greatest, min, max or fold max reads.
 */
export type HasOrder<A> = HasNoOrder<A> extends true ? false : true

/**
 * An ordered operation's operand A: the refusal of an ordered operation over a closed id of a closed.unordered roster,
 * the engine's (scalar/native.ts unorderedCodeCapabilities), where A has no order (HasOrder), and unknown, no
 * requirement, otherwise. Its message names what gives the roster an order.
 */
export type OrderedOperand<A> =
	HasOrder<A> extends true
		? unknown
		: Refusal<"a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles">

/**
 * A precondition on an inferred argument: `a: A & Requires<Cond, "message">` keeps A inferable from the argument and
 * names the failure when Cond is false.
 */
export type Requires<Cond extends boolean, Message extends Refused> = [Cond] extends [true]
	? unknown
	: Refusal<Message>

/**
 * The result R of an operation over the SQL types F, read at its first operand A's SQL type: R at every type of F, and
 * none, never, at a JavaScript value or a term of another type, which the operation refuses. TypeScript types a type
 * parameter whose argument breaks its constraint as the constraint itself, so a result read off the refused operand's
 * SQL type would be of every type F's results have, which no position meets; never meets every position, so the
 * refusal is the call's one diagnostic.
 */
export type OfFamily<A, F extends SqlTag, R> = { readonly [K in F]: R }[Extract<
	A,
	TermBase
>["sql"] &
	F]

/** Whether a term is a JavaScript value in a head (LiteralOrigin), which a Description records untyped. */
type IsHeadLiteral<A> =
	HasOrigin<A> extends true ? ([OriginOfTerm<A>] extends [LiteralOrigin] ? true : false) : false

/**
 * The first operand of an operation is a term, a parameter among them, never a head literal: a Description records one
 * untyped, and the checker types it from the term it meets. FirstTerm reads a term's own origin, and refuses a
 * JavaScript value by the same name: every first operand admits one beside its terms (A extends TermBase | FirstValue),
 * so its refusal names the rule rather than the members a value lacks. A term of bytes, which no operation but
 * Crypto.sha256 reads, is refused (NotStoredOnly). FirstOrigin reads the origin a callback's returned term was
 * inferred with (Logic.when's branch), where no type parameter holds the value itself.
 */
export type FirstTerm<A> = A extends FirstValue
	? Refusal<"a term first: a literal takes its place opposite a term, never first">
	: OwnTerm<A> & NotStoredOnly<SqlOfTerm<A>>

/**
 * The first operand an operation reads whole, Crypto.sha256's: a term as FirstTerm reads one, of any SQL type, bytes
 * among them. A JavaScript value or a head literal there is refused as FirstTerm refuses it, the Refusal written in
 * place, never under an alias, so a diagnostic prints its text.
 */
export type WholeTerm<A> = A extends FirstValue
	? Refusal<"a term first: a literal takes its place opposite a term, never first">
	: OwnTerm<A>

/** A term's own requirement as a first operand: it is no head literal, a JavaScript value in a head. */
type OwnTerm<A> = Requires<
	IsHeadLiteral<A> extends true ? false : true,
	"a term first: a literal takes its place opposite a term, never first"
>
/** A JavaScript value written where a first operand belongs: a primitive, a Numeric, a Money, a vector, a span or a set. */
export type FirstValue =
	| string
	| number
	| bigint
	| boolean
	| Numeric
	| Money
	| Vector
	| Span<number>
	| Span<bigint>
	| ReadonlySet<string>
export type FirstOrigin<O> = Requires<
	[O] extends [LiteralOrigin] ? false : true,
	"a term first: a literal takes its place opposite a term, never first"
>

/**
 * Whether an operand is a refused call's result: never, which every scalar call the types refuse returns (Admitted).
 * The engine builds a call's operands before the call, so it refuses the operand's call first, and a call over a
 * refused operand states no refusal of its own: the operand's diagnostic is the one the engine names.
 */
type IsRefused<X> = [X] extends [never] ? true : false

/** Whether any of a call's operands Os is a refused call's result. */
export type AnyRefused<Os extends ReadonlyArray<unknown>> = true extends {
	readonly [K in keyof Os]: IsRefused<Os[K]>
}[number]
	? true
	: false

/**
 * Whether an operation over the SQL types F takes a first operand A: a term of one of them, never a refused call's
 * result, a JavaScript value or a head literal.
 */
export type TakesFirst<A, F extends SqlTag> =
	IsRefused<A> extends true
		? false
		: [A] extends [TermBase]
			? IsHeadLiteral<A> extends true
				? false
				: [SqlOfTerm<A>] extends [F]
					? true
					: false
			: false

/**
 * Whether a position P takes an operand B other than the first: B is one of P's, read off the argument itself (the
 * position states P through Fit, so B is never replaced by P), and never a refused call's result.
 */
export type Takes<B, P> = IsRefused<B> extends true ? false : [B] extends [P] ? true : false

/**
 * An operand read as it is written, held to its position P: the operand itself where P takes it, so a template literal
 * keeps its literal type, and the operand at P otherwise, whose mismatch is the operand's one diagnostic, an
 * argument's. A position states P through NoInfer, so no type parameter is inferred from it.
 */
export type Fit<B, P> = [B] extends [P] ? B : B & P

/** Whether a rest position P, a list of the operands it takes, takes a rest's operands Bs. */
export type TakesRest<Bs extends ReadonlyArray<unknown>, P extends ReadonlyArray<unknown>> =
	AnyRefused<Bs> extends true ? false : [Bs] extends [P] ? true : false

/** Whether every check holds. */
export type Every<Checks extends ReadonlyArray<boolean>> = false extends Checks[number]
	? false
	: true

/**
 * A first operand's own requirement, a term (FirstTerm), among the call's other operands Os: stated only where none is
 * a refused call's result, whose diagnostic is the call's one.
 */
export type First<A, Os extends ReadonlyArray<unknown>> =
	AnyRefused<Os> extends true ? unknown : FirstTerm<A>

/**
 * A requirement the engine judges once it has taken every operand's type, a partial operation's precondition or a
 * cast's own admission: Requires<Cond, Message> where the operation takes every operand (Taken), and nothing where it
 * does not, so an operand of another type gets its type refusal, which is the engine's reason, and never the
 * precondition's.
 */
export type Precondition<Taken extends boolean, Cond extends boolean, Message extends Refused> = [
	Taken
] extends [true]
	? Requires<Cond, Message>
	: unknown

/**
 * The result R of a call whose every operand its operation takes (Taken), and never for any other call, which the types
 * refuse: never meets every position, so an operation over a refused call adds no diagnostic, and the refusal is the
 * call's own. The result is read off a record by an index, never a conditional, so the catalogue's implementation,
 * whose index is generic, meets R (public/compute.ts).
 */
export type Admitted<Taken extends boolean, R> = { readonly taken: R }[[Taken] extends [true]
	? "taken"
	: never]

/**
 * The literal-first refusal of the first of a call's later first operands that is no term, which the engine reaches
 * before it reads any operand's type: what a first operand of another type states beside its type refusal, so the call's
 * one diagnostic names the engine's reason.
 */
type LaterFirst<Later extends ReadonlyArray<unknown>> = Later extends readonly [
	infer N,
	...infer Rest
]
	? [N] extends [TermBase]
		? LaterFirst<Rest>
		: FirstTerm<N>
	: unknown

/** Whether a first operand is a term of a type an operation over F does not take: one whose type refusal is its own. */
type OtherTerm<A, F extends SqlTag> = [A] extends [TermBase]
	? TakesFirst<A, F> extends true
		? false
		: IsRefused<A> extends true
			? false
			: true
	: false

/**
 * A first operand's own requirement among a call's several first operands, the engine reading each as a term before it
 * reads any one's type: a term (First), and, of a term of a type an operation over F does not take, the literal-first
 * refusal of a later first operand (LaterFirst), so the call's one diagnostic names the engine's reason.
 */
export type FirstAmong<
	A,
	F extends SqlTag,
	Os extends ReadonlyArray<unknown>,
	Later extends ReadonlyArray<unknown>
> =
	AnyRefused<Os> extends true
		? unknown
		: FirstTerm<A> & (OtherTerm<A, F> extends true ? LaterFirst<Later> : unknown)

export type IsSpan<A> =
	TypeOfTerm<A> extends { readonly start: unknown; readonly end: unknown } ? true : false

/**
 * Type.cast, over the source's domain X and SQL type S and the target's domain D and SQL type F, admits exactly the
 * casts compilation does (scalar/compute/typing.ts castTo): between two SQL types, the registered casts, read off the
 * engine's table itself (scalar/compute/registry.ts CastTargetsBySql), a text's parses into the types with a lexical
 * form among them; within one SQL type, a cast into a type over the same base, a contract or refinement over it
 * included, a span only over its own endpoint type, contract included (SameValues), since a span over a contract and a
 * span over its base are two types no cast converts between. Whether a parse's target has a lexical form at its typmod,
 * and whether the text's refinement proves it, is compilation's (typing.ts parse), since no type here holds a typmod's
 * form or a pattern's language.
 */
export type CastAdmitted<X, S extends SqlTag, D, F extends SqlTag> = [S] extends [F]
	? [S] extends ["range"]
		? SameValues<BaseOf<X>, BaseOf<D>>
		: [BaseOf<X>] extends [BaseOf<D>]
			? true
			: false
	: [F] extends [RegisteredCastTarget<S>]
		? true
		: false

/** The SQL types a registered cast takes a value of SQL type S into (CastTargetsBySql): none where S has none. */
type RegisteredCastTarget<S> = S extends keyof CastTargetsBySql ? CastTargetsBySql[S] : never

/** Whether two types hold one another's values: one type, a brand inside it included. */
type SameValues<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
