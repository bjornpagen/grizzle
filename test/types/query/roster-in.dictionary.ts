import { dictionary } from "@bjornpagen/testing/dictionary"
import { rosterInBoxItems } from "#test/types/query/roster-in.ts"

/** Every case: each filter a rule restricts a roster term by, or a text term, and the field its head finds. */
export const rosterInBox = dictionary(rosterInBoxItems)
