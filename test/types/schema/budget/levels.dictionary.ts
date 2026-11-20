import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { levelCornersItems } from "#test/types/schema/budget/levels.ts"

/** The corners of base size and derived count a level is measured at, each a cost gate's case. */
export const levelCorners = finite(word(dictionary(levelCornersItems)))
