import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { queryDimensionsItems } from "#test/types/query/budget/scaling.ts"

/** The query-scale dimensions, each a growth gate's case: its name, its steps, and its program at a size. */
export const queryDimensions = finite(word(dictionary(queryDimensionsItems)))
