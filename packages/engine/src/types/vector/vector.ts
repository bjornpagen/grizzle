import type { Vector } from "#compiler/scalar/values/vector.ts"
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
 * - `Vector.from(buffer, n)` is the explicit validated boundary into the cosine domain: a Float32Array, or
 *   a vector of n dimensions, whose components are finite and whose native norm lies in [2^-16, 2^16]. It returns a
 *   Result whose failure is the codec's EncodingFailure with a fixed fault word (vectorDimensions, vectorNonFinite,
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
 * The head fields an approximate search may rank by: `by` names a cosineDistance output, which is a double precision
 * number, over vectors of one dimension count.
 */
type DistanceFieldsOf<Head> = {
	[K in keyof Head]-?: Head[K] extends number ? K : never
}[keyof Head] &
	string

/** A sealed candidate source of at most `take` facts, the nearest by `by`. */
export interface ApproximateNearestSpec<Head> {
	readonly by: DistanceFieldsOf<Head>
	readonly take: number
}
