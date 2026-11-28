/**
 * Text-mode scalar codecs: each carrier's written text, admission at the encoder, and the null ban; the strict reading of
 * PostgreSQL's output text (the kernel's, test/support/kernel/strict.ts), and the library's trusting conversion agreeing
 * with it on every text it admits.
 *
 * Each carrier's output form is restated here as an oracle from PostgreSQL's output functions (int2out/int4out/int8out,
 * numeric_out at a typmod's display scale, money::numeric at scale 2, boolout, range_out's half-open form), each text's
 * cell text the canonical text of the value it spells, which the encoder writes, and each refusal
 * the codec vocabulary names for a value it meets (docs/errors-and-concurrency.md "Errors and outcomes") is planted per carrier, beside the null ban every
 * encoder holds.
 *
 * A Live value and the text PostgreSQL's output function writes for it.
 *
 * Oracles: the kernel's strict reading of PostgreSQL's output text (test/support/kernel/strict.ts) for each carrier's
 * forms; range_out's grammar as a reference RegExp; a vector's round trip.
 *
 * Features: every form each carrier reaches (FormFeature); a span's syntax refusal beside a span; a vector in the cosine
 * domain, one lifted into it, and a subnormal component.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import { codecOf, kindCodes } from "#test/support/unit/codec/support.ts"
import { paramText } from "#test/support/wire.ts"
import {
	absences,
	type Carried,
	carried,
	carrierCases,
	formAims,
	type FormFeature,
	formFeatures,
	int8Text,
	r8,
	spanGrammar,
	spanTexts,
	vector3,
	vectorComponents
} from "#test/unit/codec/scalar.fixtures.ts"
import { asVector } from "#test/unit/codec/values.ts"

/**
 * Each carrier's codec writes PostgreSQL's output form, reads it back, and refuses each planted value and text with
 * its word.
 *
 * Budget: its suite's count before the conversion (unit/codec/scalar-forms: 1500 independent cases and 144 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const eachCarriersCodecWritesPostgreSQLsOutputFormReadsItBackAndRefusesEachPlantedValueAndTextWithItsWord =
	property.explore(aimed(carrierCases, formAims), {
		needs: {},
		situations: formFeatures,
		check:
			(_, c: Case<FormFeature>) =>
			([name, sketch]) =>
				Effect.sync(() => {
					const carrier: Carried = carried[name]
					const codec = codecOf(carrier.type, kindCodes)
					switch (sketch.kind) {
						case "written": {
							c.note(`${name} written`)
							const { value, text } = sketch.written
							assert.equal(succeeded(codec.encode(value)), paramText(codec.cellText(text)), name)
							assert.equal(codec.cellText(text), codec.text(codec.convert(text)), name)
							assert.deepEqual(succeeded(codec.read(text)), value, name)
							assert.deepEqual(codec.convert(text), value, name)
							return
						}
						case "null refused":
							c.note(`${name} null refused`)
							faulted(codec.encode(absences[sketch.absent]), "nullValue", name)
							return
						case "value refused": {
							c.note(`${name} value refused`)
							const [value, word] = sketch.planted
							faulted(codec.encode(value), word, name)
							return
						}
						case "text refused": {
							c.note(`${name} text refused`)
							const [text, word] = sketch.planted
							faulted(codec.read(text), word, `${name}: ${text}`)
							return
						}
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the kernel's strict reading of PostgreSQL's output text (test/support/kernel/strict.ts)"
		},
		budget: { runs: 1500, steered: 144 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/span.ts",
				original: "\tif (!(s.value < e.value)) {",
				replacement: "\tif (!(s.value <= e.value)) {",
				why: "A span whose start is its end is admitted, not refused as spanOrder."
			}
		]
	})

/**
 * Integer and span text, scanned without RegExp reads int8range text exactly where the span output grammar admits it.
 *
 * Budget: its suite's count before the conversion (unit/codec/scalar-7565409: 20000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const integerAndSpanTextScannedWithoutRegExpReadsInt8rangeTextExactlyWhereTheSpanOutputGrammarAdmitsIt =
	property.explore(spanTexts, {
		needs: {},
		situations: ["spanSyntax", "a span"] satisfies ReadonlyArray<Reached<"spanSyntax" | "a span">>,
		check: (_, c: Case<"spanSyntax" | "a span">) => (text) =>
			Effect.sync(() => {
				const match = spanGrammar.exec(text)
				const start = match === null ? undefined : int8Text(match[1])
				const end = match === null ? undefined : int8Text(match[2])
				const result = r8.read(text)
				if (start === undefined || end === undefined || start >= end) {
					c.note("spanSyntax")
					faulted(result, "spanSyntax")
				} else {
					c.note("a span")
					assert.deepEqual(succeeded(result), { start, end })
					assert.deepEqual(r8.convert(text), { start, end })
				}
			}),
		oracle: {
			kind: "specification",
			name: "range_out's grammar as a reference RegExp, its ends int8s in order"
		},
		budget: { runs: 20000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/span.ts",
				original: "\tif (!(s.value < e.value)) {",
				replacement: "\tif ((s.value < e.value)) {",
				why: "Operator mutant (negation) at packages/engine/src/scalar/values/span.ts:121 in makeSpan: `!(s.value < e.value)` becomes `(s.value < e.value)`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Vectors round-trips random float32 vectors of the cosine domain.
 *
 * Budget: its suite's count before the conversion (unit/codec/scalar-3: 2000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const vectorsRoundTripsRandomFloat32VectorsOfTheCosineDomain = property.explore(
	vectorComponents,
	{
		needs: {},
		situations: [
			"a vector in the domain",
			"a vector lifted into the domain",
			"a subnormal component"
		] satisfies ReadonlyArray<
			Reached<
				"a vector in the domain" | "a vector lifted into the domain" | "a subnormal component"
			>
		>,
		check:
			(
				_,
				c: Case<
					"a vector in the domain" | "a vector lifted into the domain" | "a subnormal component"
				>
			) =>
			(xs) =>
				Effect.sync(() => {
					const made = Vector.make(Float32Array.from(xs), 3)
					c.note(
						Vector.inCosineDomain(made)
							? "a vector in the domain"
							: "a vector lifted into the domain"
					)
					if (Arr.some(xs, (x) => x !== 0 && Math.abs(x) < 2 ** -126)) {
						c.note("a subnormal component")
					}
					const v = Vector.inCosineDomain(made)
						? made
						: Vector.make(Float32Array.from([1, ...xs.slice(1)]), 3)
					const text = succeeded(vector3.encode(v))
					assert.equal(Vector.equals(vector3.read(text).pipe(succeeded, asVector), v), true)
					assert.equal(Vector.equals(asVector(vector3.convert(text)), v), true)
				}),
		oracle: { kind: "universal", name: "a vector's text reads back as the vector" },
		budget: { runs: 2000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/scalar.ts",
				original: "\t\tvalue === null || value === undefined",
				replacement: "\t\tvalue === null || value !== undefined",
				why: "Operator mutant (comparison) in specText, the encode's exact text: `===` becomes `!==`, so every value but undefined is refused as nullValue; the property fails (lane CATCH, grizzle 0baff5d6; retargeted by lane DECODEREXPORT)."
			}
		]
	}
)
