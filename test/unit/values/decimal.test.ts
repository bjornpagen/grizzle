/**
 * The Decimal carrier (scalar/values/decimal.ts): numeric_in's exact spellings read to their one form, PostgreSQL's
 * numeric format limits, numeric_out text read back, the order and identity of values, the canonical payload, a
 * numeric(p, s) typmod's checks and rounding, and the literal boundary.
 *
 * - Spelling: every exact spelling numeric_in reads is the value its digits and exponent spell, written as numeric_out of
 *   trim_scale writes it, in parts that are the value's one form. Oracle: a model of numeric_in, the spelling's digits
 *   scaled by its exponent in bigint arithmetic and written with its trailing fractional zeros trimmed.
 * - Corruption: one corruption no exact spelling survives is refused as decimalSyntax. Oracle: the grammar's
 *   complement, each corruption a named case.
 * - Format limits: a value at numeric's fraction digits, integer digits (written out, by an exponent, as parts or as a
 *   bigint) or exponent magnitude is admitted as its one text, one past any is refused as decimalRange, and trailing
 *   fractional zeros past the fraction limit drop away before the limit is judged. Oracle: the limits as published
 *   (ir/scalar.ts, numeric.c's PG_INT32_MAX / 2), each case's one text written from them.
 * - Round trip: a value's text reads back to the value, its parts the one form, its parts padded by any trailing zeros
 *   the same value, and a negative coefficient refused as decimalType. Oracle: universal, fromString ∘ toString = id.
 * - numeric_out: a value's text padded to any display scale reads back to the value. Oracle: universal, fromOutput ∘ pad
 *   = id.
 * - Order: compare is cmp_numerics, -Infinity below every finite value below Infinity below NaN, NaN equal to NaN,
 *   finite values by value; equality, the one text and the parts agree with it. Oracle: a second implementation, the
 *   specials ranked and finite values compared by cross-multiplied signed coefficients.
 * - Payload: every value's text is a payload of the IR's grammar (ir/decimal.ts) encoding as the value does, and a text
 *   is a payload exactly when fromCanonical revives it. Oracle: a differential between the IR's grammar and the reviver.
 * - Typmod: checkNumericTypmod admits exactly integer precisions 1-numericMaxPrecision and scales
 *   numericMinScale-numericMaxScale. Oracle: numerictypmodin's rule as a checker.
 * - Typmod rounding: normalizeNumeric keeps NaN, refuses an infinity, refuses a value whose rounding has more than p
 *   digits at scale s, and otherwise stores the value at scale s within half a unit, a tie away from zero, idempotently.
 *   Oracle: apply_typmod's rule stated in exact rational arithmetic apart from roundedUnits.
 * - Literal boundary: Decimal.parse reads a decimal string or a bigint, refuses a number as decimalNumber and any other
 *   value as decimalType, and admit raises only CompileError. Oracle: the boundary's specification as a checker.
 *
 * Features: each spelling feature, each corruption, each limit at and past it by each entry, padded and canonical
 * outputs, equal and unequal pairs of each kind, admitted and refused typmods at their bounds, each rounding outcome,
 * and every wild kind.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type DrawnFeature, drawnFeature, lsw, passed, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { DecimalText, isDecimalPayload } from "#compiler/ir/decimal.ts"
import { checkNumericTypmod, Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import { decimalGen, numericText } from "#test/support/unit/values/support.ts"
import {
	canonicalParts,
	corrupted,
	type CorruptionFeature,
	corruptionSpace,
	corruptions,
	formatCaseGen,
	type FormatFeature,
	formatLimits,
	formatTextOf,
	formatValueOf,
	isInt,
	leadsWithZero,
	modelCompare,
	normalizedGen,
	normalizedVerdict,
	type NormalizeFeature,
	orderedPairGen,
	type OrderFeature,
	orderFeatures,
	padded,
	type PayloadFeature,
	payloadTextSpace,
	pow10,
	sameParts,
	signedOf,
	type SpellingFeature,
	spellingFeatures,
	spellingGen,
	textCorruptions,
	trailingZeros,
	typmodEntry,
	type TypmodFeature,
	typmodFeatures
} from "#test/unit/values/decimal.fixtures.ts"

/** Decimal parsing reads every exact spelling to numeric_in's value, in its one form. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const decimalParsingReadsEveryExactSpellingToNumericInsValueInItsOneForm = property.explore(
	spellingGen,
	{
		needs: {},
		budget: { runs: 2000, steered: 2000 },
		situations: spellingFeatures satisfies ReadonlyArray<Reached<SpellingFeature>>,
		check: (_, c: Case<SpellingFeature>) => (spelling) =>
			Effect.sync(() => {
				c.noteAll(spelling.features)
				const d = succeeded(Decimal.fromString(spelling.text))
				assert.equal(d.toString(), spelling.canonical, spelling.text)
				assert.ok(canonicalParts(d), `${spelling.text}: its parts are the one form`)
			}),
		oracle: {
			kind: "specification",
			name: "numeric_in modelled: the digits scaled by the exponent in bigint arithmetic, trailing fractional zeros trimmed"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\t\tconst exponent = written.value.value - fractionLength + (all.length - end)",
				replacement:
					"\t\tconst exponent = written.value.value - fractionLength + Math.min(all.length - end, fractionLength)",
				why: "A spelling's integer trailing zeros are dropped from its exponent; the spelling property fails."
			}
		]
	}
)

/** Decimal parsing refuses every spelling one corruption breaks. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const decimalParsingRefusesEverySpellingOneCorruptionBreaks = property.explore(
	corruptionSpace,
	{
		needs: {},
		budget: { runs: 1000, steered: 1000 },
		situations: [
			...corruptions,
			...Arr.map(textCorruptions, (corruption) => [corruption, "an exact spelling"] as const)
		] satisfies ReadonlyArray<Reached<CorruptionFeature>>,
		check:
			(_, c: Case<CorruptionFeature>) =>
			({ spelling, corruption, at }) =>
				Effect.sync(() => {
					c.note(corruption)
					if (!Arr.contains(spelling.features, "a special")) {
						c.pair(corruption, "an exact spelling")
					}
					const text = corrupted(spelling.text, corruption, at)
					faulted(Decimal.fromString(text), "decimalSyntax", Formatter.format(text))
				}),
		oracle: {
			kind: "specification",
			name: "the exact grammar's complement: each corruption spells no exact decimal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: '\tif (end === digitsStart) {\n\t\treturn Result.err("decimalSyntax")',
				replacement: "\tif (end === digitsStart) {\n\t\treturn Result.ok({ value: 0, end })",
				why: "An exponent mark with no digits is read as e0; the corruption property fails."
			}
		]
	}
)

/** Decimal parsing admits a value at each of PostgreSQL's numeric format limits as its one text, refuses one past, and drops zeros past the fraction limit. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 100 runs and 200 steered cases. */
export const decimalParsingAdmitsAValueAtEachOfPostgreSQLsNumericFormatLimitsAsItsOneTextRefusesOnePastAndDropsZerosPastTheFractionLimit =
	property.explore(formatCaseGen, {
		needs: {},
		budget: { runs: 100, steered: 200 },
		situations: [
			...Arr.flatMap(formatLimits, (limit) => [`${limit} at` as const, `${limit} past` as const]),
			"by text",
			"by parts",
			"by bigint",
			"an exponent far past"
		] satisfies ReadonlyArray<Reached<FormatFeature>>,
		check: (_, c: Case<FormatFeature>) => (formatCase) =>
			Effect.sync(() => {
				c.note(`${formatCase.limit} ${formatCase.side}`)
				c.note(`by ${formatCase.entry}`)
				if (formatCase.limit === "an exponent's magnitude" && formatCase.margin > 4) {
					c.note("an exponent far past")
				}
				const value = formatValueOf(formatCase)
				if (formatCase.side === "past" && formatCase.limit !== "zeros past the fraction digits") {
					faulted(value, "decimalRange")
				} else {
					assert.equal(succeeded(value).text, formatTextOf(formatCase))
				}
			}),
		oracle: {
			kind: "specification",
			name: "numeric's published format limits and set_var_from_str's exponent limit, each case's one text written from them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					"\t\tif (minScale > numericMaxFractionDigits || digits.length - minScale > numericMaxIntegerDigits) {",
				replacement:
					"\t\tif (minScale >= numericMaxFractionDigits || digits.length - minScale > numericMaxIntegerDigits) {",
				why: "A value at the fraction limit is refused; the format limits property fails."
			}
		]
	})

