import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { bareEnv, carrierSql, type Descriptor, defineField } from "#compiler/scalar/registry.ts"
import { convertVector } from "#compiler/scalar/values/convert.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"

/** Its column converts vector_out text into a Vector of its N dimensions. */
interface VectorDescriptor<N extends number = number> extends Descriptor<"vector"> {
	readonly dimensions: N
	readonly column: Column<Vector<N>>
}

/**
 * The admission core: a JavaScript caller can pass anything, so the dimensions are checked and any
 * further argument is refused.
 */
export const admitVectorDimensions = (
	dimensions: unknown,
	...extra: ReadonlyArray<unknown>
): void => {
	if (extra.length > 0) {
		throw malformedDescription(captureLoc("pg.vector", []), "pg.vector(n): the dimensions alone")
	}
	if (
		typeof dimensions !== "number" ||
		!Number.isInteger(dimensions) ||
		dimensions < 1 ||
		dimensions > vectorMaxDimensions
	) {
		throw malformedDescription(
			captureLoc("pg.vector dimensions", []),
			`vector dimensions: an integer 1-${vectorMaxDimensions}`
		)
	}
}

/**
 * pg.vector(n): the pgvector field descriptor.
 *
 * `n` is the native type's fixed dimensions, 1..16000, pgvector's storage limit; the 2000-dimension HNSW limit is a
 * retrieval capability decided where approximate retrieval is compiled, not a field limit. A vector is
 * model-agnostic: the dimension count is its only identity beside the carrier, an equality-only literal tag in the
 * type, so a distance or a write between vectors of two dimension counts is a compile error, and the
 * runtime checks every value's component count.
 */
export const vector = <const N extends number>(
	dimensions: N,
	...extra: ReadonlyArray<never>
): VectorDescriptor<N> => {
	admitVectorDimensions(dimensions, ...extra)
	return defineField(
		{},
		carrierSql.vector,
		{ kind: "vector", dimensions },
		{ dimensions, column: convertColumn(convertVector(dimensions)) },
		SourceLoc("pg.vector", []),
		bareEnv
	)
}
