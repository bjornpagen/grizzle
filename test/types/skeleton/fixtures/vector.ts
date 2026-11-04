import { Compute } from "#compiler/public/compute.ts"
import { pg, type Uuid, uuid, Vector } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { ParamType } from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { Infer } from "#compiler/types/fields/field.ts"
import type { EvidenceOfQuery, HeadOf, ParamsOf } from "#compiler/types/query/query.ts"
import type { VectorField } from "#compiler/types/vector/vector.ts"
import { query, v } from "#index.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/**
 * pgvector over declare-only values: vector fields, the Float32Array carrier, cosine distance and the approximate
 * candidate source. Every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * A vector field's host type is the vector carrier, a branded Float32Array typed by its dimension count, an
 * equality-only tag.
 */
export const Embedding = pg.vector(3)
export type EmbeddingField = Expect<Equals<typeof Embedding, VectorField<3>>>
export type EmbeddingHost = Expect<Equals<Infer<typeof Embedding>, Vector<3>>>

/** Vector.make builds the carrier a column of the same dimensions holds. */
export const probe: Infer<typeof Embedding> = Vector.make(Float32Array.of(0.1, 0.2, 0.3), 3)
export const plain: Infer<typeof Embedding> = Vector.make(new Float32Array(3), 3)
// @ts-expect-error -- TS2322: a vector of other dimensions is another type
export const wrongDimensions: Infer<typeof Embedding> = Vector.make(Float32Array.of(0.1, 0.2), 2)

/** Scoring documents by distance from a query vector parameter. */
export const DocumentEmbedding = relation(
	"DocumentEmbedding",
	{ document: uuid, value: Embedding, other: pg.vector(4), image: pg.vector(3) },
	["document"]
)
export const Search = schema("Search", { DocumentEmbedding }, [])
export const scored = query(Search).rule((r) => {
	const { document, value } = v(DocumentEmbedding, "documentEmbedding")
	return r.match(DocumentEmbedding, { document, value }).find({
		document,
		distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
	})
})

export type ScoredHead = Expect<
	Equals<HeadOf<typeof scored>, { readonly document: Uuid; readonly distance: number }>
>
export type ScoredParams = Expect<
	Equals<ParamsOf<typeof scored>, { readonly vector: ParamType<Vector<3>, "vector"> }>
>
export const selfDistance = query(Search).rule((r) => {
	const a = v(DocumentEmbedding, "first")
	const b = v(DocumentEmbedding, "second")
	return r
		.match(DocumentEmbedding, { document: a.document, value: a.value })
		.match(DocumentEmbedding, { document: b.document, value: b.value })
		.find({ a: a.document, b: b.document, distance: Compute.cosineDistance(a.value, b.value) })
})

export const wrongDimensionsDistance = query(Search).rule((r) => {
	const { document, value, other } = v(DocumentEmbedding, "documentEmbedding")
	return (
		r
			.match(DocumentEmbedding, { document, value, other })
			// @ts-expect-error -- TS2345: cosine distance needs one dimension count
			.find({ document, distance: Compute.cosineDistance(value, other) })
	)
})

/** Vectors are model-agnostic: any two vector fields of one dimension count have a cosine distance. */
export const sameDimensionsDistance = query(Search).rule((r) => {
	const { document, value, image } = v(DocumentEmbedding, "documentEmbedding")
	return r
		.match(DocumentEmbedding, { document, value, image })
		.find({ document, distance: Compute.cosineDistance(value, image) })
})

export type SameDimensionsHead = Expect<
	Equals<
		HeadOf<typeof sameDimensionsDistance>,
		{ readonly document: Uuid; readonly distance: number }
	>
>

export const notAVector = query(Search).rule((r) => {
	const { document } = v(DocumentEmbedding, "documentEmbedding")
	return (
		r
			.match(DocumentEmbedding, { document })
			// @ts-expect-error -- TS2345: cosine distance needs a vector term
			.find({ distance: Compute.cosineDistance(document, document) })
	)
})

/** approximateNearest ranks by a distance field and seals a candidate source; its evidence is unknown. */
export const nearest = scored.approximateNearest({ by: "distance", take: 10 })
export type NearestHead = Expect<Equals<HeadOf<typeof nearest>, HeadOf<typeof scored>>>
export type NearestParams = Expect<Equals<ParamsOf<typeof nearest>, ParamsOf<typeof scored>>>
export type NearestEvidence = Expect<Equals<EvidenceOfQuery<typeof nearest>, Evidence.Unknown>>
// @ts-expect-error -- TS2322: by names a distance output, not a key field
export const nearestByDocument = scored.approximateNearest({ by: "document", take: 10 })
