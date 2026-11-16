import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { familyDimensionsItems, familyProbesItems } from "#test/types/schema/budget/families.ts"

/** The family-scale program's one dimension, its families: a roster of one, its every size a program of its own. */
export const familyDimensions = finite(word(dictionary(familyDimensionsItems)))

/**
 * The probes of the program at its largest size, each a cell of its box: each probed unit's additions, the whole
 * schema's insertable relations and rows, and the two refusals.
 */
export const familyProbes = finite(word(dictionary(familyProbesItems)))
