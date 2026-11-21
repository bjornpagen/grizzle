import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { keyedShapesItems } from "#test/types/query/budget/keys.ts"

/** Every shape of a keyed rule, each a case of the keyed rules' cost gate. */
export const keyedQueries = finite(word(dictionary(keyedShapesItems)))
