import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, type Gen, map, weighted } from "@grizzle/testing/gen"
import { type DrawnFeature, drawnFeature, lsw, passed, WILD_KINDS } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, pipe, String as Str } from "effect"
import { decode, encode, everyProperty } from "#compiler/core/canonical.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"
import { assert, faulted, refused, succeeded } from "#test/support/assert.ts"

/** The largest finite 32-bit float. */
const float32Max = 3.4028234663852886e38

/** A finite 32-bit float. */
const finiteFloat: Gen<number> = float(-float32Max, float32Max)

/** Any 32-bit float: finite ones, -0 and the subnormals among them, and now and then NaN or an infinity. */
const anyFloat: Gen<number> = weighted([
	[9, finiteFloat],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

/** A revived Vector, failing the test where the canonical decoder revived anything else. */
const vectorOf = (value: unknown): Vector => {
	assert.ok(isVector(value))
	return value
}

/**
 * Vector.admit over a buffer and a dimension count (values/vector.ts): a Float32Array only, whatever else a caller passes
 * being vectorType; a count that is an integer in pgvector's storage range 1-16000 and the buffer's length, every other
 * being vectorDimensions; the components never checked here (NaN and infinity are refused where the vector is encoded,
 * since the buffer can change after construction). Vector.make raises CompileError for every refusal.
 */
type Buffer =
	| "a Float32Array"
	| "a Float64Array"
	| "an Int32Array"
	| "an array"
	| "a Set"
	| "a string"
	| "an array-like"

type Count =
	| "its length"
	| "one more"
	| "one less"
	| "a fraction"
	| "zero"
	| "the maximum"
	| "past the maximum"

const buffers: Arr.NonEmptyReadonlyArray<Buffer> = [
	"a Float32Array",
	"a Float64Array",
	"an Int32Array",
	"an array",
	"a Set",
	"a string",
	"an array-like"
]

const counts: Arr.NonEmptyReadonlyArray<Count> = [
	"its length",
	"one more",
	"one less",
	"a fraction",
	"zero",
	"the maximum",
	"past the maximum"
]

describe("Vector construction", () => {
	it.effect(
		"admits a Float32Array of its dimension count in 1-16000, never checking its components",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/values/vector-construction",
						draw: drawn((source) => ({
							buffer: source.draw(element(buffers)),
							count: source.draw(element(counts)),
							components: source.draw(array(anyFloat, { min: 1, max: 6 }))
						})),
						literal: Formatter.format,
						coverage: required<`buffer ${Buffer}` | `count ${Count}`>(
							[
								...Arr.map(buffers, (b) => `buffer ${b}` as const),
								...Arr.map(counts, (c) => `count ${c}` as const)
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ buffer, count, components }, c) =>
						Effect.sync(() => {
							c.note(`buffer ${buffer}`)
							c.note(`count ${count}`)
							const length =
								count === "the maximum" || count === "past the maximum"
									? count === "the maximum"
										? vectorMaxDimensions
										: vectorMaxDimensions + 1
									: components.length
							const xs =
								length === components.length ? components : Array.from({ length }, () => 0.5)
							const value: unknown =
								buffer === "a Float32Array"
									? Float32Array.from(xs)
									: buffer === "a Float64Array"
										? Float64Array.from(xs)
										: buffer === "an Int32Array"
											? Int32Array.from(xs, () => 1)
											: buffer === "an array"
												? xs
												: buffer === "a Set"
													? new Set(xs)
													: buffer === "a string"
														? `[${Arr.join(
																Arr.map(xs, (x) => String(x)),
																","
															)}]`
														: { length: xs.length, 0: xs[0] }
							const dims =
								count === "one more"
									? length + 1
									: count === "one less"
										? length - 1
										: count === "a fraction"
											? length + 0.5
											: count === "zero"
												? 0
												: length
							/** The count is read first, as the type's own dimension count; then the buffer, then its length. */
							const admitted = Vector.admit(value, dims)
							const countOk = Number.isInteger(dims) && dims >= 1 && dims <= vectorMaxDimensions
							if (countOk && buffer !== "a Float32Array") {
								faulted(admitted, "vectorType")
								return
							}
							if (!countOk || dims !== length) {
								faulted(admitted, "vectorDimensions")
								assert.throws(() => Vector.make(Float32Array.from(xs), dims), CompileError)
								return
							}
							assert.equal(succeeded(admitted).length, dims)
						})
				)
			)
	)
})

