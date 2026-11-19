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
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, element, map } from "@bjornpagen/testing/gen"
import { type DrawnFeature, drawnFeature, lsw, passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, pipe, String as Str } from "effect"
import { decode, encode, everyProperty } from "#compiler/core/canonical.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { assert, faulted, refused, succeeded } from "#test/support/assert.ts"
import {
	anyFloat,
	type Buffer,
	buffers,
	componentGen,
	type Count,
	counts,
	finiteFloat,
	type PayloadCorruption,
	payloadCorruptions,
	type RoundTripFeature,
	vectorOf
} from "#test/unit/values/vector.fixtures.ts"

/** Vector construction admits a Float32Array of its dimension count in 1-16000, never checking its components. Its budget is its suite's before it was a property (test/unit/values/vector.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const vectorConstructionAdmitsAFloat32ArrayOfItsDimensionCountIn116000NeverCheckingItsComponents =
	property.explore(
		(source) => ({
			buffer: source.draw(element(buffers)),
			count: source.draw(element(counts)),
			components: source.draw(array(anyFloat, { min: 1, max: 6 }))
		}),
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: [
				...Arr.map(buffers, (b) => `buffer ${b}` as const),
				...Arr.map(counts, (c) => `count ${c}` as const)
			] satisfies ReadonlyArray<Reached<`buffer ${Buffer}` | `count ${Count}`>>,
			check:
				(_, c: Case<`buffer ${Buffer}` | `count ${Count}`>) =>
				({ buffer, count, components }) =>
					Effect.sync(() => {
						c.note(`buffer ${buffer}`)
						c.note(`count ${count}`)
						const length =
							count === "the maximum" || count === "past the maximum"
								? count === "the maximum"
									? vectorMaxDimensions
									: vectorMaxDimensions + 1
								: components.length
						const xs = length === components.length ? components : Array.from({ length }, () => 0.5)
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
					}),
			oracle: {
				kind: "specification",
				name: "the construction rule: a Float32Array of exactly its count, 1-vectorMaxDimensions, the count read first"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/vector.ts",
					original:
						'\ttypeof n === "number" && Number.isInteger(n) && n >= 1 && n <= vectorMaxDimensions',
					replacement:
						'\ttypeof n === "number" && Number.isInteger(n) && n >= 1 && n < vectorMaxDimensions',
					why: "The greatest dimension count is refused; the construction property fails."
				}
			]
		}
	)

/** Vector admission of a JavaScript caller's value admits a Float32Array of its dimensions and refuses every wild value as vectorType. Its budget is its suite's before it was a property (test/unit/values/vector.test.ts at 4ca3036a): 500 runs and 500 steered cases. */
export const vectorAdmissionOfAJavaScriptCallersValueAdmitsAFloat32ArrayOfItsDimensionsAndRefusesEveryWildValueAsVectorType =
	property.explore(
		lsw<Float32Array>({
			live: map(array(finiteFloat, { min: 3, max: 3 }), (xs) => Float32Array.from(xs)),
			stale: Option.none(),
			wild: WILD_KINDS
		}),
		{
			needs: {},
			budget: { runs: 500, steered: 500 },
			situations: [
				"live",
				...Arr.map(WILD_KINDS, (kind): DrawnFeature<never> => `wild ${kind}`)
			] satisfies ReadonlyArray<Reached<DrawnFeature<never>>>,
			check: (_, c: Case<DrawnFeature<never>>) => (d) =>
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
							vector.length === d.value.length && vector.every((x, i) => Object.is(x, d.value[i])),
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
				}),
			oracle: {
				kind: "specification",
				name: "the boundary: every wild value vectorType, a live buffer copied"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/vector.ts",
					original:
						"const copied = (buffer: Float32Array): Float32Array => new Float32Array(buffer)",
					replacement: "const copied = (buffer: Float32Array): Float32Array => buffer",
					why: "admit keeps the caller's buffer rather than a copy; the wild values property fails."
				}
			]
		}
	)

/** Vector in the canonical serializer revives only canonical payloads. Its budget is its suite's before it was a property (test/unit/values/vector.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const vectorInTheCanonicalSerializerRevivesOnlyCanonicalPayloads = property.explore(
	(source) => ({
		xs: source.draw(array(finiteFloat, { min: 1, max: 4 })),
		corruption: source.draw(element(payloadCorruptions))
	}),
	{
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: payloadCorruptions satisfies ReadonlyArray<Reached<PayloadCorruption>>,
		check:
			(_, c: Case<PayloadCorruption>) =>
			({ xs, corruption }) =>
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
				}),
		oracle: {
			kind: "specification",
			name: "the payload grammar's complement: each corruption spells no canonical vector"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/carriers.ts",
				original: "\t\tif (!Number.isFinite(x) || Math.fround(x) !== x || String(x) !== t) {",
				replacement: "\t\tif (!Number.isFinite(x) || Math.fround(x) !== x) {",
				why: "A payload component's spelling goes unchecked, so a component spelt other than its shortest text, the empty one among them, is admitted; the payloads property fails."
			}
		]
	}
)

/** Vector in the canonical serializer round-trips every float32 vector bit for bit, a host vector one text with its canonical form. Its budget is its suite's before it was a property (test/unit/values/vector.test.ts at 4ca3036a): 2000 runs and 200 steered cases. */
export const vectorInTheCanonicalSerializerRoundTripsEveryFloat32VectorBitForBitAHostVectorOneTextWithItsCanonicalForm =
	property.explore(array(componentGen, { min: 1, max: 8 }), {
		needs: {},
		budget: { runs: 2000, steered: 200 },
		situations: ["a -0 component", "one component", "several components"] satisfies ReadonlyArray<
			Reached<RoundTripFeature>
		>,
		check: (_, c: Case<RoundTripFeature>) => (xs) =>
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
				for (const component of Str.split(pipe(Vector.componentText(v), Str.slice(1, -1)), ",")) {
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
					Vector.canonical(Vector.make(Float32Array.from([...xs, Number.NaN]), xs.length + 1)),
					"vectorNonFinite"
				)
			}),
		oracle: { kind: "universal", name: "decode ∘ encode = id, -0 read as 0" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/vector.ts",
				original: 'const componentTextOf = (x: number): string => (x === 0 ? "0" : String(x))',
				replacement:
					'const componentTextOf = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))',
				why: "A -0 component is written as -0; the round trip fails."
			}
		]
	})
