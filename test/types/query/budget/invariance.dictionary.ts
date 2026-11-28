import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { queryProbesItems } from "#test/support/types/query/budget/generate.ts"

/** The probes at the first and the last relation of the program at its largest size, each a cell of its box. */
export const queryProbes = finite(word(dictionary(queryProbesItems)))
