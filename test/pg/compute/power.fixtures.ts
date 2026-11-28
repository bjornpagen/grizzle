/** What the properties of power.test.ts read: its spaces, models and helpers. */
import { type Gen, int, map, oneOf, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { type Array as Arr } from "effect"
import { type PreconditionKind } from "#compiler/core/errors.ts"
import { type ExprDesc } from "#compiler/ir/desc.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { binary64MinExponent } from "#compiler/scalar/compute/cast.ts"
import { binary64MaxExponent, binary64Precision } from "#compiler/scalar/lexical.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	numericMaxFractionDigits,
	numericMaxPrecision,
	numericMaxScale
} from "#compiler/scalar/values/fault.ts"
import { evaluatorTemplate } from "#test/support/pg/compute/support.ts"
import { digitString, type PowerBatch } from "#test/support/power-pairs.ts"
import { spelledExpr, type TestField, testPg, v } from "#test/support/unit/compute/support.ts"

/**
 * The field a literal base is typed by, as computeCore.literal types one: a literal never stands first, so the base is a
 * literal of a numeric field, whose typmod holds its value exactly, (its digits, its least scale), or NaN, which every
 * typmod of a scale admits, at numeric(1, 1), numeric(p, 0) being an integer type that holds no NaN (4da9792ba). None
 * for an infinity, which no typmod admits, or a value whose digits or scale pass
 * numeric's declarable ones: no declared field holds it, so no literal base is it. The exponent stays a bare literal,
 * typed by the base it meets.
 */
export const baseField = (base: Decimal): TestField | undefined => {
	if (base.isNaN()) {
		return testPg.numericOf(1, 1)
	}
	if (!base.isFinite()) {
		return undefined
	}
	const scale = base.parts.minScale
	const digits = base.parts.coefficient === 0n ? 1 : String(base.parts.coefficient).length
	const precision = Math.max(digits, scale, 1)
	return precision > numericMaxPrecision || scale > numericMaxScale
		? undefined
		: testPg.numericOf(precision, scale)
}

/** Whether a refusal's precondition is power's: its base's sign (powerDomain) or its result's range (powerRange). */
export const powerPrecondition = (kind: PreconditionKind): boolean =>
	kind === "powerDomain" || kind === "powerRange"

/**
 * What a case reached: a value both sides agree on; a power compilation refuses, its literal operands outside the
 * domain and range it proves (PartialOperation, precondition powerDomain: zero to a negative power, a negative base;
 * powerRange: a result past numeric's digits); a result that underflows to zero at its display scale, on both sides;
 * and a pair next to power_var's exp(6000) bound on each side of the proof's.
 */
export type PowerFeature =
	| "value agreement"
	| "refused at compilation"
	| "underflow to zero"
	| "next to exp(6000), admitted"
	| "next to exp(6000), refused"

/** What a guarded power over a base column reached: refused at compilation, or proved and computed at its ends. */
export type GuardedFeature = "guarded power refused" | "guarded power proved"

/**
 * A guard over a base column of a computed numeric at numeric's own limits (testPg.computedNumeric): above zero and
 * within [0, high], whose least value is numeric's least positive one, 10^-16383; or within [low, high] with low a power
 * of ten at most one. And the exponent a power raises the guarded base to: a negative integer or fraction, or a positive
 * one.
 */
interface GuardedPower {
	readonly guard:
		| Readonly<{ kind: "positive"; high: string }>
		| Readonly<{ kind: "within"; low: string; high: string }>
	readonly exponent: string
}

/** The least positive value of a numeric of no typmod: 10^-numericMaxFractionDigits, 10^-16383. */
export const leastPositive = `1e-${numericMaxFractionDigits}`

export const guardedPowerGen: Gen<GuardedPower> = (source) => ({
	guard: source.draw(
		weighted<GuardedPower["guard"]>([
			[1, (g) => ({ kind: "positive", high: `${g.draw(int(1, 9))}e${g.draw(int(0, 40))}` })],
			[
				3,
				(g) => ({
					kind: "within",
					low: `1e-${g.draw(int(0, 400))}`,
					high: `${g.draw(int(1, 9))}e${g.draw(int(0, 40))}`
				})
			]
		])
	),
	exponent: source.draw(
		oneOf([
			map(int(-40, -1), String),
			(g) => `-${g.draw(int(0, 60))}.${g.draw(digitString(1, 6))}`,
			map(int(1, 40), String),
			(g) => `${g.draw(int(0, 60))}.${g.draw(digitString(1, 6))}`
		])
	)
})

