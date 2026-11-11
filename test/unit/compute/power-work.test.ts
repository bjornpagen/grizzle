/**
 * The work of every power the power suites draw, held to a measured limit: the oracle's port of numeric.c counts the
 * base-10000 digit operations it performs (test/support/oracle/evaluate/power.ts powerWork), the ones PostgreSQL's
 * power_var performs for the same power, and each power the proof admits, of the suites' edges, of the costliest power
 * the proof admits that they know, and of a batch of their generator (test/support/power-pairs.ts powerBatch), stays
 * within powerWorkLimit.
 *
 * The oracle: numeric.c's own truncations, mul_var's maxdigits and the series' working scales, bound the digits a
 * power's evaluation computes, and the limit is the costliest such power measured, with its margin; an evaluation that
 * computes past them, as an exact product would, passes it at the costliest power.
 *
 * Features: an admitted power evaluated, and a power next to exp(6000) evaluated.
 *
 * Plants: compute-power-work-untruncated (mul_var sums every digit-pair product, its maxdigits truncation dropped, so
 * the costliest power's evaluation counts past the limit).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { numericMaxPrecision, numericMaxScale } from "#compiler/ir/carriers.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { powerWork } from "#test/support/oracle/evaluate/power.ts"
import {
	costliest,
	edges,
	type Pair,
	powerBatch,
	powerWorkLimit
} from "#test/support/power-pairs.ts"
import {
	baseParams,
	lowerWith,
	spelledExpr,
	type TestField,
	testPg,
	v
} from "#test/unit/compute/support.ts"

/** What a case reached: a power the proof admits, evaluated, and one next to exp(6000) among them. */
type WorkFeature = "an admitted power evaluated" | "a power next to exp(6000) evaluated"

/**
 * The field a literal base is typed by, as Compute.literal types one: a numeric whose typmod holds its value exactly, or
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
	return precision > numericMaxPrecision.value || scale > numericMaxScale.value
		? undefined
		: testPg.numericOf(precision, scale)
}

const expr = spelledExpr(
	Compute.power(v("a", testPg.computedNumeric), v("b", testPg.computedNumeric)).expr
)

/** Whether the proof admits power(a, b) over a literal base, as the power suite compiles it. */
const admitted = ([a, b]: Pair): boolean => {
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

describe("numeric power's evaluation", () => {
	it.effect(
		"does no more digit work than numeric.c does, within the measured limit, for every power the suites draw",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/power-work",
						oracle: {
							kind: "specification",
							name: "numeric.c's truncations, which powerWorkLimit's measurement bounds"
						},
						draw: drawn(powerBatch),
						literal: Formatter.format,
						coverage: required<WorkFeature>(
							["an admitted power evaluated", "a power next to exp(6000) evaluated"],
							{ cases: 8, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(batch, c) =>
						Effect.gen(function* () {
							const pairs = [
								...Arr.map([costliest, ...edges, ...batch.ordinary], (pair) => ({
									pair,
									near: false
								})),
								...Arr.map(batch.near, (pair) => ({ pair, near: true }))
							]
							for (const { pair, near } of pairs) {
								yield* Effect.yieldNow
								if (!admitted(pair)) {
									continue
								}
								const [a, b] = pair
								const { work } = powerWork(Decimal.of(a), Decimal.of(b))
								assert.ok(
									work <= powerWorkLimit.value,
									`power(${a}, ${b}) does ${work} digit operations, past ${powerWorkLimit.value}`
								)
								c.note("an admitted power evaluated")
								if (near) {
									c.note("a power next to exp(6000) evaluated")
								}
							}
						})
				)
			)
	)
})
