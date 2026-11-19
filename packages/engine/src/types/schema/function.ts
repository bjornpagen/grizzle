import type { DeclaredLanguage, FunctionVolatility } from "#compiler/core/function.ts"
import type { Built } from "#compiler/core/phantom.ts"
import type { Refusal } from "#compiler/types/core/phantom.ts"
import type { FieldBase, StoredOnlySql, WritingTag } from "#compiler/types/fields/field.ts"

/**
 * The heading of the rows a declared function takes as an argument or returns (schema/function.ts rows): its fields,
 * in the order the record writes them, which is the order of its row type's attributes.
 */
export interface Rows<out Fields> extends Built {
	readonly kind: "rows"
	readonly fields: Fields
}

/** Any heading of rows. */
export type AnyRows = Rows<Readonly<Record<string, FieldBase>>>

/** What a declared function takes as an argument or gives as its result: a value of a field, or rows of a heading. */
export type FunctionType = FieldBase | AnyRows

/**
 * A declared function (schema/function.ts fn): its name, its argument types by name in declared order, its result
 * type and its volatility, and the language of its body, which its Description holds.
 */
export interface DeclaredFunction<
	out Name extends string,
	out Args extends Readonly<Record<string, FunctionType>>,
	out Returns extends FunctionType,
	out V extends FunctionVolatility
> extends Built {
	readonly kind: "function"
	readonly name: Name
	readonly args: Args
	readonly returns: Returns
	readonly volatility: V
	readonly language: DeclaredLanguage
}

/** Any declared function: the members every one has. */
export type AnyFunction = DeclaredFunction<
	string,
	Readonly<Record<string, FunctionType>>,
	FunctionType,
	FunctionVolatility
>

/**
 * Whether a field is a type a declared function's signature takes: a value of a base type PostgreSQL passes as it is, a
 * closed id, or a contract or refined text over one, never a serial or other field of a writing of its own, money,
 * bytes, a set, a span or a vector.
 */
type SignatureRefused<F> = F extends
	| { readonly writing: WritingTag }
	| { readonly sql: "money" | "bits" | "range" | "vector" | StoredOnlySql }
	? true
	: false

/** The refusal of a field no signature takes (SignatureRefused). */
type SignatureRefusal =
	Refusal<"a declared function takes and returns values of a base type, a closed id, a contract or a refined text over one: no serial, money, bytes, set, span or vector">

/** Each field of a heading a signature takes, the others refused at their keys. */
export type HeadingCheck<Fields> = {
	readonly [K in keyof Fields]: SignatureRefused<Fields[K]> extends true
		? SignatureRefusal
		: unknown
}

/** A signature's type: rows of a heading, already checked where rows() built it, or a value of a field it takes. */
export type SignatureCheck<T> =
	T extends Rows<unknown> ? unknown : SignatureRefused<T> extends true ? SignatureRefusal : unknown

/** Each argument a signature takes, the others refused at their keys. */
export type ArgsCheck<Args> = { readonly [K in keyof Args]: SignatureCheck<Args[K]> }