/** Decimal parsing round-trips its own text exactly, its parts padded by zeros are the value, and refuses a negative coefficient. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 2000 runs and 200 steered cases. */
export const decimalParsingRoundTripsItsOwnTextExactlyItsPartsPaddedByZerosAreTheValueAndRefusesANegativeCoefficient =
	property.explore((source) => [source.draw(decimalGen), source.draw(trailingZeros)] as const, {
		needs: {},
		budget: { runs: 2000, steered: 200 },
		situations: ["unpadded parts", "padded parts", "special"] satisfies ReadonlyArray<
			Reached<"unpadded parts" | "padded parts" | "special">
		>,
		check:
			(_, c: Case<"unpadded parts" | "padded parts" | "special">) =>
			([x, k]) =>
				Effect.sync(() => {
					const back = succeeded(Decimal.fromString(x.toString()))
					assert.equal(back.toString(), x.toString())
					assert.ok(sameParts(back, x))
					assert.equal(back.equals(x), true)
					assert.ok(canonicalParts(x))
					if (!x.isFinite()) {
						c.note("special")
						return
					}
					c.note(k > 0 ? "padded parts" : "unpadded parts")
					const { negative, coefficient, minScale } = x.parts
					const scaled = succeeded(
						Decimal.fromParts(negative, coefficient * pow10(k), minScale + k)
					)
					assert.ok(sameParts(scaled, x), `fromParts at scale ${minScale + k}`)
					assert.equal(scaled.text, x.text)
					if (coefficient > 0n) {
						faulted(Decimal.fromParts(negative, -coefficient, minScale), "decimalType")
					}
				}),
		oracle: {
			kind: "universal",
			name: "fromString ∘ toString = id, and fromParts ∘ pad = id"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					'\t\tif (typeof negative !== "boolean" || typeof coefficient !== "bigint" || coefficient < 0n) {',
				replacement: '\t\tif (typeof negative !== "boolean" || typeof coefficient !== "bigint") {',
				why: "fromParts takes a negative coefficient; the round trip fails."
			}
		]
	})

