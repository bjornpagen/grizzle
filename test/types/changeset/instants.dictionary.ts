import { dictionary } from "@bjornpagen/testing/dictionary"
import { instantsBoxItems } from "#test/types/changeset/instants.ts"

/** The box: every way a caller may write, state or compare an instant. */
export const instantsBox = dictionary(instantsBoxItems)
