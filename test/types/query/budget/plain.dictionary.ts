import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { plainShapesItems } from "#test/types/query/budget/plain.ts"

/** Every shape of a query that attaches nothing, each a case of the plain queries' cost gate. */
export const plainQueries = finite(word(dictionary(plainShapesItems)))
