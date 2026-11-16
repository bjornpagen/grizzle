import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { schemaKeptBoxItems } from "#test/support/agreement/schemas.ts"

/** The kept faults the box states, each alone on one base: every selected-member fault no drawn probe plants. */
export const schemaKeptBox = finite(word(dictionary(schemaKeptBoxItems)))
