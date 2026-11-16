import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { statementProbesItems } from "#test/types/schema/budget/generate.ts"

/** The probes of the program at its largest size, each a cell of its box. */
export const statementProbes = finite(word(dictionary(statementProbesItems)))
