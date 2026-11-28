/** What the properties of numeric-bound.test.ts read: drawn bounds and values about them, and the bound's model. */

import { aimed, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { NumericBound } from "#compiler/ir/scalar.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { numericMaxFractionDigits, numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { succeeded } from "#test/support/assert.ts"

/** A drawn case: a bound, and a value at or about its edges, or a special. */
export interface BoundCase {
	readonly bound: NumericBound
	readonly value: Numeric
}

/** A bound as a sum's or a mean's proves one: some integer digits, below one among them, and a scale. */
const bound: Gen<NumericBound> = (s) => ({ digits: s.draw(int(-4, 14)), scale: s.draw(int(0, 9)) })

/**
 * A finite value about a bound: a coefficient of about as many digits as the bound's integer and fraction digits, one
 * more or fewer, at a scale about the bound's, signed either way.
 */
const finiteAbout =
	(b: NumericBound): Gen<Numeric> =>
	(s) => {
		const scale = Math.max(0, b.scale + s.draw(int(-2, 2)))
		const digits = Math.max(1, b.digits + scale + s.draw(int(-2, 1)))
		const nines = s.draw(element([true, false]))
		const coefficient = nines
			? 10n ** BigInt(digits) - 1n
			: 10n ** BigInt(digits - 1) + BigInt(s.draw(int(0, 9)))
		return succeeded(Numeric.fromParts(s.draw(element([false, true])), coefficient, scale))
	}

const cases: Gen<BoundCase> = (s) => {
	const b = s.draw(bound)
	return {
		bound: b,
		value: s.draw(
			weighted<Numeric>([
				[8, finiteAbout(b)],
				[1, element([Numeric.nan, Numeric.infinity, Numeric.negativeInfinity, Numeric.zero])]
			])
		)
	}
}

/** A case at numeric's own limits, whose bound admits every value: its widest finite values, as numeric holds them. */
const ownLimits: Gen<BoundCase> = (s) => ({
	bound: { digits: numericMaxIntegerDigits, scale: numericMaxFractionDigits },
	value: s.draw(
		element([
			succeeded(Numeric.fromParts(false, 10n ** BigInt(numericMaxIntegerDigits) - 1n, 0)),
			succeeded(Numeric.fromParts(true, 1n, numericMaxFractionDigits))
		])
	)
})

export type BoundFeature =
	| "a finite value within admitted"
	| "a value of too many fraction digits refused"
	| "a value too great refused"
	| "a value just below 10^digits admitted"
	| "a special admitted"
	| "zero admitted"
	| "a bound below one"
	| "numeric's own limits admitted"

/** The space, aimed: numeric's own limits, which no drawn bound reaches. */
export const boundSpace = aimed(cases, [["numeric's own limits admitted", ownLimits]])

/**
 * The model: whether `value` is within `b`, read in exact rational arithmetic apart from the digit count withinBound
 * reads: NaN or an infinity; or c / 10^m, its coefficient c and scale m, with m at most the bound's scale and
 * c < 10^(digits + m), so |value| < 10^digits.
 */
export const modelWithin = (value: Numeric, b: NumericBound): boolean => {
	const p = value.parts
	if (p.kind !== "finite") {
		return true
	}
	const exponent = b.digits + p.minScale
	const below = exponent >= 0 ? p.coefficient < 10n ** BigInt(exponent) : p.coefficient === 0n
	return p.minScale <= b.scale && below
}

/** What a case reached, as the model judges it. */
export const boundFeatures = (c: BoundCase): ReadonlyArray<BoundFeature> => {
	const p = c.value.parts
	const out: Array<BoundFeature> = []
	if (c.bound.digits < 0) {
		out.push("a bound below one")
	}
	if (c.bound.digits >= numericMaxIntegerDigits && c.bound.scale >= numericMaxFractionDigits) {
		out.push("numeric's own limits admitted")
	}
	if (p.kind !== "finite") {
		out.push("a special admitted")
		return out
	}
	if (p.coefficient === 0n) {
		out.push("zero admitted")
		return out
	}
	if (p.minScale > c.bound.scale) {
		out.push("a value of too many fraction digits refused")
	} else if (!modelWithin(c.value, c.bound)) {
		out.push("a value too great refused")
	} else {
		out.push("a finite value within admitted")
		if (
			c.bound.digits + p.minScale >= 0 &&
			p.coefficient === 10n ** BigInt(c.bound.digits + p.minScale) - 1n
		) {
			out.push("a value just below 10^digits admitted")
		}
	}
	return out
}

/**
 * A cast's case: the operand field's numeric(p, s), which bounds its values below 10^(p - s) at s fraction digits, and
 * the bound the cast's target states (numeric.within), each about the other.
 */
export interface CastCase {
	readonly precision: number
	readonly scale: number
	readonly target: NumericBound
}

export const castSpace: Gen<CastCase> = (s) => {
	const scale = s.draw(int(0, 4))
	const precision = scale + s.draw(int(1, 8))
	return {
		precision,
		scale,
		target: {
			digits: precision - scale + s.draw(int(-1, 1)),
			scale: Math.max(0, scale + s.draw(int(-1, 1)))
		}
	}
}

export type CastFeature = "a cast proved within admitted" | "a cast past the bound refused"
