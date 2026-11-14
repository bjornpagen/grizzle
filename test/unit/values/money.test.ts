/**
 * Money's numeric conversions (scalar/values/money.ts): a money field's count of minor units, any signed 64-bit one,
 * read as numeric (toDecimal, cash_numeric) and back (fromDecimal, numeric_cash), is the count it was.
 *
 * - Round trip: Money.fromDecimal(Money.of(units).toDecimal()) holds `units`.
 *
 * Oracle: universal, fromDecimal ∘ toDecimal = id over every int8 count.
 *
 * Features: a negative count, a count of less than one whole unit (a fraction a cents-dropping conversion loses), and a
 * count at an int8 bound, each a named arm of the count's draw.
 *
 * Plants: values-money-scale (fromDecimal rounds at one fraction digit too few).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { bigint } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Effect, Formatter } from "effect"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { moneyFractionDigits } from "#compiler/ir/carriers.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

type Feature = "a negative count" | "less than one whole unit" | "an int8 bound"

/** The minor units of one whole unit: 10^moneyFractionDigits. */
const unit = 10n ** BigInt(moneyFractionDigits.value)

/** A money field's count: any int8, a count below one whole unit, or an int8 bound, each a named arm. */
const countGen: Gen<bigint> = weighted([
	[6, bigint(int8Min.value, int8Max.value)],
	[2, bigint(-(unit - 1n), unit - 1n)],
	[1, element([int8Min.value, int8Max.value])]
])

/** The situations a count is in. */
const featuresOf = (units: bigint): ReadonlyArray<Feature> => [
	...(units < 0n ? (["a negative count"] as const) : []),
	...(units > -unit && units < unit ? (["less than one whole unit"] as const) : []),
	...(units === int8Min.value || units === int8Max.value ? (["an int8 bound"] as const) : [])
]

describe("Money", () => {
	it.effect("round-trips its minor units through numeric", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "universal", name: "fromDecimal ∘ toDecimal = id over every int8 count" },
					suite: "unit/values/money-1",
					draw: drawn(countGen),
					literal: Formatter.format,
					coverage: required<Feature>(
						["a negative count", "less than one whole unit", "an int8 bound"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(units, c) =>
					Effect.sync(() => {
						c.noteAll(featuresOf(units))
						const money = Money.of(units)
						assert.equal(succeeded(Money.fromDecimal(money.toDecimal())).minorUnits, units)
					})
			)
		)
	)
})
