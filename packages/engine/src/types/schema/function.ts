import type {
	DeclaredLanguage,
	FunctionNullInput,
	FunctionVolatility
} from "#compiler/core/function.ts"
import type { Built } from "#compiler/core/phantom.ts"
import type { Refusal } from "#compiler/types/core/phantom.ts"
import type {
	FieldBase,
	HandleOf,
	Infer,
	OwnKeyOf,
	StoredOnlySql,
	WritingTag
} from "#compiler/types/fields/field.ts"

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
 * A variant's spelling in a declared function's body (fn.body), its code of an arm, an arm field's attribute or a value
 * of an arm (public/fields.ts variant `code`, `attribute`, `of`), which the installation prints under its codes and
 * layout (ir/desc.ts VariantSpellingDesc).
 */
export interface VariantSpelling extends Built {
	readonly kind: "spelling"
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
				| "bit"
				| "range"
				| "vector"
				| StoredOnlySql
	  }
	? true
	: false

/** The refusal of a field no signature takes (SignatureRefused). */
type SignatureRefusal =
	Refusal<"a declared function takes and returns values of a base type, a closed id, a digest, a contract or a refined text over one, or a variant: no serial, money, exact value, bytes, set, range or vector">

/**
 * Whether a field is a closed id of a subset of its roster, its host type short of the roster's handles: no function's
 * body is a value of a subset, so a function's closed id is of its whole roster (schema/function-own.ts subsetId).
 */
type SubsetRefused<F> = F extends { readonly roster: infer C; readonly sql: "code" }
	? [Exclude<HandleOf<C>, Infer<F>>] extends [never]
		? false
		: true
	: false

/**
 * A signature's type, or a heading's field: rows or a row of a heading, already checked where rows() built it, or a
 * value of a field it takes.
 */
export type SignatureCheck<T> = T extends Rows<unknown> | Row<unknown>
	? unknown
	: SignatureRefused<T> extends true
		? SignatureRefusal
		: SubsetRefused<T> extends true
			? Refusal<"a declared function's closed id is of its whole roster: no function's body is a value of a subset">
			: unknown

/**
 * The consumers' contracts a field holds a value of, each as its name and its own key (types/fields OwnKeyOf): itself
 * where it is one, then its base's down its chain.
 */
type OwnedOfField<F> = F extends { readonly base: infer B; readonly name: infer N extends string }
	? ([OwnKeyOf<F>] extends [never] ? never : readonly [N, OwnKeyOf<F>]) | OwnedOfField<B>
	: never

/**
 * The consumers' contracts a function type holds a value of, each as its name and its key (OwnedOfField): its value's,
 * each field's of rows or a row of a heading, at any depth, and each field's of a variant's arms.
 */
type OwnedIn<T> =
	T extends Rows<infer Fields>
		? OwnedInFields<Fields>
		: T extends Row<infer Heading>
			? OwnedIn<Heading>
			: T extends { readonly arms: infer Arms }
				? { readonly [A in keyof Arms]: OwnedInFields<Arms[A]> }[keyof Arms]
				: OwnedOfField<T>

/**
 * The consumers' contracts the fields of a heading or a variant's arm hold a value of (OwnedIn); none the types name for
 * a heading of any fields, AnyRows', whose function the engine judges (schema/function.ts admitMints).
 */
type OwnedInFields<Fields> = string extends keyof Fields
	? never
	: { readonly [K in keyof Fields]: OwnedIn<Fields[K]> }[keyof Fields]

/**
 * What a declared function takes after its definition: where its result holds a value of a consumer's contract at any
 * depth (OwnedIn), its body makes the contract's values, so it takes the contract's key by the contract's name,
 * `{ QtiInteger: qtiIntegerKey }`, every such contract's, as mintOf takes each on the host; nothing otherwise.
 */
export type MintsOf<T> = [OwnedIn<T>] extends [never]
	? readonly []
	: readonly [mints: { readonly [P in OwnedIn<T> as P[0]]: P[1] }]

/** Each field of a heading a signature takes, the others refused at their keys. */
export type HeadingCheck<Fields> = { readonly [K in keyof Fields]: SignatureCheck<Fields[K]> }

/** Each argument a signature takes, the others refused at their keys. */
export type ArgsCheck<Args> = { readonly [K in keyof Args]: SignatureCheck<Args[K]> }
