/** What the properties of money.test.ts read: its spaces, models and helpers. */

import { int8Max, int8Min } from "@bjornpagen/grizzle-engine/ir/carriers"
import { moneyFractionDigits } from "@bjornpagen/grizzle-engine/scalar/values/decimal"
import { element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"

export type Feature = "a negative count" | "less than one whole unit" | "an int8 bound"

/** The minor units of one whole unit: 10^moneyFractionDigits. */
const unit = 10n ** BigInt(moneyFractionDigits)

/** A money field's count: any int8, a count below one whole unit, or an int8 bound, each a named arm. */
export const countGen: Gen<bigint> = weighted([
	[6, bigint(int8Min, int8Max)],
	[2, bigint(-(unit - 1n), unit - 1n)],
	[1, element([int8Min, int8Max])]
])

/** The situations a count is in. */
export const featuresOf = (units: bigint): ReadonlyArray<Feature> => [
	...(units < 0n ? (["a negative count"] as const) : []),
	...(units > -unit && units < unit ? (["less than one whole unit"] as const) : []),
	...(units === int8Min || units === int8Max ? (["an int8 bound"] as const) : [])
]
