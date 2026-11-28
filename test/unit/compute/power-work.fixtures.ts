import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { numericMaxPrecision, numericMaxScale } from "#compiler/scalar/values/fault.ts"
import { type Pair } from "#test/support/power-pairs.ts"
import {
	baseParams,
	lowerWith,
	spelledExpr,
	type TestField,
	testPg,
	v
} from "#test/support/unit/compute/support.ts"

/** What a case reached: a power the proof admits, evaluated, and one next to exp(6000) among them. */
export type WorkFeature = "an admitted power evaluated" | "a power next to exp(6000) evaluated"

/**
 * The field a literal base is typed by, as computeCore.literal types one: a numeric whose typmod holds its value exactly, or
 * numeric(1, 0) for NaN; none for an infinity or a value no declared field holds.
 */
const baseField = (base: Decimal): TestField | undefined => {
	if (base.isNaN()) {
		return testPg.numericOf(1, 0)
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

const expr = spelledExpr(
	computeCore.power(v("a", testPg.computedNumeric), v("b", testPg.computedNumeric)).expr
)

/** Whether the proof admits power(a, b) over a literal base, as the power suite compiles it. */
export const admitted = ([a, b]: Pair): boolean => {
	const base = Decimal.of(a)
	const field = baseField(base)
	return (
		field !== undefined &&
		lowerWith(
			"query",
			expr,
			{ a: { kind: "literal", field, value: base }, b: { kind: "bare", value: Decimal.of(b) } },
			false,
			baseParams
		).ok
	)
}