/**
 * What a float power reached: an admitted power PostgreSQL computes, one over a subnormal base, and a refusal where
 * dpow raises 22003 on each side, its result rounding to zero from a nonzero base or to an infinity.
 */
export type FloatFeature =
	| "admitted"
	| "admitted over a subnormal base"
	| "refused where dpow underflows"
	| "refused where dpow overflows"

/** A float power's operands: a base of any binary exponent, subnormals among them, and an exponent of either sign. */
export interface FloatPower {
	readonly base: number
	readonly exponent: number
}

/** binary64's trailing significand field's width, p - 1 bits. */
const trailingBits = BigInt(binary64Precision - 1)

/** The binary64 exponent bias, emax: a biased exponent of 1 is emin. */
const bias = binary64MaxExponent

/** The positive double of biased exponent `biased`, 0 for a subnormal or zero, and trailing significand `fraction`. */
const doubleOfFields = (biased: number, fraction: bigint): number => {
	const view = new DataView(new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT))
	view.setBigUint64(0, (BigInt(biased) << trailingBits) | fraction)
	return view.getFloat64(0)
}

const fractionGen: Gen<bigint> = bigint(0n, (1n << trailingBits) - 1n)

/** A base of every finite binary exponent alike, from the subnormals to the largest. */
export const floatBaseGen: Gen<number> = (source) =>
	doubleOfFields(source.draw(int(0, 2 * bias)), source.draw(fractionGen))

/**
 * An exponent: a small integer, or a value of either sign between 2^-20 and 2^31, so |e · log2 b| reaches either side
 * of binary64's greatest exponent from every base.
 */
export const floatExponentGen: Gen<number> = weighted<number>([
	[1, int(-40, 40)],
	[
		3,
		(source) =>
			(source.draw(int(0, 1)) === 0 ? 1 : -1) *
			doubleOfFields(source.draw(int(bias - 20, bias + 31)), source.draw(fractionGen))
	]
])

/** The least normal double, 2^emin: below it a nonzero double is subnormal. */
export const leastNormal = 2 ** binary64MinExponent

export const expr: ExprDesc = spelledExpr(
	computeCore.power(v("a", testPg.computedNumeric), v("b", testPg.computedNumeric)).expr
)

/** The float power, power(a, b) over doubles, which every case of the float property lowers. */
export const floatPowerExpr: ExprDesc = spelledExpr(
	computeCore.power(v("a", testPg.double), v("b", testPg.double)).expr
)

/** The evaluator's schema each case's transaction evaluates over (compute/support.ts evaluatorTemplate). */
export const powerEvaluator = evaluatorTemplate(import.meta, "power evaluator")

/**
 * The powers e7fd8b323 fixed, kept by value since the space draws neither their bases nor their exponents (toolchain-test
 * keep found none): a fractional exponent past power_var's exp(6000), power(9.5e400, 60.123456789) and
 * power(5.5e10, 1000.123), which the proofs once admitted and PostgreSQL fails.
 */
export const pastExpPowers: Arr.NonEmptyReadonlyArray<PowerBatch> = [
	{
		ordinary: [
			["9.5e400", "60.123456789"],
			["5.5e10", "1000.123"]
		],
		near: []
	}
]

/**
 * A guarded power e7fd8b323 fixed, kept by value (toolchain-test keep found none): a base above zero and within
 * [0, 10] raised to -10, whose least value 10^-16383 overflows.
 */
export const overflowingGuardedPowers: Arr.NonEmptyReadonlyArray<ReadonlyArray<GuardedPower>> = [
	[{ guard: { kind: "positive", high: "10" }, exponent: "-10" }]
]

/**
 * The float powers 73360caa6 fixed, kept by value (toolchain-test keep found none): power(1.6466997816706438e-110, 9.5)
 * and power(1.6466997816706438e-110, 527076835), which underflow to zero and dpow fails.
 */
export const underflowingFloatPowers: Arr.NonEmptyReadonlyArray<ReadonlyArray<FloatPower>> = [
	[
		{ base: 1.6466997816706438e-110, exponent: 9.5 },
		{ base: 1.6466997816706438e-110, exponent: 527076835 }
	]
]
