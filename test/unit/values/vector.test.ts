/**
 * The Vector carrier (scalar/values/vector.ts) and its canonical payload (ir/carriers.ts VectorText).
 *
 * - Construction: Vector.admit takes a Float32Array of exactly its dimension count, an integer 1-vectorMaxDimensions,
 *   never checking its components; any other buffer is vectorType and any other count vectorDimensions, and Vector.make
 *   raises CompileError for each. Oracle: the construction rule as a checker, the count read before the buffer.
 * - Wild values: admit refuses every wild value as vectorType, and admits a live buffer as a copy grizzle alone holds,
 *   which a later write to the buffer never reaches. Oracle: the boundary's specification, and the buffer written after.
 * - Payloads: a canonical payload with one corruption planted is refused as MalformedDescription. Oracle: the
 *   payload grammar's complement, each corruption a named case.
 * - Round trip: every float32 vector's canonical text decodes to its components bit for bit, -0 as 0; a host vector
 *   and its canonical form write one text; the canonical form is a frozen snapshot of the buffer; a non-finite
 *   component has no text. Oracle: universal, decode ∘ encode = id.
 *
 * Features: each buffer kind and count; live and every wild kind; each payload corruption; a -0 component, and one and
 * several components.
 *
 * Plants: values-vector-max-dimensions (the greatest dimension count refused), values-vector-uncopied (admit keeps the
 * caller's buffer), values-vector-payload-spelling (a payload component's spelling unchecked),
 * values-vector-negative-zero-text (a -0 component written as -0).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, map, weighted } from "@grizzle/testing/gen"
import { type DrawnFeature, drawnFeature, lsw, passed, WILD_KINDS } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, String as Str } from "effect"
import { decode, encode, everyProperty } from "#compiler/core/canonical.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"
import { assert, faulted, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The largest finite 32-bit float. */
const float32Max = 3.4028234663852886e38

/** A finite 32-bit float. */
const finiteFloat: Gen<number> = float(-float32Max, float32Max)

/** Any 32-bit float: finite ones, -0 and the subnormals among them, and now and then NaN or an infinity. */
const anyFloat: Gen<number> = weighted([
	[9, finiteFloat],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

/** A finite component, or -0, the one zero the text writes otherwise. */
const componentGen: Gen<number> = weighted([
	[9, finiteFloat],
	[1, constant(-0)]
])

type RoundTripFeature = "a -0 component" | "one component" | "several components"

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
						oracle: {
							kind: "specification",
							name: "the construction rule: a Float32Array of exactly its count, 1-vectorMaxDimensions, the count read first"
						},
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
						caseHang
					},
					({ buffer, count, components }, c) =>
						Effect.sync(() => {
							c.note(`buffer ${buffer}`)
							c.note(`count ${count}`)
							const length =
								count === "the maximum" || count === "past the maximum"
									? count === "the maximum"
										? vectorMaxDimensions.value
										: vectorMaxDimensions.value + 1
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
							const countOk =
								Number.isInteger(dims) && dims >= 1 && dims <= vectorMaxDimensions.value
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
						oracle: {
							kind: "specification",
							name: "the boundary: every wild value vectorType, a live buffer copied"
						},
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
						caseHang
					},
					(d, c) =>
						Effect.sync(() => {
							c.note(drawnFeature(d))
							const admitted = Vector.admit(passed(d), 3)
							if (d.kind === "live") {
								/**
								 * A copy grizzle alone holds: the buffer's components, never the buffer, so a later write to
								 * it reaches no admitted value.
								 */
								const vector = succeeded(admitted)
								assert.ok(vector !== d.value, "a copy, never the caller's buffer")
								assert.ok(
									vector.length === d.value.length &&
										vector.every((x, i) => Object.is(x, d.value[i])),
									"the buffer's components"
								)
								const buffer = new Float32Array(d.value)
								const held = succeeded(Vector.admit(buffer, 3))
								buffer[0] = (buffer[0] ?? 0) + 1
								assert.ok(
									Object.is(held[0], d.value[0]),
									"a later write to the buffer reaches no admitted value"
								)
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
					oracle: {
						kind: "specification",
						name: "the payload grammar's complement: each corruption spells no canonical vector"
					},
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
					caseHang
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

	it.effect(
		"round-trips every float32 vector bit for bit, a host vector one text with its canonical form",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "universal", name: "decode ∘ encode = id, -0 read as 0" },
						suite: "unit/values/vector-1",
						draw: drawn(array(componentGen, { min: 1, max: 8 })),
						literal: Formatter.format,
						coverage: required<RoundTripFeature>(
							["a -0 component", "one component", "several components"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(xs, c) =>
						Effect.sync(() => {
							c.note(xs.length === 1 ? "one component" : "several components")
							if (Arr.some(xs, (x) => Object.is(x, -0))) {
								c.note("a -0 component")
							}
							const v = Vector.make(Float32Array.from(xs), xs.length)
							const encoded = succeeded(encode(succeeded(Vector.canonical(v)), everyProperty))
							assert.equal(
								succeeded(encode(v, everyProperty)),
								encoded,
								"a host vector's text is its canonical form's"
							)
							const back = vectorOf(succeeded(decode(encoded, { v: Vector.fromCanonical })))
							assert.deepEqual<Float32Array>(
								back,
								Float32Array.from(xs, (x) => (x === 0 ? 0 : x)),
								"the vector read back is its components bit for bit, -0 as 0"
							)
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
							assert.equal(
								succeeded(encode(buffer, everyProperty)),
								succeeded(encode(succeeded(Vector.canonical(buffer)), everyProperty)),
								"a buffer's text is its components' as they are when it is read"
							)
							refused(
								encode(Float32Array.from([...xs, Number.NaN]), everyProperty),
								"MalformedDescription"
							)
							faulted(
								Vector.canonical(
									Vector.make(Float32Array.from([...xs, Number.NaN]), xs.length + 1)
								),
								"vectorNonFinite"
							)
						})
				)
			)
	)
})
