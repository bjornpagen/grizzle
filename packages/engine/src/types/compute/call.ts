import type { Built, phantom } from "#compiler/core/phantom.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type {
	Facts,
	Headed,
	Meets,
	OperandOrigin,
	ParamsContribution,
	ParamsOfTerm,
	Refusal,
	Source,
	Term,
	UnhostedOrigin,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"
import type { Field, FieldBase, LiteralOf } from "#compiler/types/fields/field.ts"
import type { DeclaredFunction, FunctionType, Rows } from "#compiler/types/schema/function.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"

/**
 * Compute.call(f, args) and Compute.rowsOf(f, args) (query/build/call.ts): a call of a declared function
 * (schema/function.ts fn), the value of one that returns a value, a term, and the rows of one that returns rows, a
 * source a rule matches.
 */

/**
 * What a call passes at an argument of declared type T: for a value of a field, a term that meets the field's domain or
 * a JavaScript value of its language, as a bind map binds a parameter; for rows of a heading, a query or a bound query
 * whose facts are the heading's.
 */
type CallArgOf<T> =
	T extends Rows<infer Fields>
		? Source<FactOfFields<Fields>>
		: T extends Field<infer H, infer S, infer D, infer _F>
			? Meets<D, S> | LiteralOf<H>
			: never

/** The arguments of a call of a function of arguments Args, each by its declared name, every one of them. */
export type CallArgs<Args> = { readonly [K in keyof Args]: CallArgOf<Args[K]> }

/** Every argument the function declares and none other: a stray key is refused at its key. */
export type ExactCallArgs<A, Args> = {
	readonly [K in keyof A]: K extends keyof Args
		? unknown
		: Refusal<"an argument the function declares">
}

/** The parameters a call's arguments need: each term's own, and what each bound query contributes. */
export type CallParams<A> = UnionToIntersection<
	{
		[K in keyof A]-?: ParamsContribution<
			A[K] extends { readonly [phantom]?: { readonly sourceParams: infer SP } | undefined }
				? SP
				: ParamsOfTerm<A[K]>
		>
	}[keyof A]
>

/** The origins a call's arguments read, on which its value or its rows depend. */
export type CallReads<A> = {
	[K in keyof A]-?: A[K] extends { readonly [phantom]?: { readonly reads: infer Rd } | undefined }
		? Rd
		: OperandOrigin<A[K]>
}[keyof A]

/**
 * The rows a call of a rows-returning function delivers, a source a rule matches as it matches a bound query
 * (types/query/query.ts BoundSource): its facts the heading's, its carriers the heading's descriptors, the parameters
 * its arguments need, and the origins they read, on which the rows depend. It names no schema: a call reads no
 * relation, and its rows arguments are queries the engine holds to the rule's levels where the rule matches it.
 */
export interface CallSource<out Head, out SP, out Hc, out Rd> extends Built, Headed<Hc> {
	readonly [phantom]?:
		| {
				readonly heading: Head
				readonly sourceParams: SP
				readonly readsContexts: (read: never) => void
				readonly reads: Rd
		  }
		| undefined
}

/** A function a term calls: one that returns a value of a field, immutable or stable. */
export type ValueFunction<Args, H, S extends SqlTag, D, F extends Facts> = DeclaredFunction<
	string,
	Args & Readonly<Record<string, FunctionType>>,
	Field<H, S, D, F>,
	"immutable" | "stable"
>

/** A function a rule matches the rows of: one that returns rows of a heading. */
export type RowsFunction<
	Args,
	Fields extends Readonly<Record<string, FieldBase>>
> = DeclaredFunction<
	string,
	Args & Readonly<Record<string, FunctionType>>,
	Rows<Fields>,
	"immutable" | "stable" | "volatile"
>

/**
 * The value of a call: a term of the function's result field, its domain, SQL type, language and facts, needing what
 * its arguments need, of a computed origin over theirs that no host evaluates (UnhostedOrigin), so a contract
 * predicate, a row check and a generated field refuse it (Hosted).
 */
export type CalledTerm<A, H, S extends SqlTag, D, F extends Facts> = Term<
	D,
	CallParams<A>,
	UnhostedOrigin<CallReads<A>>,
	S,
	H,
	F
>
