import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { schemaDimensionsItems } from "#test/types/schema/budget/scaling.ts"

/** The schema-scale dimensions, each a growth gate's case: its name, its steps, and its program at a size. */
export const schemaDimensions = finite(word(dictionary(schemaDimensionsItems)))
