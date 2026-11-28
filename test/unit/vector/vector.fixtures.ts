/** What the properties of vector.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import { float } from "@bjornpagen/testing/values"
import { Array as Arr } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { Distance } from "#compiler/public/compute.ts"
import type { Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/fault.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { codecOf } from "#test/support/unit/codec/support.ts"

export const dims = search.DocumentVector.dimensions
export const lowest = cosineNormMin
export const highest = cosineNormMax
/** Half the least norm: four components of it have the least norm exactly. */
const quarterNorm = lowest / 2

/** The largest finite float32. */
const floatMax = Math.fround(3.4028234663852886e38)

/**
 * A component: the bounds and their neighbours, values that underflow or overflow float32, the non-finite ones, -0,
 * and any float.
 */
const componentGen = oneOf([
	element([
		0,
		-0,
		1,
		quarterNorm,
		lowest,
		Math.fround(lowest * (1 - 2 ** -24)),
		highest,
		highest * (1 + 2 ** -23),
		highest * 2,
		1e-50,
		1e39,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY
	]),
	float(-floatMax, floatMax)
])

/**
 * `length` components: drawn one by one, all equal (four components of half the least norm have the least norm
 * exactly), small components inside the domain with -0 among them, which reach an admitted buffer holding -0, or one
 * component at a bound of the norm and the others zero, whose norm is that bound.
 */
export const componentsGen = (length: number): Gen<ReadonlyArray<number>> =>
	oneOf([
		array(componentGen, { min: length, max: length }),
		map(componentGen, (x) => Array.from({ length }, () => x)),
		array(element([-0, 0, 1, quarterNorm]), { min: length, max: length }),
		map(element([lowest, highest, -lowest, -highest]), (bound) =>
			Array.from({ length }, (_, i) => (i === 0 ? bound : 0))
		)
	])

/**
 * A buffer: of the field's dimensions or not, its components drawn by componentsGen; and whether the caller writes
 * zeros into it after the check.
 */
interface BufferSketch {
	readonly length: number
	readonly components: ReadonlyArray<number>
	readonly zeroedAfter: boolean
}

export const bufferGen: Gen<BufferSketch> = (source) => ({
	length: source.draw(oneOf([constant(dims), int(dims - 1, dims + 1)])),
	components: source.draw(componentsGen(dims + 1)),
	zeroedAfter: source.draw(boolean)
})

/** The verdict of the cosine domain on a float32 buffer. */
type Verdict = "vectorDimensions" | "vectorNonFinite" | "vectorNorm" | "admitted"
export const verdictOf = (
	buffer: Float32Array
): { readonly verdict: Verdict; readonly norm: number } => {
	const norm = Math.sqrt(buffer.reduce((sum, x) => sum + x * x, 0))
	if (buffer.length !== dims) {
		return { verdict: "vectorDimensions", norm }
	}
	if (!buffer.every(Number.isFinite)) {
		return { verdict: "vectorNonFinite", norm }
	}
	return { verdict: norm >= lowest && norm <= highest ? "admitted" : "vectorNorm", norm }
}

export type DomainFeature =
	| "admitted at a bound"
	| "admitted inside"
	| "a norm below the domain"
	| "a norm above the domain"
	| "a non-finite component"
	| "other dimensions"
	| "an underflowing component"
	| "-0 written as 0"
	| "a buffer zeroed after its check"

export const literalQuery = (literal: Vector<4>) =>
	query(search.Search).rule((r) => {
		const { document, revision, value } = v(search.DocumentEmbedding, "documentEmbedding")
		return r
			.match(search.DocumentEmbedding, { document, revision, value })
			.find({ document, distance: Distance.cosine(value, literal) })
	})

export const sqlOf = (built: unknown) =>
	Arr.map(succeeded(compileTemplate(built, undefined, testCompile)).conservative, (s) => s.sql)

/** The codec of a vector field of the domain's dimensions. */
export const codec = codecOf(scalarOf({ kind: "vector", dimensions: dims }, {}), emptyCodebook)
