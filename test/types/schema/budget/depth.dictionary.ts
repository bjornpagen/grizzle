import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { depthShapesItems } from "#test/types/schema/budget/depth.ts"

/** The chains a depth gate measures, each a cost gate's case: its shape, its depths and its measured quadratic. */
export const depthShapes = finite(word(dictionary(depthShapesItems)))
