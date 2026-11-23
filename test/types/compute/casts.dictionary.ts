import { dictionary } from "@bjornpagen/testing/dictionary"
import { castsBoxItems } from "#test/types/compute/casts.ts"

/** The box: every cast between two SQL types of the numeric family, money and the exact carriers, and into its own. */
export const castsBox = dictionary(castsBoxItems)
