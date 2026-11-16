/**
 * The cosine domain of a vector field (scalar/values/vector.ts, ir/expr.ts): the float32 buffers of the field's
 * dimensions, every component finite, whose norm lies in [cosineNormMin, cosineNormMax].
 *
 * - Values: Vector.from admits exactly those buffers, refusing each other by its reason (other dimensions, a component
 *   not finite, a norm outside); every encode of a branded buffer checks it again; an admitted vector is a copy of the
 *   caller's buffer, component for component, of its norm, written as pgvector's text with -0 as 0, so zeroing the
 *   buffer after its check reaches none of it.
 * - Literals: a query built over a vector literal outside the domain is refused when it is built; one inside is held as
 *   it was then, whatever the caller writes to its buffer after.
 *
 * Components are drawn by kind with explicit, equal weights: the bounds and their float32 neighbours, values that
 * underflow or overflow float32, the non-finite ones, -0, and any float; buffers drawn one component at a time, all
 * equal, small, or one component at a bound. Oracle: the specification, the domain's verdict on the float32 buffer.
 * Features: each verdict, a bound, an underflowing component, -0, and a buffer zeroed after its check.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { EncodingFailure, isCompileError } from "#compiler/core/errors.ts"
import { Vector } from "#compiler/public/fields.ts"
import { assert, faulted, succeeded } from "#test/support/assert.ts"
import { paramText } from "#test/support/wire.ts"
import {
	bufferGen,
	codec,
	componentsGen,
	dims,
	type DomainFeature,
	highest,
	literalQuery,
	lowest,
	sqlOf,
	verdictOf
} from "#test/unit/vector/vector.fixtures.ts"

/** The cosine domain admits exactly the buffers of the field's dimensions, finite, of a norm in [cosineNormMin, cosineNormMax], at Vector.from and at every encode. */
export const theCosineDomainAdmitsExactlyTheBuffersOfTheFieldsDimensionsFiniteOfANormInCosineNormMinCosineNormMaxAtVectorFromAndAtEveryEncode =
	property.explore(bufferGen, {
		needs: {},
		situations: [
			"admitted at a bound",
			"admitted inside",
			"a norm below the domain",
			"a norm above the domain",
			"a non-finite component",
			"other dimensions",
			"an underflowing component",
			"-0 written as 0",
			"a buffer zeroed after its check"
		] satisfies ReadonlyArray<Reached<DomainFeature>>,
		check:
			(_, c: Case<DomainFeature>) =>
			({ length, components, zeroedAfter }) =>
				Effect.sync(() => {
					const buffer = Float32Array.from(components.slice(0, length))
					const { verdict, norm } = verdictOf(buffer)
					if (Arr.some(components.slice(0, length), (x) => x !== 0 && Math.fround(x) === 0)) {
						c.note("an underflowing component")
					}
					const from = Vector.from<number>(buffer, dims)
					if (verdict !== "admitted") {
						c.note(
							verdict === "vectorDimensions"
								? "other dimensions"
								: verdict === "vectorNonFinite"
									? "a non-finite component"
									: norm < lowest
										? "a norm below the domain"
										: "a norm above the domain"
						)
						assert.ok(!from.ok && from.error instanceof EncodingFailure)
						assert.equal(from.error.reason._tag, verdict)
						if (verdict !== "vectorDimensions") {
							faulted(codec.encode(Vector.make(buffer, dims)), verdict)
						}
						return
					}
					c.note(norm === lowest || norm === highest ? "admitted at a bound" : "admitted inside")
					const refined = succeeded(from)
					assert.ok(
						refined !== buffer &&
							refined.length === buffer.length &&
							refined.every((x, i) => Object.is(x, buffer[i])),
						"the refined vector is a copy of the caller's buffer, component for component"
					)
					assert.equal(Vector.norm(refined), norm)
					if (buffer.some((x) => Object.is(x, -0))) {
						c.note("-0 written as 0")
					}
					assert.equal(
						succeeded(codec.encode(refined)),
						paramText(
							`[${Arr.join(
								Arr.map([...buffer], (x) => String(Object.is(x, -0) ? 0 : x)),
								","
							)}]`
						)
					)
					if (!zeroedAfter) {
						return
					}
					c.note("a buffer zeroed after its check")
					const text = succeeded(codec.encode(refined))
					buffer.fill(0)
					assert.equal(
						succeeded(codec.encode(refined)),
						text,
						"the refined vector is a copy, so zeroing the caller's buffer after its check reaches none of it"
					)
					faulted(
						codec.encode(Vector.make(buffer, dims)),
						"vectorNorm",
						"the buffer itself, branded by Vector.make, is checked again at its encode"
					)
				}),
		oracle: {
			kind: "specification",
			name: "the cosine domain's verdict on the float32 buffer: its dimensions, finite components, norm in the domain"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/vector.ts",
				original: "\treturn n >= cosineNormMin.value && n <= cosineNormMax.value",
				replacement: "\treturn n >= cosineNormMin.value && n < cosineNormMax.value",
				why: "The host's cosine domain is open at its greatest norm; the values property fails."
			}
		]
	})

/** The cosine domain refuses a vector literal outside the domain when the query is built, and holds one inside as it was then. */
export const theCosineDomainRefusesAVectorLiteralOutsideTheDomainWhenTheQueryIsBuiltAndHoldsOneInsideAsItWasThen =
	property.explore(componentsGen(dims), {
		needs: {},
		situations: ["held as built", "refused when built"] satisfies ReadonlyArray<
			Reached<"held as built" | "refused when built">
		>,
		check: (_, c: Case<"held as built" | "refused when built">) => (xs) =>
			Effect.sync(() => {
				const buffer = Float32Array.from(xs)
				if (verdictOf(buffer).verdict !== "admitted") {
					c.note("refused when built")
					assert.throws(
						() => literalQuery(Vector.make(buffer, dims)),
						(e) => isCompileError(e) && e.reason._tag === "MalformedDescription"
					)
					return
				}
				c.note("held as built")
				const built = literalQuery(Vector.make(buffer, dims))
				buffer.fill(1)
				assert.deepEqual(
					sqlOf(built),
					sqlOf(literalQuery(Vector.make(Float32Array.from(xs), dims)))
				)
			}),
		oracle: {
			kind: "specification",
			name: "the cosine domain's verdict on the literal's float32 buffer"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: "\t\t\treturn norm >= cosineNormMin.value && norm <= cosineNormMax.value",
				replacement: "\t\t\treturn norm >= cosineNormMin.value && norm < cosineNormMax.value",
				why: "A vector literal's cosine domain is open at its greatest norm; the literals property fails."
			}
		]
	})
