/**
 * Float text forms: the exact decimal-to-binary32 reading of real and vector component texts, which never double-rounds
 * a float32 midpoint, both the library's trusting conversion (values/float.ts) and the kernel's strict reading
 * (test/support/kernel/strict.ts), and the shortest round-trip writing.
 *
 * - Every finite nonzero binary32 value's shortest text, and its ECMAScript text, read back as the value, as a real and
 *   as a vector component. Oracle: an independent exact reading (decimalToBinary32Reference), rational comparison
 *   against the value's rounding interval.
 * - A decimal at or beside a binary32 midpoint reads once, ties to even; random decimals agree with the rational reading,
 *   and overflow and nonzero underflow are refused. Oracle: the decimal as an exact rational.
 * - The grammar: exactly the texts it admits are read, and the specials for double and real, never for a vector
 *   component; the strtod spellings beside it are named, refused cases.
 * - Every double round-trips through its text, each zero its own sign, NaN as NaN. Oracle: the round trip.
 *
 * Features: a value's binade (normal, subnormal) and sign; above, below and either tie of a midpoint; every range of a
 * random decimal; the grammar's admissions, refusals, specials and strtod spellings; a finite double, zero and a
 * special.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { float } from "@bjornpagen/testing/values"
import { Effect } from "effect"
import {
	convertComponent,
	convertDouble,
	convertReal,
	floatText
} from "#compiler/scalar/values/float.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import { strictComponent, strictDouble, strictReal } from "#test/support/kernel/strict.ts"
import {
	type Binary32Feature,
	bitsOf,
	decimal,
	numericText,
	decimalToBinary32Reference,
	doubles,
	exactMidpoint,
	float32,
	floatMax,
	grammar,
	type MidpointFeature,
	minSubnormal,
	nextUp,
	type RangeFeature,
	rangeOf,
	shortestFloat32Text,
	specials,
	strtodSpellings,
	syntax,
	texts
} from "#test/unit/codec/float.fixtures.ts"

/**
 * Exact binary32 reading reads every binary32 value's shortest text back to that value.
 *
 * Budget: its suite's count before the conversion (unit/codec/float-1714631201: 5000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const exactBinary32ReadingReadsEveryBinary32ValuesShortestTextBackToThatValue =
	property.explore(float32, {
		needs: {},
		situations: ["a normal value", "a subnormal value", "a negative value"] satisfies ReadonlyArray<
			Reached<Binary32Feature>
		>,
		check: (_, c: Case<Binary32Feature>) => (f) =>
			Effect.sync(() => {
				c.note(Math.abs(f) < 2 ** -126 ? "a subnormal value" : "a normal value")
				if (f < 0) {
					c.note("a negative value")
				}
				const text = shortestFloat32Text(f)
				assert.equal(succeeded(strictReal(text)), f)
				assert.equal(succeeded(strictReal(String(f))), f)
				assert.equal(convertReal(text), f)
				assert.equal(convertReal(String(f)), f)
				assert.equal(convertComponent(`[${text}]`, 1, text.length + 1), f)
			}),
		oracle: {
			kind: "second-implementation",
			name: "an exact rational reading against the value's rounding interval"
		},
		budget: { runs: 5000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\tif (lead === 0x49) {",
				replacement: "\tif (lead !== 0x49) {",
				why: "Operator mutant (comparison) at packages/engine/src/scalar/values/float.ts:221 in convertReal: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Exact binary32 reading reads a decimal at or beside a binary32 midpoint once, ties to even.
 *
 * Budget: its suite's count before the conversion (unit/codec/float-midpoint: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const exactBinary32ReadingReadsADecimalAtOrBesideABinary32MidpointOnceTiesToEven =
	property.explore(
		(source) => ({
			f: source.draw(float(minSubnormal, Math.fround(floatMax / 2))),
			negative: source.draw(boolean),
			side: source.draw(element(["at" as const, "above" as const, "below" as const]))
		}),
		{
			needs: {},
			situations: [
				"above",
				"below",
				"tie to the lower",
				"tie to the upper"
			] satisfies ReadonlyArray<Reached<MidpointFeature>>,
			check:
				(_, c: Case<MidpointFeature>) =>
				({ f, negative, side }) =>
					Effect.sync(() => {
						const g = nextUp(f)
						const [numerator, denominator] = exactMidpoint(f, g)
						/**
						 * A nudge of 10^-20 of the midpoint's denominator's unit, far inside half the spacing, 1 / denominator.
						 */
						const scale = 10n ** 20n
						const nudge = side === "above" ? 1n : side === "below" ? -1n : 0n
						const text = `${negative ? "-" : ""}${numericText(numerator * scale + nudge, denominator * scale)}`
						const lowerEven = (bitsOf(f) & 1) === 0
						const nearer = side === "above" ? g : side === "below" ? f : lowerEven ? f : g
						const expected = negative ? -nearer : nearer
						c.note(side !== "at" ? side : lowerEven ? "tie to the lower" : "tie to the upper")
						assert.equal(succeeded(strictReal(text)), expected, text)
						assert.equal(convertReal(text), expected, text)
					}),
			oracle: {
				kind: "specification",
				name: "the midpoint as an exact rational, ties to even"
			},
			budget: { runs: 300, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/float.ts",
					original: "\t\tif (r2 > d || (r2 === d && (q & 1n) === 1n)) {",
					replacement: "\t\tif (r2 >= d) {",
					why: "A decimal midpoint between two binary32 values is rounded away from zero, not to even."
				},
				{
					file: "packages/engine/src/scalar/values/float.ts",
					original: "\t2n ** BigInt(emax + 1) - 2n ** BigInt(emax + 1 - p)",
					replacement: "\t2n ** BigInt(emax + 1 - p) - 2n ** BigInt(emax + 1)",
					why: "Operator mutant (operand-swap) at packages/limits/src/limits.ts:1393 in greatestFinite: `2n ** BigInt(emax + 1) - 2n ** BigInt(emax + 1 - p)` becomes `2n ** BigInt(emax + 1 - p) - 2n ** BigInt(emax + 1)`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/**
 * Exact binary32 reading agrees with an independent rational reading on random decimals, and refuses overflow and
 * nonzero underflow.
 *
 * Budget: its suite's count before the conversion (unit/codec/float-1918989417: 5000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const exactBinary32ReadingAgreesWithAnIndependentRationalReadingOnRandomDecimalsAndRefusesOverflowAndNonzeroUnderflow =
	property.explore(decimal, {
		needs: {},
		situations: ["normal", "subnormal", "overflow", "underflow", "zero"] satisfies ReadonlyArray<
			Reached<RangeFeature>
		>,
		check: (_, c: Case<RangeFeature>) => (text) =>
			Effect.sync(() => {
				const range = rangeOf(text)
				c.note(range)
				switch (range) {
					case "overflow":
					case "underflow":
						faulted(strictReal(text), "floatRange", text)
						return
					case "zero":
						assert.ok(Object.is(succeeded(strictReal(text)), Number(text)), text)
						assert.ok(Object.is(convertReal(text), Number(text)), text)
						assert.ok(
							Object.is(succeeded(strictComponent(text)), 0),
							`${text} as a vector component`
						)
						assert.ok(
							Object.is(convertComponent(`[${text}]`, 1, text.length + 1), 0),
							`${text} as a vector component`
						)
						return
					case "normal":
					case "subnormal":
						assert.equal(succeeded(strictReal(text)), decimalToBinary32Reference(text), text)
						assert.equal(convertReal(text), decimalToBinary32Reference(text), text)
						return
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the decimal as an exact rational, rounded to nearest by hand"
		},
		budget: { runs: 5000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\t\tconst value = Number(q) * 2 ** e",
				replacement: "\t\tconst value = Number(q) * 3 ** e",
				why: "Operator mutant (bound) at packages/engine/src/scalar/values/float.ts:158 in decimalToBinary32: `2` becomes `3`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\treturn negative ? -magnitude : magnitude\n}",
				replacement: "\treturn negative && magnitude !== 0 ? -magnitude : magnitude\n}",
				why: "A real's text of a negative zero is read as +0, its sign dropped."
			},
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\tconst x = finiteBinary32(text, from, to)\n\treturn x === 0 ? 0 : x",
				replacement: "\treturn finiteBinary32(text, from, to)",
				why: "A vector component's -0 is read as -0, a value of its own, as a real's is, where it is a spelling of 0: a vector stored as [1,-0,-0] is delivered with its zeros' signs (the public property's floor case 2, a nested attachment's vector)."
			}
		]
	})

/**
 * The float text grammar, scanned without RegExp admits exactly the texts the grammar admits, and the specials for
 * double and real, never for a vector component.
 *
 * Budget: its suite's count before the conversion (unit/codec/float-7497063: 20000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theFloatTextGrammarScannedWithoutRegExpAdmitsExactlyTheTextsTheGrammarAdmitsAndTheSpecialsForDoubleAndRealNeverForAVectorComponent =
	property.explore(texts, {
		needs: {},
		situations: [
			"grammar admits",
			"grammar refuses",
			"special",
			"strtod spelling"
		] satisfies ReadonlyArray<
			Reached<"grammar admits" | "grammar refuses" | "special" | "strtod spelling">
		>,
		check:
			(_, c: Case<"grammar admits" | "grammar refuses" | "special" | "strtod spelling">) =>
			(text) =>
				Effect.sync(() => {
					const special = specials.get(text)
					if (special !== undefined) {
						c.note("special")
						assert.ok(Object.is(succeeded(strictDouble(text)), special), text)
						assert.ok(Object.is(succeeded(strictReal(text)), special), text)
						assert.ok(Object.is(convertReal(text), special), text)
						faulted(strictComponent(text), "floatSyntax", text)
						return
					}
					const expected = grammar.test(text)
					c.note(
						strtodSpellings.includes(text)
							? "strtod spelling"
							: expected
								? "grammar admits"
								: "grammar refuses"
					)
					assert.equal(syntax(strictDouble(text)), expected)
					assert.equal(syntax(strictReal(text)), expected)
					assert.equal(syntax(strictComponent(text)), expected)
					if (expected && Number.isFinite(Number(text))) {
						assert.equal(Object.is(succeeded(strictDouble(text)), Number(text)), true)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the text grammar, and the specials each reader admits"
		},
		budget: { runs: 20000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\t\treturn negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY",
				replacement: "\t\treturn Number.POSITIVE_INFINITY",
				why: "A real's text -Infinity is read as Infinity."
			}
		]
	})

/**
 * Double precision text round-trips every binary64 value through its shortest text, each zero its own sign: -0 is
 * written "-0" (floatText), which float8in reads as -0, as the library's conversion does.
 *
 * Budget: its suite's count before the conversion (unit/codec/float-6578796: 10000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const doublePrecisionTextRoundTripsEveryBinary64ValueThroughItsShortestTextEachZeroWithItsSign =
	property.explore(doubles, {
		needs: {},
		situations: ["a finite double", "zero", "a special"] satisfies ReadonlyArray<
			Reached<"a finite double" | "zero" | "a special">
		>,
		check: (_, c: Case<"a finite double" | "zero" | "a special">) => (x) =>
			Effect.sync(() => {
				c.note(!Number.isFinite(x) ? "a special" : x === 0 ? "zero" : "a finite double")
				const readsBack = (back: number) => {
					if (Number.isNaN(x)) {
						assert.equal(Number.isNaN(back), true)
					} else {
						assert.equal(Object.is(back, x), true)
					}
				}
				const text = floatText(x)
				const strict = succeeded(strictDouble(text))
				readsBack(strict)
				readsBack(convertDouble(text))
			}),
		oracle: {
			kind: "universal",
			name: "a double's shortest text reads back as the double, each zero with its sign"
		},
		budget: { runs: 10000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original:
					'export const floatText = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))',
				replacement:
					'export const floatText = (x: number): string => (Object.is(x, -0) ? "-0" : String(Number(x.toPrecision(16))))',
				why: "A double is written to sixteen significant digits, not its shortest round-trip text."
			},
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original:
					'export const floatText = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))',
				replacement: "export const floatText = (x: number): string => String(x)",
				why: "The encoder writes String(x), which spells -0 as 0, so a stored -0 reads back as +0 (edullm-56)."
			}
		]
	})
