import { dictionary } from "@bjornpagen/testing/dictionary"
import { scopedEntriesBoxItems } from "#test/types/schema/scoped-entries.ts"

/** The box: every way a caller states scoped entries and runs the base's programs on a role holding them. */
export const scopedEntriesBox = dictionary(scopedEntriesBoxItems)
