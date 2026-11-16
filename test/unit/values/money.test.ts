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
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { countGen, type Feature, featuresOf } from "#test/unit/values/money.fixtures.ts"

/** Money round-trips its minor units through numeric. Its budget is its suite's before it was a property (test/unit/values/money.test.ts at 4ca3036a): 2000 runs and 200 steered cases. */
export const moneyRoundTripsItsMinorUnitsThroughNumeric = property.explore(countGen, {
	needs: {},
	budget: { runs: 2000, steered: 200 },
	situations: [
		"a negative count",
		"less than one whole unit",
		"an int8 bound"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, c: Case<Feature>) => (units) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(units))
			const money = Money.of(units)
			assert.equal(succeeded(Money.fromDecimal(money.toDecimal())).minorUnits, units)
		}),
	oracle: { kind: "universal", name: "fromDecimal ∘ toDecimal = id over every int8 count" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/values/money.ts",
			original: "\t\treturn Money.make(roundedUnits(amount, moneyFractionDigits))",
			replacement: "\t\treturn Money.make(roundedUnits(amount, moneyFractionDigits - 1))",
			why: "fromDecimal rounds at one fraction digit too few; the round trip fails."
		}
	]
})
