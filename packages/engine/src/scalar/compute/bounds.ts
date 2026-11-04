import type { Exact, Fact, FactSource, OperandPremise } from "#compiler/ir/proof.ts"
import { doubleParts } from "#compiler/scalar/compute/cast.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import { numericMaxDisplayScale, numericMaxIntegerDigits } from "#compiler/scalar/values/decimal.ts"

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** units · 10^-scale as an exact value; a negative scale multiplies out. */
export const exactOf = (units: bigint, scale: number): Exact =>
	scale >= 0 ? { units, scale } : { units: units * pow10(-scale), scale: 0 }

const zeroExact: Exact = { units: 0n, scale: 0 }

/** Two exact values at one scale, their units comparable. */
const aligned = (a: Exact, b: Exact): readonly [bigint, bigint, number] => {
	const scale = Math.max(a.scale, b.scale)
	return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale]
}

export const compareExact = (a: Exact, b: Exact): -1 | 0 | 1 => {
	const [x, y] = aligned(a, b)
	return x < y ? -1 : x > y ? 1 : 0
}

const addExact = (a: Exact, b: Exact): Exact => {
	const [x, y, scale] = aligned(a, b)
	return { units: x + y, scale }
}

export const negExact = (a: Exact): Exact => ({ units: -a.units, scale: a.scale })

const mulExact = (a: Exact, b: Exact): Exact => ({
	units: a.units * b.units,
	scale: a.scale + b.scale
})

const absExact = (a: Exact): Exact => (a.units < 0n ? negExact(a) : a)

const minExact = (a: Exact, b: Exact): Exact => (compareExact(a, b) <= 0 ? a : b)

const maxExact = (a: Exact, b: Exact): Exact => (compareExact(a, b) >= 0 ? a : b)

/** x - y, exactly. */
export const minus = (x: Exact, y: Exact): Exact => addExact(x, negExact(y))

/** 10^digits. */
export const tenTo = (digits: number): Exact => ({ units: pow10(digits), scale: 0 })

/** The integer digits of a finite exact value: the least d with |x| < 10^d. */
export const digitsOfExact = (a: Exact): number => {
	const whole = absExact(a).units / pow10(a.scale)
	return whole === 0n ? 0 : whole.toString().length
}

/** The fractional digits a finite exact value is written with at least. */
const scaleOfExact = (a: Exact): number => {
	let units = absExact(a).units
	let scale = a.scale
	while (scale > 0 && units % 10n === 0n) {
		units /= 10n
		scale--
	}
	return scale
}

/** A finite Decimal's exact value; undefined for NaN and the infinities. */
export const exactOfDecimal = (d: Decimal): Exact | undefined => {
	const p = d.parts
	return p.kind === "finite"
		? { units: p.negative ? -p.coefficient : p.coefficient, scale: p.minScale }
		: undefined
}

/** A finite double's exact value: its binary fraction num / 2^k written as num · 5^k / 10^k. */
export const exactOfDouble = (x: number): Exact => {
	const { negative, num, den } = doubleParts(x)
	const k = den.toString(2).length - 1
	const units = num * 5n ** BigInt(k)
	return { units: negative ? -units : units, scale: k }
}

/**
 * An end of an interval: a finite exact value, reached or not, or the infinity on its side, which is then a possible
 * value. NaN lies above Infinity in PostgreSQL's order of numeric and the floats, and is its own flag (Bounds.nan).
 */
export type Edge =
	| { readonly kind: "at"; readonly value: Exact; readonly open: boolean }
	| { readonly kind: "infinite" }

const at = (value: Exact, open: boolean): Edge => ({ kind: "at", value, open })
const infinite: Edge = { kind: "infinite" }

/**
 * The bound domain: what the lowering knows of a numeric value that no TypeScript type can state, because it is a
 * number. An interval holding every value in the order -Infinity < finite < Infinity, whether NaN is possible, and
 * bounds on the integer digits (|x| < 10^digits) and fractional digits of its finite values. It proves what rests on
 * magnitudes: that a numeric expression stays inside numeric's 131072 digits, that a narrowing cast's value fits, that
 * a domain cast's value satisfies a contract's atoms, power's range and width_bucket's bounds. A guard narrows it
 * inside Compute.when's branch. An interval whose low end lies above its high end, and that is not NaN, holds no
 * value: the branch of a guard that cannot hold.
 */
