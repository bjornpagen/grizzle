import { dictionary } from "@bjornpagen/testing/dictionary"
import { exactFieldsBoxItems } from "#test/types/schema/exact-fields.ts"

/** The box: every way a caller declares, writes, reads and compares an exact field. */
export const exactFieldsBox = dictionary(exactFieldsBoxItems)
