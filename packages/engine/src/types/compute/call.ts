import type { FunctionNullInput } from "#compiler/core/function.ts"
import type { Built, phantom } from "#compiler/core/phantom.ts"
import type { CallNumbering, callNumberings } from "#compiler/ir/rel.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type {
	BindMapParams,
	Carriers,
	Facts,
	Headed,
	Meets,
	OperandOrigin,
	Refusal,
	RequireBound,
	Source,
	Term,
	UnhostedOrigin
} from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { Field, FieldBase, LiteralOf } from "#compiler/types/fields/field.ts"
import type { DeclaredFunction, FunctionType, Row, Rows } from "#compiler/types/schema/function.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"

/**
 * Fn.call(f, args), Fn.rows(f, args) and Fn.row(f, args) (query/build/call.ts): a call of a declared
 * function (schema/function.ts fn), the value of one that returns a value, a term; the rows of one that returns rows, a
 * source a rule matches; and the fields of the one row one returns, each that holds rows of values a source.
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

/**
 * Every argument the function declares and none other, each bound: a stray key is refused at its key, and so is a rows
 * argument that is a query of parameters passed unbound (RequireBound), since the engine binds an imported query's
 * parameters by its bind map alone, never by name from the calling rule's.
 */
export type ExactCallArgs<A, Args> = {
	readonly [K in keyof A]: K extends keyof Args
		? RequireBound<A[K]>
		: Refusal<"an argument the function declares">
}

/** The origins a call's arguments read, on which its value or its rows depend. */
export type CallReads<A> = {
	[K in keyof A]-?: A[K] extends { readonly [phantom]?: { readonly reads: infer Rd } | undefined }
		? Rd
		: OperandOrigin<A[K]>
}[keyof A]

/**
 * The rows a call of a rows-returning function delivers, a source a rule matches as it matches a bound query
 * (types/query/query.ts BoundSource): its facts the heading's, its carriers the heading's descriptors, the parameters
 * its arguments need, the origins they read, on which the rows depend, and how the rows of one evaluation stand among
 * themselves, N, the engine's (ir/rel.ts callNumberings), whose keys a match of it reads as a bound import's, per
 * binding of what its arguments read (CallEvidence). It names no schema: a call reads no relation, and its rows
 * arguments are queries the engine holds to the rule's levels where the rule matches it.
 */
export interface CallSource<out Head, out SP, out Hc, out Rd, out N extends CallNumbering>
	extends Built, Headed<Hc> {
	readonly [phantom]?:
		| {
				readonly heading: Head
				readonly sourceParams: SP
				readonly readsContexts: (read: never) => void
				readonly reads: Rd
				readonly evidence: CallEvidence<N>
		  }
		| undefined
}

/** How the rows of one evaluation of each call stand among themselves, the engine's table (ir/rel.ts callNumberings). */
export type CallNumberings = typeof callNumberings

/**
 * The evidence of the rows of one evaluation of a call, numbered N (ir/rel.ts CallNumbering), which a match of the call
 * reads (evidence/evidence.ts ShownKeysOf): one row or none is keyed by nothing past what its arguments read, so an
 * arm's source of a cell a key fixes is at most one row; rows a column numbers are keyed by it; a set by its heading
 * alone.
 */
type CallEvidence<N extends CallNumbering> = N extends { readonly kind: "one" }
	? { readonly keys: readonly [readonly []]; readonly card: "atMostOne" }
	: N extends { readonly kind: "numbered"; readonly ordinal: infer O extends string }
		? { readonly keys: readonly [readonly [O]]; readonly card: "many" }
		: Evidence.Unknown

/** A function a term calls: one that returns a value of a field, immutable or stable. */
export type ValueFunction<Args, H, S extends SqlTag, D, F extends Facts> = DeclaredFunction<
	string,
	Args & Readonly<Record<string, FunctionType>>,
	Field<H, S, D, F>,
	"immutable" | "stable",
	FunctionNullInput
>

/** A function a rule matches the rows of: one that returns rows of a heading. */
export type RowsFunction<
	Args,
	Fields extends Readonly<Record<string, FieldBase>>
> = DeclaredFunction<
	string,
	Args & Readonly<Record<string, FunctionType>>,
	Rows<Fields>,
	"immutable" | "stable" | "volatile",
	FunctionNullInput
>

/**
 * A function a rule matches the fields of the one row of: one that returns one row of a heading, immutable or stable,
 * so every read of its row's fields at one argument tuple reads one evaluation of it.
 */
export type RowFunction<
	Args,
	Fields extends Readonly<Record<string, FunctionType>>
> = DeclaredFunction<
	string,
	Args & Readonly<Record<string, FunctionType>>,
	Row<Rows<Fields>>,
	"immutable" | "stable",
	FunctionNullInput
>

/** The fields of a row a query reads (CallFields): each that holds rows of a heading of values alone. */
type ReadFields<Fields> = {
	[K in keyof Fields]: Fields[K] extends Rows<infer F>
		? F extends Readonly<Record<string, FieldBase>>
			? K
			: never
		: never
}[keyof Fields]

/**
 * The fields of a call of a function of one row (Fn.row), by name: each field of the row that holds rows of a
 * heading of values, the rows it holds a source of that heading, as Fn.rows's rows are (CallSource), every one
 * of them read from one evaluation of the call. A field of a value, of one row, or of rows whose heading holds rows or
 * a row is no source, which only another function's body reads.
 */
export type CallFields<A, Fields> = {
	readonly [K in ReadFields<Fields>]: Fields[K] extends Rows<
		infer F extends Readonly<Record<string, FieldBase>> & Carriers
	>
		? CallSource<FactOfFields<F>, BindMapParams<A>, F, CallReads<A>, CallNumberings["field"]>
		: never
}

/**
 * The value of a call: a term of the function's result field, its domain, SQL type, language and facts, needing what
 * its arguments need, of a computed origin over theirs that no host evaluates (UnhostedOrigin), so a contract
 * predicate, a row check and a generated field refuse it (Hosted).
 */
export type CalledTerm<A, H, S extends SqlTag, D, F extends Facts> = Term<
	D,
	BindMapParams<A>,
	UnhostedOrigin<CallReads<A>>,
	S,
	H,
	F
>