export interface Bounds {
	readonly low: Edge
	readonly high: Edge
	readonly nan: boolean
	readonly digits: number
	readonly scale: number
}

const bounds = (low: Edge, high: Edge, nan: boolean, digits: number, scale: number): Bounds =>
	Object.freeze({
		low,
		high,
		nan,
		digits: Math.min(digits, numericMaxIntegerDigits + 1),
		scale: Math.min(scale, numericMaxDisplayScale)
	})

/** Every finite value of `digits` integer digits and `scale` fractional ones, with the infinities and NaN as given. */
export const ofDigits = (
	digits: number,
	scale: number,
	special: { readonly infinite: boolean; readonly nan: boolean }
): Bounds =>
	bounds(
		special.infinite ? infinite : at(negExact(tenTo(digits)), true),
		special.infinite ? infinite : at(tenTo(digits), true),
		special.nan,
		digits,
		scale
	)

/** The closed interval [low, high] of an integer carrier, below 10^digits. */
export const ofRange = (low: bigint, high: bigint, digits: number): Bounds =>
	bounds(at(exactOf(low, 0), false), at(exactOf(high, 0), false), false, digits, 0)

/** One finite value, a literal's. */
export const ofPoint = (value: Exact): Bounds =>
	bounds(at(value, false), at(value, false), false, digitsOfExact(value), scaleOfExact(value))

/** A special value alone: NaN, or an infinity, which an interval of no finite value holds. */
export const ofSpecial = (special: "nan" | "infinity" | "-infinity"): Bounds => {
	switch (special) {
		case "nan":
			return bounds(at(tenTo(0), false), at(zeroExact, false), true, 0, 0)
		case "infinity":
			return bounds(at(tenTo(0), false), infinite, false, 0, 0)
		case "-infinity":
			return bounds(infinite, at(negExact(tenTo(0)), false), false, 0, 0)
	}
}

const addEdges = (a: Edge, b: Edge): Edge =>
	a.kind === "infinite" || b.kind === "infinite"
		? infinite
		: at(addExact(a.value, b.value), a.open || b.open)

const negEdge = (e: Edge): Edge => (e.kind === "infinite" ? e : at(negExact(e.value), e.open))

const mayBeInfinite = (b: Bounds): boolean =>
	b.low.kind === "infinite" || b.high.kind === "infinite"

/** Whether an interval holds zero. */
const holdsZero = (b: Bounds): boolean =>
	(b.low.kind === "infinite" || compareExact(b.low.value, zeroExact) < (b.low.open ? 0 : 1)) &&
	(b.high.kind === "infinite" || compareExact(b.high.value, zeroExact) > (b.high.open ? 0 : -1))

export const addBounds = (a: Bounds, b: Bounds): Bounds =>
	bounds(
		addEdges(a.low, b.low),
		addEdges(a.high, b.high),
		a.nan ||
			b.nan ||
			(a.high.kind === "infinite" && b.low.kind === "infinite") ||
			(a.low.kind === "infinite" && b.high.kind === "infinite"),
		Math.max(a.digits, b.digits) + 1,
		Math.max(a.scale, b.scale)
	)

export const negBounds = (a: Bounds): Bounds =>
	bounds(negEdge(a.high), negEdge(a.low), a.nan, a.digits, a.scale)

export const subBounds = (a: Bounds, b: Bounds): Bounds => addBounds(a, negBounds(b))