/** Decimal parsing converts numeric_out text at every display scale to the value's one form, its text and parts the value's. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const decimalParsingConvertsNumericOutTextAtEveryDisplayScaleToTheValuesOneFormItsTextAndPartsTheValues =
	property.explore(
		(source) => [source.draw(decimalGen), source.draw(element([0, 1, 8, 24, 40]))] as const,
		{
			needs: {},
			budget: { runs: 2000, steered: 2000 },
			situations: ["padded", "canonical", "special"] satisfies ReadonlyArray<
				Reached<"padded" | "canonical" | "special">
			>,
			check:
				(_, c: Case<"padded" | "canonical" | "special">) =>
				([x, k]) =>
					Effect.sync(() => {
						const text = x.isFinite() ? padded(x.text, k) : x.text
						c.note(!x.isFinite() ? "special" : k === 0 ? "canonical" : "padded")
						const converted = Decimal.fromOutput(text)
						assert.equal(converted.text, x.text, text)
						assert.ok(sameParts(converted, x), `${text}: the parts of ${x.text}`)
						assert.ok(converted.equals(x))
					}),
			oracle: { kind: "universal", name: "fromOutput ∘ pad = id at every display scale" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/decimal.ts",
					original: "\t\tconst end = zerosDropped(text, point + 1, text.length)",
					replacement: "\t\tconst end = text.length",
					why: "fromOutput keeps a padded text's zeros; the numeric_out property fails."
				}
			]
		}
	)

/** Decimal identity and order orders as cmp_numerics, and equality, text and parts agree with the order. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 2000 runs and 400 steered cases. */
export const decimalIdentityAndOrderOrdersAsCmpNumericsAndEqualityTextAndPartsAgreeWithTheOrder =
	property.explore(orderedPairGen, {
		needs: {},
		budget: { runs: 2000, steered: 400 },
		situations: [
			"equal values",
			"a special against a finite value",
			"two specials",
			"opposite signs",
			"one sign, two scales"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check:
			(_, c: Case<OrderFeature>) =>
			([a, b]) =>
				Effect.sync(() => {
					c.noteAll(orderFeatures(a, b))
					const model = modelCompare(a, b)
					assert.equal(a.compare(b), model, `${a.text} against ${b.text}`)
					assert.equal(a.equals(b), model === 0)
					assert.equal(a.toString() === b.toString(), model === 0)
					assert.equal(sameParts(a, b), model === 0)
				}),
		oracle: {
			kind: "second-implementation",
			name: "cmp_numerics modelled: kinds ranked -Infinity, finite, Infinity, NaN; finite values by cross-multiplied signed coefficients"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					'\t\tfor (let top = frames[frames.length - 1]; top !== undefined; top = frames[frames.length - 1]) {\n\t\t\tif (top.kind === "array") {\n\t\t\t\tthis.#item(top)',
				replacement:
					'\t\tfor (let top = frames[frames.length - 1]; top !== undefined; top = frames[frames.length - 1]) {\n\t\t\tif (top.kind !== "array") {\n\t\t\t\tthis.#item(top)',
				why: "Operator mutant 87f78705d1 at packages/engine/src/core/canonical.ts:755 in <module>: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** Decimal in the canonical serializer writes every value as a payload of the IR's decimal grammar (ir/decimal.ts). Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 1000 runs and 200 steered cases. */
export const decimalInTheCanonicalSerializerWritesEveryValueAsAPayloadOfTheIRsDecimalGrammarIrDecimalTs =
	property.explore(decimalGen, {
		needs: {},
		budget: { runs: 1000, steered: 200 },
		situations: ["finite", "negative", "special"] satisfies ReadonlyArray<
			Reached<"finite" | "negative" | "special">
		>,
		check: (_, c: Case<"finite" | "negative" | "special">) => (x) =>
			Effect.sync(() => {
				c.note(!x.isFinite() ? "special" : signedOf(x) < 0n ? "negative" : "finite")
				const text = x.toString()
				assert.equal(isDecimalPayload(text), true)
				assert.equal(
					succeeded(encode(defined(DecimalText.parse(text)), everyProperty)),
					succeeded(encode(x, everyProperty))
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the IR's payload grammar (DecimalText.parse) beside the Decimal that wrote the text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/decimal.ts",
				original: '\t\tconst negative = text[i] === "-"',
				replacement: "\t\tconst negative = false",
				why: "The IR's grammar refuses a negative payload; the payload property fails."
			}
		]
	})

/** Decimal in the canonical serializer takes a text as a payload exactly when the reviver revives it. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 5000 runs and 200 steered cases. */
export const decimalInTheCanonicalSerializerTakesATextAsAPayloadExactlyWhenTheReviverRevivesIt =
	property.explore(payloadTextSpace, {
		needs: {},
		budget: { runs: 5000, steered: 200 },
		situations: ["a payload", "no payload", "a leading zero"] satisfies ReadonlyArray<
			Reached<PayloadFeature>
		>,
		check: (_, c: Case<PayloadFeature>) => (text) =>
			Effect.sync(() => {
				const payload = isDecimalPayload(text)
				c.note(payload ? "a payload" : "no payload")
				if (leadsWithZero(text)) {
					c.note("a leading zero")
				}
				assert.equal(payload, Decimal.fromCanonical(text).ok, text)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the IR's payload grammar (isDecimalPayload) beside the reviver (Decimal.fromCanonical)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/decimal.ts",
				original: '\t\tif (intDigits === 0 || (intDigits > 1 && text[intStart] === "0")) {',
				replacement: "\t\tif (intDigits === 0) {",
				why: "The IR's grammar takes a leading zero; the payload property fails."
			}
		]
	})

/** Numeric(p, s) normalization validates precision and scale as numerictypmodin does: both integers within its limits, both given. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 1000 runs and 400 steered cases. */
export const numericPSNormalizationValidatesPrecisionAndScaleAsNumerictypmodinDoesBothIntegersWithinItsLimitsBothGiven =
	property.explore((source) => [source.draw(typmodEntry), source.draw(typmodEntry)] as const, {
		needs: {},
		budget: { runs: 1000, steered: 400 },
		situations: [
			"admitted",
			"refused",
			"admitted at a bound",
			"refused one past a bound"
		] satisfies ReadonlyArray<Reached<TypmodFeature>>,
		check:
			(_, c: Case<TypmodFeature>) =>
			([precision, scale]) =>
				Effect.sync(() => {
					const admitted =
						isInt(precision, 1, numericMaxPrecision) &&
						isInt(scale, numericMinScale, numericMaxScale)
					c.noteAll(typmodFeatures(precision, scale, admitted))
					if (admitted) {
						assert.deepEqual(succeeded(checkNumericTypmod(precision, scale)), {
							precision,
							scale: scale + 0
						})
					} else {
						faulted(checkNumericTypmod(precision, scale), "numericTypmod")
					}
				}),
		oracle: {
			kind: "specification",
			name: "numerictypmodin's rule: an integer precision 1-numericMaxPrecision and scale numericMinScale-numericMaxScale"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					"\tif (!isInteger(precision) || precision < 1 || precision > numericMaxPrecision) {",
				replacement:
					"\tif (!isInteger(precision) || precision < 1 || precision >= numericMaxPrecision) {",
				why: "The greatest precision is refused; the typmod property fails."
			}
		]
	})

/** Numeric(p, s) normalization keeps NaN, refuses an infinity or a value rounding past p digits, and stores the rest at scale s within half a unit, a tie away from zero, idempotently. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 3000 runs and 600 steered cases. */
export const numericPSNormalizationKeepsNaNButAtScale0RefusesAnInfinityOrAValueRoundingPastPDigitsAndStoresTheRestAtScaleSWithinHalfAUnitATieAwayFromZeroIdempotently =
	property.explore(normalizedGen, {
		needs: {},
		budget: { runs: 3000, steered: 600 },
		situations: [
			"kept",
			"rounded",
			"a tie rounded away",
			"a negative scale",
			"numericOverflow",
			"numericInfinity",
			"NaN kept",
			"numericNaN"
		] satisfies ReadonlyArray<Reached<NormalizeFeature>>,
		check:
			(_, c: Case<NormalizeFeature>) =>
			([x, type]) =>
				Effect.sync(() => {
					c.note(normalizedVerdict(x, type))
				}),
		oracle: {
			kind: "specification",
			name: "apply_typmod's rule in exact rational arithmetic, apart from roundedUnits"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\treturn (c % divisor) * 2n >= divisor ? q + 1n : q",
				replacement: "\treturn (c % divisor) * 2n > divisor ? q + 1n : q",
				why: "A tie is rounded toward zero; the typmod rounding property fails."
			}
		]
	})

/** Decimal admission of a JavaScript caller's value parses a decimal string, refuses a value of no decimal host kind as decimalType, and admit raises only CompileError. Its budget is its suite's before it was a property (test/unit/values/decimal.test.ts at 4ca3036a): 500 runs and 500 steered cases. */
export const decimalAdmissionOfAJavaScriptCallersValueParsesADecimalStringRefusesAValueOfNoDecimalHostKindAsDecimalTypeAndAdmitRaisesOnlyCompileError =
	property.explore(lsw<string>({ live: numericText, stale: Option.none(), wild: WILD_KINDS }), {
		needs: {},
		budget: { runs: 500, steered: 500 },
		situations: [
			"live",
			...Arr.map(WILD_KINDS, (kind): DrawnFeature<never> => `wild ${kind}`)
		] satisfies ReadonlyArray<Reached<DrawnFeature<never>>>,
		check: (_, c: Case<DrawnFeature<never>>) => (d) =>
			Effect.sync(() => {
				c.note(drawnFeature(d))
				const value = passed(d)
				const parsed = Decimal.parse(value)
				if (d.kind === "live") {
					succeeded(parsed)
				}
				const host = typeof value
				if (host !== "string" && host !== "bigint" && host !== "number") {
					faulted(parsed, "decimalType")
				}
				if (typeof value === "number") {
					faulted(parsed, "decimalNumber")
				}
				if (typeof value === "bigint") {
					assert.equal(succeeded(parsed).toString(), value.toString())
				}
				if (parsed.ok) {
					assert.equal(Decimal.admit(value).equals(parsed.value), true)
				} else {
					assert.throws(() => Decimal.admit(value), isCompileError)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the literal boundary: a string or bigint read, a number decimalNumber, every other value decimalType"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					'\t\t\treturn Result.err(typeof input === "number" ? "decimalNumber" : "decimalType")',
				replacement:
					'\t\t\treturn typeof input === "number" ? Decimal.fromString(String(input)) : Result.err("decimalType")',
				why: "Decimal.parse reads a number through its text rather than refusing it; the literal boundary property fails."
			}
		]
	})
