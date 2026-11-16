import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { roleDimensionsItems } from "#test/types/schema/budget/roles.ts"

/** The role's dimensions, each a case of its cost gate. */
export const roleDimensions = finite(word(dictionary(roleDimensionsItems)))
