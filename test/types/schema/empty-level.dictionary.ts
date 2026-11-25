import { dictionary } from "@bjornpagen/testing/dictionary"
import { emptyLevelBoxItems } from "#test/types/schema/empty-level.ts"

/** The box: a read over the empty level on roles that hold all, or nothing, of the base, and reads over held levels. */
export const emptyLevelBox = dictionary(emptyLevelBoxItems)
