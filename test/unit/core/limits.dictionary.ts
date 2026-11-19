import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Record as Rec } from "effect"
import { integerRanges } from "#compiler/ir/carriers.ts"
import type { IntegerCarrier } from "#compiler/ir/scalar.ts"

/**
 * The integer carriers, smallint, integer and bigint, by the roster the carriers declare their ranges by (ir/carriers.ts
 * integerRanges). The carriers' own roster is the domain, never cases a person chose.
 */
export const integerCarriers = dictionary(
	nonEmpty<IntegerCarrier>(Rec.keys(integerRanges), "the integer carriers")
)