/** The product's interval: its corners, closed, when both operands are finite, and every value but NaN otherwise. */
export const mulBounds = (a: Bounds, b: Bounds): Bounds => {
	const nan =
		a.nan || b.nan || (mayBeInfinite(a) && holdsZero(b)) || (mayBeInfinite(b) && holdsZero(a))
	const digits = a.digits + b.digits
	const scale = a.scale + b.scale
	if (
		a.low.kind === "infinite" ||
		a.high.kind === "infinite" ||
		b.low.kind === "infinite" ||
		b.high.kind === "infinite"
	) {
		return bounds(infinite, infinite, nan, digits, scale)
	}
	const corners = [
		mulExact(a.low.value, b.low.value),
		mulExact(a.low.value, b.high.value),
		mulExact(a.high.value, b.low.value),
		mulExact(a.high.value, b.high.value)
	] as const
	const [first, ...rest] = corners
	return bounds(
		at(rest.reduce(minExact, first), false),
		at(rest.reduce(maxExact, first), false),
		nan,
		digits,
		scale
	)
}

export const absBounds = (a: Bounds): Bounds => {
	if (a.low.kind === "at" && compareExact(a.low.value, zeroExact) >= 0) {
		return a
	}
	if (a.high.kind === "at" && compareExact(a.high.value, zeroExact) <= 0) {
		return negBounds(a)
	}
	const high =
		a.low.kind === "infinite" || a.high.kind === "infinite"
			? infinite
			: at(maxExact(absExact(a.low.value), absExact(a.high.value)), false)
	return bounds(at(zeroExact, false), high, a.nan, a.digits, a.scale)
}

const lowest = (a: Edge & { readonly kind: "at" }, b: Edge & { readonly kind: "at" }): Edge => {
	const c = compareExact(a.value, b.value)
	return c < 0 ? a : c > 0 ? b : at(a.value, a.open && b.open)
}

const highest = (a: Edge & { readonly kind: "at" }, b: Edge & { readonly kind: "at" }): Edge => {
	const c = compareExact(a.value, b.value)
	return c > 0 ? a : c < 0 ? b : at(a.value, a.open && b.open)
}

/** The values of either branch of a conditional, or of any operand of LEAST and GREATEST: their hull. */
export const hullBounds = (a: Bounds, b: Bounds): Bounds =>
	bounds(
		a.low.kind === "infinite" || b.low.kind === "infinite" ? infinite : lowest(a.low, b.low),
		a.high.kind === "infinite" || b.high.kind === "infinite" ? infinite : highest(a.high, b.high),
		a.nan || b.nan,
		Math.max(a.digits, b.digits),
		Math.max(a.scale, b.scale)
	)

/** The tighter of two low edges, the higher. */
const tighterLow = (a: Edge, b: Edge): Edge =>
	a.kind === "infinite" ? b : b.kind === "infinite" ? a : highest(a, b)

/** The tighter of two high edges, the lower. */
const tighterHigh = (a: Edge, b: Edge): Edge =>
	a.kind === "infinite" ? b : b.kind === "infinite" ? a : lowest(a, b)

/**
 * What a Compute.when guard leaves its subject inside the guarded branch (Guard), or a contract predicate's comparison
 * of VALUE with a literal leaves every value of the contract: never zero leaves the interval as it is (a fact, not an
 * interval, says it), never below zero cuts it at zero, above zero cuts it open at zero, finite drops the infinities and
 * NaN, and within [low, high] cuts it to that closed interval. A one-sided comparison cuts one side as PostgreSQL orders
 * numeric and float values, NaN above every other: at least a value keeps the infinite high edge and NaN, at most a
 * value keeps the infinite low edge and drops NaN.
 */
export type Refinement =
	| { readonly kind: "nonzero" }
	| { readonly kind: "nonnegative" }
	| { readonly kind: "positive" }
	| { readonly kind: "finite" }
	| { readonly kind: "within"; readonly low: Exact; readonly high: Exact }
	| { readonly kind: "atLeast"; readonly value: Exact; readonly open: boolean }
	| { readonly kind: "atMost"; readonly value: Exact; readonly open: boolean }

