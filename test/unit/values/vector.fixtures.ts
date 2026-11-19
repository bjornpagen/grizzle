/** What the properties of vector.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { float } from "@bjornpagen/testing/values"
import { Array as Arr } from "effect"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"

/** The largest finite 32-bit float. */
const float32Max = 3.4028234663852886e38

/** A finite 32-bit float. */
export const finiteFloat: Gen<number> = float(-float32Max, float32Max)

/** Any 32-bit float: finite ones, -0 and the subnormals among them, and now and then NaN or an infinity. */
export const anyFloat: Gen<number> = weighted([
	[9, finiteFloat],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

/** A finite component, or -0, the one zero the text writes otherwise. */
export const componentGen: Gen<number> = weighted([
	[9, finiteFloat],
	[1, constant(-0)]
])

export type RoundTripFeature = "a -0 component" | "one component" | "several components"

/** A revived Vector, failing the test where the canonical decoder revived anything else. */
export const vectorOf = (value: unknown): Vector => {
	assert.ok(isVector(value))
	return value
}

/**
 * Vector.admit over a buffer and a dimension count (values/vector.ts): a Float32Array only, whatever else a caller passes
 * being vectorType; a count that is an integer in pgvector's storage range 1-16000 and the buffer's length, every other
 * being vectorDimensions; the components never checked here (NaN and infinity are refused where the vector is encoded,
 * since the buffer can change after construction). Vector.make raises CompileError for every refusal.
 */
export type Buffer =
	| "a Float32Array"
	| "a Float64Array"
	| "an Int32Array"
	| "an array"
	| "a Set"
	| "a string"
	| "an array-like"

export type Count =
	| "its length"
	| "one more"
	| "one less"
	| "a fraction"
	| "zero"
	| "the maximum"
	| "past the maximum"

export const buffers: Arr.NonEmptyReadonlyArray<Buffer> = [
	"a Float32Array",
	"a Float64Array",
	"an Int32Array",
	"an array",
	"a Set",
	"a string",
	"an array-like"
]

export const counts: Arr.NonEmptyReadonlyArray<Count> = [
	"its length",
	"one more",
	"one less",
	"a fraction",
	"zero",
	"the maximum",
	"past the maximum"
]

/** A canonical payload with one planted corruption is no canonical payload: refused as MalformedDescription. */
export type PayloadCorruption =
	| "no brackets"
	| "an empty list"
	| "a trailing comma"
	| "a leading comma"
	| "a space"
	| "negative zero"
	| "NaN"
	| "an overflowing component"
	| "trailing text"
	| "a longer spelling"

export const payloadCorruptions: Arr.NonEmptyReadonlyArray<PayloadCorruption> = [
	"no brackets",
	"an empty list",
	"a trailing comma",
	"a leading comma",
	"a space",
	"negative zero",
	"NaN",
	"an overflowing component",
	"trailing text",
	"a longer spelling"
]
