import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { sourceKindsItems } from "#test/types/query/budget/sources.ts"

/** Every kind of source a rule matches, each a case of the matched sources' cost gate. */
export const matchedSources = finite(word(dictionary(sourceKindsItems)))
