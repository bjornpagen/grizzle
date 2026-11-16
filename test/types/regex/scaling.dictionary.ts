import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { regexDimensionsItems } from "#test/types/regex/scaling.ts"

/** The regex-scale program's one dimension, its patterns: a roster of one, its every size a program of its own. */
export const regexDimensions = finite(word(dictionary(regexDimensionsItems)))
