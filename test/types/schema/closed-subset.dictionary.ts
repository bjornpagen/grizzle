import { dictionary } from "@bjornpagen/testing/dictionary"
import { closedSubsetBoxItems } from "#test/types/schema/closed-subset.ts"

/** Every case: each relation, a subset's or the whole roster's, at each handle of the roster. */
export const closedSubsetBox = dictionary(closedSubsetBoxItems)
