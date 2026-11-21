import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { fragmentShapesItems } from "#test/types/schema/budget/records-fragment.ts"

/** Every shape of records a fragment holds, each a case of the records-fragment cost gate. */
export const recordsFragments = finite(word(dictionary(fragmentShapesItems)))
