import { isNonEmpty } from "#compiler/core/nonempty.ts"
import type { Exact, NativeProof, OperandIndex, OperandPremise } from "#compiler/ir/proof.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type Bounds,
	compareExact,
	exactOf,
	type FactSet,
	factPremise,
	hullBounds,
	insideRange,
	type IntervalPremise,
	intervalPremise,
	negExact,
	ofPoint,
	ofSpecial
} from "#compiler/scalar/compute/bounds.ts"
import type { IeeeOp, NativeOp } from "#compiler/scalar/compute/registry.ts"

/** A float carrier, the result of every IEEE 754 operation and rounding. */
export type FloatCarrier = "float4" | "float8"

/**
 * The binary exponents inside which each width's native operations meet no overflow and no underflow: a sum's operands
 * of magnitude at most 2^sum, a product's and a quotient's in [2^-product, 2^product], a rounding's value in
 * [2^-rounding, 2^rounding]. Each leaves a factor of two at least before an infinity or the subnormals, so the rounding
 * of the operations an operand's interval was computed through, which interval arithmetic leaves out, never crosses it.
 */
export const nativeRange = {
	float8: { sum: 1022, product: 500, rounding: 1022 },
	float4: { sum: 126, product: 60, rounding: 125 }
} as const satisfies {
	readonly [C in FloatCarrier]: {
		readonly sum: number
		readonly product: number
		readonly rounding: number
	}
}

/** 2^k as an exact value, k of either sign: 2^-k is 5^k · 10^-k. */
const power2 = (k: number): Exact =>
	k >= 0 ? exactOf(2n ** BigInt(k), 0) : exactOf(5n ** BigInt(-k), -k)

const zero: Exact = exactOf(0n, 0)

/**
 * The binary exponents of each width's rounding of an exact result: one of magnitude above 2^overflow may round to an
 * infinity, and a nonzero one below 2^-underflow, the least normal value, may round to zero.
 */
const ieeeRange = {
	float8: { overflow: 1023, underflow: 1022 },
	float4: { overflow: 127, underflow: 126 }
} as const satisfies {
	readonly [C in FloatCarrier]: { readonly overflow: number; readonly underflow: number }
}

/**
 * The bounds of an IEEE 754 operation's result from those of its exact result, which interval arithmetic computes
 * (lower.ts arithmeticBounds): where the exact result may reach below the least normal value in magnitude, IEEE 754
 * may round it to zero, which the bounds then hold; where it may pass 2^overflow, IEEE 754 may round it to the infinity
 * on that side, which the bounds then reach. Every proof over a float operation's value rests on these, never on the
 * exact result's, so no operand interval claims a value IEEE 754 rounded away.
 */
const ieeeBounds = (b: Bounds, carrier: FloatCarrier): Bounds => {
	const { overflow, underflow } = ieeeRange[carrier]
	const least = power2(-underflow)
	const greatest = power2(overflow)
	const clearOfZero =
		(b.low.kind === "at" && compareExact(b.low.value, least) >= 0) ||
		(b.high.kind === "at" && compareExact(b.high.value, negExact(least)) <= 0)
	const zeroed = clearOfZero ? b : hullBounds(b, ofPoint(zero))
	const above =
		zeroed.high.kind === "at" && compareExact(zeroed.high.value, greatest) > 0
			? hullBounds(zeroed, ofSpecial("infinity"))
			: zeroed
	return above.low.kind === "at" && compareExact(above.low.value, negExact(greatest)) < 0
		? hullBounds(above, ofSpecial("-infinity"))
		: above
}

/** A result's bounds as `op` computes it into `type`: an IEEE 754 operation's rounded (ieeeBounds), any other's exact. */
export const resultBounds = (
	op: NativeOp,
	type: ScalarType,
	bounds: Bounds | undefined
): Bounds | undefined => {
	const carrier = baseOf(type).carrier
	return op.totality.kind !== "ieee" ||
		bounds === undefined ||
		(carrier !== "float4" && carrier !== "float8")
		? bounds
		: ieeeBounds(bounds, carrier)
}

/** Whether every value of an interval premise but NaN has magnitude at most 2^k. */
const within = (p: IntervalPremise, k: number): boolean =>
	insideRange(p.low, p.high, negExact(power2(k)), power2(k))

/** Whether every value of an interval premise but NaN is zero. */
const onlyZero = (p: IntervalPremise): boolean =>
	compareExact(p.low, zero) === 0 && compareExact(p.high, zero) === 0

/** Whether every value of an interval premise but NaN has magnitude in [2^-k, 2^k], all of one sign. */
const moderate = (p: IntervalPremise, k: number): boolean =>
	insideRange(p.low, p.high, power2(-k), power2(k)) ||
	insideRange(p.low, p.high, negExact(power2(k)), negExact(power2(-k)))

