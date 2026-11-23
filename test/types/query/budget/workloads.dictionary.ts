import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { workloadWidthsItems } from "#test/types/query/budget/workloads.ts"

/** The workload-width dimension, a growth gate's case: its name, its steps, and its program at a size. */
export const workloadWidths = finite(word(dictionary(workloadWidthsItems)))