describe("Vector admission of a JavaScript caller's value", () => {
	it.effect(
		"admits a Float32Array of its dimensions and refuses every wild value as vectorType",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/values/vector-wild",
						draw: drawn(
							lsw<Float32Array>({
								live: map(array(finiteFloat, { min: 3, max: 3 }), (xs) => Float32Array.from(xs)),
								stale: Option.none(),
								wild: WILD_KINDS
							})
						),
						literal: Formatter.format,
						coverage: required<DrawnFeature<never>>(
							["live", ...Arr.map(WILD_KINDS, (kind): DrawnFeature<never> => `wild ${kind}`)],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						/** The rotating stream's sample of fourteen wild kinds beside the live arm. */
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(d, c) =>
						Effect.sync(() => {
							c.note(drawnFeature(d))
							const admitted = Vector.admit(passed(d), 3)
							if (d.kind === "live") {
								assert.ok(succeeded(admitted) === d.value, "the buffer itself, never a copy")
							} else {
								faulted(admitted, "vectorType")
							}
						})
				)
			)
	)
})

describe("Vector in the canonical serializer", () => {
	/** A canonical payload with one planted corruption is no canonical payload: refused as MalformedDescription. */
	type PayloadCorruption =
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
	const payloadCorruptions: Arr.NonEmptyReadonlyArray<PayloadCorruption> = [
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
	it.effect("revives only canonical payloads", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/vector-payloads",
					draw: drawn((source) => ({
						xs: source.draw(array(finiteFloat, { min: 1, max: 4 })),
						corruption: source.draw(element(payloadCorruptions))
					})),
					literal: Formatter.format,
					coverage: required<PayloadCorruption>(payloadCorruptions, {
						cases: 300,
						sense: notesOnly
					}),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				({ xs, corruption }, c) =>
					Effect.sync(() => {
						c.note(corruption)
						const text = Vector.componentText(Vector.make(Float32Array.from(xs), xs.length))
						const inner = Str.slice(1, -1)(text)
						const payload =
							corruption === "no brackets"
								? inner
								: corruption === "an empty list"
									? "[]"
									: corruption === "a trailing comma"
										? `[${inner},]`
										: corruption === "a leading comma"
											? `[,${inner}]`
											: corruption === "a space"
												? `[${inner}, 1]`
												: corruption === "negative zero"
													? `[${inner},-0]`
													: corruption === "NaN"
														? `[${inner},NaN]`
														: corruption === "an overflowing component"
															? `[${inner},1e39]`
															: corruption === "trailing text"
																? `${text}@`
																: `[${inner},0.1]`
						refused(Vector.fromCanonical(payload), "MalformedDescription", payload)
					})
			)
		)
	)

	it.effect("round-trips every float32 vector", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/vector-1",
					draw: drawn(array(finiteFloat, { min: 1, max: 8 })),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(xs) =>
					Effect.sync(() => {
						const v = Vector.make(Float32Array.from(xs), xs.length)
						const encoded = succeeded(encode(succeeded(Vector.canonical(v)), everyProperty))
						const back = vectorOf(succeeded(decode(encoded, { v: Vector.fromCanonical })))
						assert.equal(Vector.equals(back, v), true)
						assert.equal(Vector.componentText(back), Vector.componentText(v))
						for (const component of Str.split(
							pipe(Vector.componentText(v), Str.slice(1, -1)),
							","
						)) {
							assert.notEqual(component, "-0")
						}
						/**
						 * The canonical form is a frozen snapshot: writing the buffer later leaves it, and its text, as it was.
						 */
						const buffer = Float32Array.from(xs)
						const snapshot = succeeded(Vector.canonical(Vector.make(buffer, xs.length)))
						const text = succeeded(encode(snapshot, everyProperty))
						buffer[0] = 7
						assert.equal(succeeded(encode(snapshot, everyProperty)), text)
						refused(encode(buffer, everyProperty), "MalformedDescription")
						faulted(
							Vector.canonical(Vector.make(Float32Array.from([...xs, Number.NaN]), xs.length + 1)),
							"vectorNonFinite"
						)
					})
			)
		)
	)
})
