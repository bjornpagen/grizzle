import type { SqlTag } from "#compiler/scalar/registry.ts"
import type {
	BaseOf,
	ComputedOrigin,
	IsUntypedInput,
	LiteralOrigin,
	OperandOrigin,
	ParamOrigin,
	ParamsOfTerm,
	Predicate,
	Refusal,
	Term,
	TypeOfTerm,
	TypeRefusal
} from "#compiler/types/core/phantom.ts"
import type { LiteralOf } from "#compiler/types/fields/field.ts"

/**
 * What may stand opposite a term of host type T and SQL type S: a term of exactly T and S, a parameter of T and S among
 * them, or a literal (which adopts T's base and S). A literal never stands in the first operand, nor does a parameter
 * (FirstTerm). S is the SQL type the lowering's requireCompatible checks the operand against (scalar/compute/lower.ts),
 * so every position that checks it states it.
 */
export type Operand<T, S extends SqlTag> = Term<T, unknown, unknown, S> | LiteralOf<T>

/**
 * Scalar terms with comparison methods, operands, and PostgreSQL's native result typing.
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
	out Sql extends SqlTag = SqlTag
> extends Term<T, P, O, Sql> {
	eq<B extends Operand<T, Sql>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	ne<B extends Operand<T, Sql>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	lt<B extends Operand<T, Sql>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	le<B extends Operand<T, Sql>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	gt<B extends Operand<T, Sql>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	ge<B extends Operand<T, Sql>>(other: B): Predicate<P & ParamsOfTerm<B>, ComparisonOrigin<O, B>>
	between<L extends Operand<T, Sql>, H extends Operand<T, Sql>>(
		low: L,
		high: H
	): Predicate<
		P & ParamsOfTerm<L> & ParamsOfTerm<H>,
		ComputedOrigin<O | OperandOrigin<L> | OperandOrigin<H>>
	>
	in(values: ReadonlyArray<LiteralOf<T>>): Predicate<P, ComputedOrigin<O>>
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

/**
 * The first operand of an operation is a term that is no parameter or head literal: a Description records either
 * untyped, and the checker types it from the term it meets. FirstTerm reads a term's own origin; FirstOrigin reads an
 * origin a signature inferred.
 */
export type FirstTerm<A> = Requires<
	IsUntypedInput<A> extends true ? false : true,
	"a term first: a parameter or a literal takes its place opposite a term, never first"
>
export type FirstOrigin<O> = Requires<
	[O] extends [ParamOrigin | LiteralOrigin] ? false : true,
	"a term first: a parameter or a literal takes its place opposite a term, never first"
>

export type IsSpan<A> =
	TypeOfTerm<A> extends { readonly start: unknown; readonly end: unknown } ? true : false

/**
 * Compute.cast, following the registry's cast table, over the source's host X and SQL type S and the target's host H
 * and SQL type F: smallint, integer, bigint, numeric, real and double precision convert among themselves in every
 * direction; money is a target only from integer, bigint and numeric (PostgreSQL has no smallint, real or double
 * precision cast to money), and a source only to numeric; and any other base casts only into a contract or refinement
 * over its own SQL type.
 */
type NumericFamilySql = "smallint" | "integer" | "bigint" | "numeric" | "real" | "double precision"
export type CastAdmitted<X, S extends SqlTag, H, F extends SqlTag> = [S] extends [NumericFamilySql]
	? [F] extends [NumericFamilySql]
		? true
		: [F] extends ["money"]
			? [S] extends ["integer" | "bigint" | "numeric"]
				? true
				: false
			: false
	: [S] extends ["money"]
		? [F] extends ["numeric" | "money"]
			? true
			: false
		: [BaseOf<X>] extends [BaseOf<H>]
			? [F] extends [S]
				? true
				: false
			: false
