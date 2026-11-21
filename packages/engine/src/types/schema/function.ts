import type {
	DeclaredLanguage,
	FunctionNullInput,
	FunctionVolatility
} from "#compiler/core/function.ts"
import type { Built } from "#compiler/core/phantom.ts"
import type { Refusal } from "#compiler/types/core/phantom.ts"
import type { FieldBase, StoredOnlySql, WritingTag } from "#compiler/types/fields/field.ts"

/**
 * The heading of the rows a declared function takes as an argument or returns (schema/function.ts rows): its fields,
 * a record whose key order means nothing, since they install in code point order of their names, its row type's
 * attributes' order, each a value of a field, rows of another heading or one row of one.
 */
export interface Rows<out Fields> extends Built {
	readonly kind: "rows"
	readonly fields: Fields
}

/**
 * One row of a heading (schema/function.ts row), a value of its row type, a composite: an argument, a result or a
 * heading's field that is a row and not an array or a set of rows.
 */
export interface Row<out Heading> extends Built {
	readonly kind: "row"
	readonly heading: Heading
}

/** Any heading of rows. */
export type AnyRows = Rows<Readonly<Record<string, FunctionType>>>

/** Any row of a heading. */
export type AnyRow = Row<AnyRows>

/**
 * What a declared function takes as an argument or gives as its result, and what a heading's field holds: a value of
 * a field, rows of a heading, or one row of a heading.
 */
export type FunctionType = FieldBase | AnyRows | AnyRow

/**
 * A declared function's body (schema/function.ts fn.body): the application's PL/pgSQL or SQL text, written as a template
 * whose every placeholder is a heading, rows(...), which the installation names by its row type's name, the one its
 * function's search_path resolves.
 */
export interface FunctionBody extends Built {
	readonly kind: "body"
}

/**
 * A declared function (schema/function.ts fn): its name, its argument types by name in declared order, its result
 * type, its volatility, its null input, and the language of its body, which its Description holds.
 */
export interface DeclaredFunction<
	out Name extends string,
	out Args extends Readonly<Record<string, FunctionType>>,
	out Returns extends FunctionType,
	out V extends FunctionVolatility,
	out N extends FunctionNullInput
> extends Built {
	readonly kind: "function"
	readonly name: Name
	readonly args: Args
	readonly returns: Returns
	readonly volatility: V
	readonly nullInput: N
	readonly language: DeclaredLanguage
}

/** Any declared function: the members every one has. */
export type AnyFunction = DeclaredFunction<
	string,
	Readonly<Record<string, FunctionType>>,
	FunctionType,
	FunctionVolatility,
	FunctionNullInput
>

/**
 * Whether a field is a type a declared function's signature takes: a value of a base type PostgreSQL passes as it is, a
 * closed id, a digest, or a contract or refined text over one, never a serial or other field of a writing of its own,
 * money, an exact value, bytes, a set, a span or a vector.
 */
type SignatureRefused<F> = F extends
	| { readonly writing: WritingTag }
	| {
			readonly sql:
				| "money"
				| "exact integer"
				| "exact money"
				| "bits"
				| "range"
				| "vector"
				| StoredOnlySql
	  }
	? true
	: false

/** The refusal of a field no signature takes (SignatureRefused). */
type SignatureRefusal =
	Refusal<"a declared function takes and returns values of a base type, a closed id, a digest, a contract or a refined text over one: no serial, money, exact value, bytes, set, span or vector">

/**
 * A signature's type, or a heading's field: rows or a row of a heading, already checked where rows() built it, or a
 * value of a field it takes.
 */
export type SignatureCheck<T> = T extends Rows<unknown> | Row<unknown>
	? unknown
	: SignatureRefused<T> extends true
		? SignatureRefusal
		: unknown

/** Each field of a heading a signature takes, the others refused at their keys. */
export type HeadingCheck<Fields> = { readonly [K in keyof Fields]: SignatureCheck<Fields[K]> }

/** Each argument a signature takes, the others refused at their keys. */
export type ArgsCheck<Args> = { readonly [K in keyof Args]: SignatureCheck<Args[K]> }
