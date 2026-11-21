import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { servedShapesItems } from "#test/types/schema/budget/served-records.ts"

/** Every shape of a unit of served records, each a case of the served records' cost gate. */
export const servedRecords = finite(word(dictionary(servedShapesItems)))
