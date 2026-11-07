import type { Phantom } from "#compiler/core/phantom.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"
import type {
	ConstantOrigin,
	LiteralOrigin,
	Origin,
	ParamOrigin
} from "#compiler/types/core/phantom.ts"
import type { Field } from "#compiler/types/fields/field.ts"

export type { Vector } from "#compiler/scalar/values/vector.ts"

/**
 * pgvector types.
 *
 * Vector is the float32 carrier of packages/engine/src/scalar/values, the one type every layer shares: the type a
 * vector column's host values have, the value a parameter or member must be, and the value a decoder returns. A
 * Vector<N> is a Float32Array under the Effect brand "Vector" plus the dimension tag N, with no wrapper class: the
 * buffer the caller made is the vector, and mutating it afterwards is the caller's business. It is
 * model-agnostic: N is the column's dimension count, an equality-only literal tag, so a vector of other dimensions is
 * another type, and only `Vector.make` or `Vector.from` brands a Float32Array as a Vector. There is no number[]
 * anywhere in the vector API.
 *
 * - `Vector.make(buffer, n)` is the strict constructor: it checks that the Float32Array has n components, 1..16000,
 *   and makes no defensive copy. `Vector.make(buffer, 1536)` is a Vector<1536>. It throws CompileError
 *   MalformedDescription, the builders' throwing convenience.
 * - `Vector.from(buffer, n)` is the explicit validated boundary into the cosine domain: a Float32Array, or a vector of
 *   n dimensions, whose components are finite and whose native norm lies in the cosine domain (ir/carriers.ts
 *   cosineNormMin and cosineNormMax). It returns a Result whose failure is the codec's EncodingFailure with a fixed
 *   fault word (vectorDimensions, vectorNonFinite,
 *   vectorNorm, ...), never the value. The codec applies the same checks to every vector parameter and member when it
 *   encodes, from the buffer as it is then, writing -0 as 0, so a vector built by `Vector.make` outside the domain is
 *   refused before any SQL is sent, and the database CHECK refuses one a direct writer stores.
 *
 * A pgvector column of N dimensions.
 */
export interface VectorField<out N extends number> extends Field<Vector<N>, "vector"> {
	readonly dimensions: N
}

/**
 * A cosine distance's two operands, by origin, beside the term's own phantoms: what an approximate search reads of a
 * head field it ranks by (ApproximateNearestSpec). Compute.cosineDistance states it of its term.
 */
export type Scored<A, B> = Phantom<{ readonly scored: readonly [A, B] }>

/**
 * The head fields an approximate search over one rule's head of carriers Hc may rank by, as the checker traces `by`
 * (check/approximate/trace.ts): a cosineDistance output between a column of a matched relation and one query vector,
 * a parameter or a constant, in either order. Any other number, a distance of two columns among them, ranks nothing.
 */
type DistanceFieldsOf<Hc> = {
	readonly [K in keyof Hc]-?: Hc[K] extends Scored<infer A, infer B>
		? OneColumn<A, B> extends true
			? K
			: never
		: never
}[keyof Hc] &
	string

/** What a search's query vector is: a parameter, a JavaScript value or a typed constant, read once per execution. */
type QueryVector = ParamOrigin | LiteralOrigin | ConstantOrigin

/** Whether one operand of a distance is a column and the other a query vector. */
type OneColumn<A, B> = [A, B] extends [Origin, QueryVector]
	? true
	: [A, B] extends [QueryVector, Origin]
		? true
		: false

/** A sealed candidate source of at most `take` facts, the nearest by `by`, a distance field of the source's carriers. */
export interface ApproximateNearestSpec<Hc, K extends number> {
	readonly by: DistanceFieldsOf<Hc>
	readonly take: K
}
