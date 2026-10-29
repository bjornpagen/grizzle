import { type Infer, pg, Vector } from "#compiler/public/fields.ts"

/**
 * The vector carrier's refusals, the type half of test/unit/vector's runtime tests: a
 * vector is a branded Float32Array, model-agnostic, its dimension count an equality-only tag, so no host value crosses
 * dimension counts implicitly, and no array of numbers is a vector.
 * Typechecked only. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 */
export const DocumentVector = pg.vector(4)

/** A vector of the field's dimensions is the field's host value; Vector.from is the boundary into the cosine domain. */
export const made: Infer<typeof DocumentVector> = Vector.make(Float32Array.of(1, 0, 0, 0), 4)
export const fromRaw = Vector.from(Float32Array.of(1, 0, 0, 0), DocumentVector.dimensions)

// @ts-expect-error -- TS2322: a vector of other dimensions is another type, so no host value crosses them implicitly
export const crossed: Vector<4> = Vector.make(Float32Array.of(1, 0, 0), 3)
// @ts-expect-error -- TS2322: the field's host value has the field's dimensions
export const otherHost: Infer<typeof DocumentVector> = Vector.make(Float32Array.of(1, 0, 0), 3)

export const fromOtherDimensions = Vector.from(
	// @ts-expect-error -- TS2345: Vector.from refuses a vector of other dimensions, which no conversion reaches
	Vector.make(Float32Array.of(1, 0, 0), 3),
	DocumentVector.dimensions
)
// @ts-expect-error -- TS2345: a vector is a Float32Array, never an array of numbers
export const fromArray = Vector.from([1, 0, 0, 0], DocumentVector.dimensions)
// @ts-expect-error -- TS2345: Vector.make takes a Float32Array, never an array of numbers
export const madeFromArray = Vector.make([1, 0, 0, 0], 4)
// @ts-expect-error -- TS2345: a Float64Array is not a vector's buffer
export const fromDoubles = Vector.from(new Float64Array(4), DocumentVector.dimensions)
declare const buffer: Float32Array
// @ts-expect-error -- TS2322: a Float32Array is a Vector only through Vector.make or Vector.from, which brand it
export const unbranded: Vector<4> = buffer
// @ts-expect-error -- TS2345: the dimension count is a number
export const textDimensions = Vector.make(Float32Array.of(1, 0, 0, 0), "4")