/** `b` inside the branch of a guard that refines it by `r`. */
export const refine = (b: Bounds, r: Refinement): Bounds => {
	switch (r.kind) {
		case "nonzero":
			return b
		case "nonnegative":
			return bounds(tighterLow(b.low, at(zeroExact, false)), b.high, b.nan, b.digits, b.scale)
		case "positive":
			return bounds(tighterLow(b.low, at(zeroExact, true)), b.high, b.nan, b.digits, b.scale)
		case "finite":
			return bounds(
				b.low.kind === "infinite" ? at(negExact(tenTo(b.digits)), true) : b.low,
				b.high.kind === "infinite" ? at(tenTo(b.digits), true) : b.high,
				false,
				b.digits,
				b.scale
			)
		case "within":
			return bounds(
				tighterLow(b.low, at(r.low, false)),
				tighterHigh(b.high, at(r.high, false)),
				false,
				Math.min(b.digits, Math.max(digitsOfExact(r.low), digitsOfExact(r.high))),
				b.scale
			)
		case "atLeast":
			return bounds(tighterLow(b.low, at(r.value, r.open)), b.high, b.nan, b.digits, b.scale)
		case "atMost":
			return bounds(b.low, tighterHigh(b.high, at(r.value, r.open)), false, b.digits, b.scale)
	}
}

/**
 * Whether every value of `b` has the fact `f`, read off the interval: finite with no infinite edge and no NaN; never
 * below zero with its low edge at or above zero (NaN, above every value, among them); never zero with zero outside it.
 */
export const boundsHave = (b: Bounds, f: Fact): boolean => {
	switch (f) {
		case "finite":
			return b.low.kind === "at" && b.high.kind === "at" && !b.nan
		case "nonnegative":
			return b.low.kind === "at" && compareExact(b.low.value, zeroExact) >= 0
		case "nonzero":
			return (
				(b.low.kind === "at" &&
					(compareExact(b.low.value, zeroExact) > 0 ||
						(b.low.open && compareExact(b.low.value, zeroExact) === 0))) ||
				(b.high.kind === "at" &&
					(compareExact(b.high.value, zeroExact) < 0 ||
						(b.high.open && compareExact(b.high.value, zeroExact) === 0)))
			)
	}
}

/** The closed finite interval [low, high] every value of `b` lies in, when it has one: no infinity and no NaN. */
export const finiteEnds = (b: Bounds): readonly [Exact, Exact] | undefined =>
	b.low.kind === "at" && b.high.kind === "at" && !b.nan ? [b.low.value, b.high.value] : undefined

/** The single value of a point interval, a literal's. */
export const pointOf = (b: Bounds): Exact | undefined => {
	const ends = finiteEnds(b)
	return ends !== undefined &&
		b.low.kind === "at" &&
		b.high.kind === "at" &&
		!b.low.open &&
		!b.high.open &&
		compareExact(ends[0], ends[1]) === 0
		? ends[0]
		: undefined
}

/** The interval premise of operand `operand`: its closed finite ends, where it has them. */
export const intervalPremise = (
	operand: OperandPremise["operand"],
	b: Bounds
): Extract<OperandPremise, { readonly kind: "interval" }> | undefined => {
	const ends = finiteEnds(b)
	return ends === undefined ? undefined : { kind: "interval", operand, low: ends[0], high: ends[1] }
}

/** Whether [low, high] lies within [min, max]. */
export const insideRange = (low: Exact, high: Exact, min: Exact, max: Exact): boolean =>
	compareExact(low, min) >= 0 && compareExact(high, max) <= 0

/**
 * The facts a value is known to have, each with where it comes from (ir/proof.ts FactSource): exactly the facts its
 * TypeScript type states (types/core/phantom.ts Facts), a literal's from its value, a contract's from its declaration,
 * a guarded subject's from its guard, and an integer's finiteness from its type. No operation's result has one.
 */
export type FactSet = { readonly [F in Fact]?: FactSource }

export const noFacts: FactSet = Object.freeze({})

/** The fact premise of `fact` on operand `operand`, where its facts hold it. */
export const factPremise = (
	operand: OperandPremise["operand"],
	fact: Fact,
	facts: FactSet
): Extract<OperandPremise, { readonly kind: "fact" }> | undefined => {
	const source = facts[fact]
	return source === undefined ? undefined : { kind: "fact", operand, fact, source }
}