/** Whether a cast's source is an integer carrier, whose nonzero values are never below 1 in magnitude. */
const integral = (from: ScalarType): boolean => {
	const c = baseOf(from).carrier
	return c === "int2" || c === "int4" || c === "int8" || c === "exactInteger"
}

/**
 * Whether premises establish that PostgreSQL's own overload of the IEEE 754 operation `op` into `carrier` raises on no
 * value of its operands, so it computes the operation's IEEE 754 value: the proof kernel's arithmetic, written once,
 * which the lowering's prover (nativeProof) and the tests' re-check (test/support/oracle/proof.ts) both read. `from` is
 * the first operand's type, a rounding's source. NaN is no obstacle: every native operation propagates it.
 * - a sum or difference: both operands' magnitudes at most 2^sum, so the result stays finite;
 * - a product: an operand exactly zero, whose product is zero or NaN, or both of magnitude in [2^-product, 2^product],
 *   so the result neither overflows nor underflows;
 * - a quotient: a divisor of magnitude in [2^-product, 2^product], never zero, and a dividend exactly zero or so too;
 * - a square root: a radicand never below zero, by its fact or its interval;
 * - a rounding: an integer of magnitude at most 2^rounding, or any other value exactly zero or of magnitude in
 *   [2^-rounding, 2^rounding], so it neither overflows nor underflows the target.
 */
export const nativeHolds = (
	op: IeeeOp,
	carrier: FloatCarrier,
	from: ScalarType,
	premises: ReadonlyArray<OperandPremise>
): boolean => {
	const interval = (operand: OperandIndex): IntervalPremise | undefined =>
		premises.find((p): p is IntervalPremise => p.kind === "interval" && p.operand === operand)
	const x = interval(0)
	const y = interval(1)
	const { sum, product, rounding } = nativeRange[carrier]
	switch (op) {
		case "add":
		case "sub":
			return x !== undefined && y !== undefined && within(x, sum) && within(y, sum)
		case "mul":
			return (
				(x !== undefined && onlyZero(x)) ||
				(y !== undefined && onlyZero(y)) ||
				(x !== undefined && y !== undefined && moderate(x, product) && moderate(y, product))
			)
		case "div":
			return (
				x !== undefined &&
				y !== undefined &&
				moderate(y, product) &&
				(onlyZero(x) || moderate(x, product))
			)
		case "sqrt":
			return premises.some(
				(p) =>
					p.operand === 0 &&
					((p.kind === "fact" && p.fact === "nonnegative") ||
						(p.kind === "interval" && compareExact(p.low, zero) >= 0))
			)
		case "round":
			return (
				x !== undefined &&
				(integral(from) ? within(x, rounding) : onlyZero(x) || moderate(x, rounding))
			)
	}
}

/** What the lowering proved of an operand: its bounds where it is a number, and its facts. */
interface ProvedOperand {
	readonly bounds: Bounds | undefined
	readonly facts: FactSet
}

/**
 * The proof that PostgreSQL's own overload computes the IEEE 754 operation `op` into `carrier` over operands proved as
 * `operands` (the first of type `from`), where their premises establish it (nativeHolds): each operand's interval, a
 * product's one operand exactly zero alone, a square root's radicand's fact of never below zero or its interval.
 * Undefined where nothing proves it, and the operation renders its guarded IEEE 754 form.
 */
export const nativeProof = (
	op: IeeeOp,
	carrier: FloatCarrier,
	from: ScalarType,
	operands: ReadonlyArray<ProvedOperand>
): NativeProof | undefined => {
	const interval = (operand: OperandIndex): IntervalPremise | undefined => {
		const b = operands[operand]?.bounds
		return b === undefined ? undefined : intervalPremise(operand, b)
	}
	const x = interval(0)
	const y = interval(1)
	const needed = (): ReadonlyArray<OperandPremise | undefined> => {
		switch (op) {
			case "sqrt": {
				const facts = operands[0]?.facts
				return [(facts === undefined ? undefined : factPremise(0, "nonnegative", facts)) ?? x]
			}
			case "round":
				return [x]
			case "mul":
				return x !== undefined && onlyZero(x) ? [x] : y !== undefined && onlyZero(y) ? [y] : [x, y]
			case "add":
			case "sub":
			case "div":
				return [x, y]
		}
	}
	const candidates = needed()
	const premises = candidates.filter((p): p is OperandPremise => p !== undefined)
	return candidates.length === premises.length &&
		isNonEmpty(premises) &&
		nativeHolds(op, carrier, from, premises)
		? { premises }
		: undefined
}
